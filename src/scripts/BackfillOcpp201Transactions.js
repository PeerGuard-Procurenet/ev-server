require('dotenv').config();

const { MongoClient } = require('mongodb');
const tzlookup = require('tz-lookup');

// Creates the platform transactions of OCPP 2.0.1 sessions that ended without being linked to a platform transaction
// (sessions started remotely before the remoteStartId fix). Records only: no pricing, billing or roaming CDR.
//
// Usage:
//   node src/scripts/BackfillOcpp201Transactions.js                 Dry run: shows what would be created
//   node src/scripts/BackfillOcpp201Transactions.js --execute       Creates the transactions
//   node src/scripts/BackfillOcpp201Transactions.js --rollback      Deletes the transactions created by this script
// Options:
//   --tag <ocpp201TransactionId>=<tagID>   Tag to use when it cannot be recovered from the logs (can be repeated)
// Environment:
//   MONGODB_URI (required), BACKFILL_TENANT_ID, BACKFILL_STATION_ID (optional: only this charging station)

const TENANT_ID = process.env.BACKFILL_TENANT_ID || '6a97123c5ddfdce571887e9e';
const STATION_ID = process.env.BACKFILL_STATION_ID?.trim() || null;
const MIGRATION_TAG = 'ocpp201-backfill';
const MAX_INT32 = 2147483648;

function parseArguments() {
  const args = process.argv.slice(2);
  const options = { execute: args.includes('--execute'), rollback: args.includes('--rollback'), tags: new Map() };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag') {
      const [transactionId, tagID] = (args[i + 1] || '').split('=');
      if (!transactionId || !tagID) {
        throw new Error('--tag expects <ocpp201TransactionId>=<tagID>');
      }
      options.tags.set(transactionId, tagID);
      i++;
    }
  }
  if (options.execute && options.rollback) {
    throw new Error('--execute and --rollback cannot be used together');
  }
  return options;
}

// The OCPP 2.0.1 client logs every RequestStartTransaction with its payload (remoteStartId and ID Token)
async function findTagOfRemoteStart(database, mapping) {
  if (mapping.remoteStartId === null || mapping.remoteStartId === undefined) {
    return null;
  }
  const logs = await database.collection(`${TENANT_ID}.logs`).find({
    chargingStationID: mapping.chargingStationID,
    module: 'Ocpp201ChargingStationClient',
    message: "<< 'RequestStartTransaction' sent",
  }).sort({ timestamp: -1 }).toArray();
  for (const log of logs) {
    for (const detailedMessage of log.detailedMessages || []) {
      let parsed;
      try {
        parsed = typeof detailedMessage === 'string' ? JSON.parse(detailedMessage) : detailedMessage;
      } catch (error) {
        continue;
      }
      const payload = parsed?.payload;
      if (payload?.remoteStartId === mapping.remoteStartId && payload?.idToken?.idToken) {
        return payload.idToken.idToken;
      }
    }
  }
  return null;
}

async function findAvailableTransactionID(transactions) {
  for (;;) {
    const id = Math.floor(Math.random() * MAX_INT32);
    if (id > 0 && !(await transactions.findOne({ _id: id }, { projection: { _id: 1 } }))) {
      return id;
    }
  }
}

function buildTransaction(id, mapping, chargingStation, tag) {
  const start = new Date(mapping.startedAt);
  const end = new Date(mapping.endedAt || mapping.lastEventTimestamp);
  const totalDurationSecs = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  let timezone = null;
  if (chargingStation.coordinates?.length === 2) {
    timezone = tzlookup(chargingStation.coordinates[1], chargingStation.coordinates[0]);
  }
  // Same document as the platform stores for a completed transaction (see TransactionStorage.saveTransaction)
  return {
    _id: id,
    issuer: true,
    companyID: chargingStation.companyID || null,
    siteID: chargingStation.siteID || null,
    siteAreaID: chargingStation.siteAreaID || null,
    connectorId: mapping.evseId,
    tagID: tag._id,
    carID: null,
    carCatalogID: null,
    carStateOfCharge: null,
    carOdometer: 0,
    departureTime: null,
    targetStateOfCharge: null,
    userID: tag.userID,
    chargeBoxID: mapping.chargingStationID,
    meterStart: mapping.meterStartWh,
    timestamp: start,
    price: 0,
    roundedPrice: 0,
    stateOfCharge: 0,
    timezone,
    signedData: '',
    migrationTag: MIGRATION_TAG,
    stop: {
      userID: tag.userID,
      timestamp: end,
      tagID: tag._id,
      meterStop: mapping.lastMeterWh,
      reason: 'Other',
      stateOfCharge: 0,
      signedData: '',
      totalConsumptionWh: mapping.lastMeterWh - mapping.meterStartWh,
      totalInactivitySecs: 0,
      extraInactivitySecs: 0,
      extraInactivityComputed: true,
      inactivityStatus: 'I',
      totalDurationSecs,
      price: 0,
      roundedPrice: 0,
    },
  };
}

async function rollback(database) {
  const transactions = database.collection(`${TENANT_ID}.transactions`);
  const backfilled = await transactions.find({ migrationTag: MIGRATION_TAG }, { projection: { _id: 1 } }).toArray();
  const ids = backfilled.map((transaction) => transaction._id);
  console.log(`Deleting ${ids.length} backfilled transaction(s): ${ids.join(', ') || '-'}`);
  if (ids.length === 0) {
    return;
  }
  await database.collection(`${TENANT_ID}.ocpp201transactions`).updateMany(
    { platformTransactionID: { $in: ids }, backfilledOn: { $exists: true } },
    { $unset: { platformTransactionID: '', idToken: '', idTokenType: '', authorizationStatus: '', backfilledOn: '' } });
  await transactions.deleteMany({ _id: { $in: ids }, migrationTag: MIGRATION_TAG });
  console.log('Rollback done');
}

async function backfill() {
  const options = parseArguments();
  const mongoDBURI = process.env.MONGODB_URI?.trim();
  if (!mongoDBURI) {
    throw new Error('MONGODB_URI environment variable is required');
  }
  const client = new MongoClient(mongoDBURI);
  try {
    await client.connect();
    const database = client.db();
    if (options.rollback) {
      await rollback(database);
      return;
    }
    const mappingsCollection = database.collection(`${TENANT_ID}.ocpp201transactions`);
    const transactions = database.collection(`${TENANT_ID}.transactions`);
    const filter = {
      ended: true,
      $or: [{ platformTransactionID: null }, { platformTransactionID: { $exists: false } }],
    };
    if (STATION_ID) {
      filter.chargingStationID = STATION_ID;
    }
    const mappings = await mappingsCollection.find(filter).sort({ createdOn: 1 }).toArray();
    console.log(`${options.execute ? 'EXECUTE' : 'DRY RUN'} - tenant '${TENANT_ID}' - ${mappings.length} ended OCPP 2.0.1 session(s) without platform transaction`);
    let created = 0;
    let skipped = 0;
    for (const mapping of mappings) {
      const label = `Session '${mapping.transactionId}' of '${mapping.chargingStationID}' (EVSE ${mapping.evseId})`;
      const skip = (reason) => {
        skipped++;
        console.log(`SKIPPED  ${label}: ${reason}`);
      };
      if (!Number.isInteger(mapping.evseId) || mapping.evseId <= 0) {
        skip('EVSE is unknown');
        continue;
      }
      if (!Number.isFinite(mapping.meterStartWh) || !Number.isFinite(mapping.lastMeterWh) || mapping.lastMeterWh < mapping.meterStartWh) {
        skip(`invalid meter values (start ${mapping.meterStartWh}, end ${mapping.lastMeterWh})`);
        continue;
      }
      if (!mapping.startedAt || !(mapping.endedAt || mapping.lastEventTimestamp)) {
        skip('start or end date is unknown');
        continue;
      }
      // Tags refused by the platform are not backfilled (unless explicitly provided)
      if (mapping.authorizationStatus && mapping.authorizationStatus !== 'Accepted' && !options.tags.has(mapping.transactionId)) {
        skip(`tag '${mapping.idToken}' was refused with status '${mapping.authorizationStatus}' (use --tag to force a tag)`);
        continue;
      }
      const tagID = options.tags.get(mapping.transactionId) || mapping.idToken || await findTagOfRemoteStart(database, mapping);
      if (!tagID) {
        skip(`tag cannot be recovered from the logs (remoteStartId '${mapping.remoteStartId}'), use --tag ${mapping.transactionId}=<tagID>`);
        continue;
      }
      const tag = await database.collection(`${TENANT_ID}.tags`).findOne({ _id: tagID });
      if (!tag?.userID) {
        skip(`tag '${tagID}' does not exist or is not assigned to a user`);
        continue;
      }
      const chargingStation = await database.collection(`${TENANT_ID}.chargingstations`).findOne({ _id: mapping.chargingStationID });
      if (!chargingStation) {
        skip('charging station does not exist');
        continue;
      }
      const id = await findAvailableTransactionID(transactions);
      const transaction = buildTransaction(id, mapping, chargingStation, tag);
      console.log(`${options.execute ? 'CREATED ' : 'TO CREATE'} ${label}: transaction ID ${id}, tag '${tagID}' (user ${String(tag.userID)}), ` +
        `${transaction.timestamp.toISOString()} -> ${transaction.stop.timestamp.toISOString()}, ` +
        `${(transaction.stop.totalConsumptionWh / 1000).toFixed(3)} kWh`);
      if (options.execute) {
        await transactions.insertOne(transaction);
        await mappingsCollection.updateOne({ _id: mapping._id }, {
          $set: { platformTransactionID: id, idToken: tagID, idTokenType: mapping.idTokenType || 'Central', authorizationStatus: 'Accepted', backfilledOn: new Date() }
        });
      }
      created++;
    }
    console.log(`${created} transaction(s) ${options.execute ? 'created' : 'to create'}, ${skipped} skipped`);
    if (!options.execute && created > 0) {
      console.log('Run again with --execute to create them');
    }
  } finally {
    await client.close();
  }
}

backfill().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
