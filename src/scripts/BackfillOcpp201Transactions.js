require('dotenv').config();

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const tzlookup = require('tz-lookup');

// Creates the platform transactions (and their consumptions) of OCPP 2.0.1 sessions that ended without being linked to a platform transaction
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
    const tagID = findTagInDetailedMessages(log.detailedMessages, mapping.remoteStartId);
    if (tagID) {
      return tagID;
    }
  }
  return null;
}

// Detailed messages are stored as one JSON string (of an array of objects): search any structure
function findTagInDetailedMessages(detailedMessages, remoteStartId, depth = 0) {
  if (!detailedMessages || depth > 10) {
    return null;
  }
  if (typeof detailedMessages === 'string') {
    try {
      return findTagInDetailedMessages(JSON.parse(detailedMessages), remoteStartId, depth + 1);
    } catch (error) {
      return null;
    }
  }
  if (Array.isArray(detailedMessages)) {
    for (const item of detailedMessages) {
      const tagID = findTagInDetailedMessages(item, remoteStartId, depth + 1);
      if (tagID) {
        return tagID;
      }
    }
    return null;
  }
  if (typeof detailedMessages === 'object') {
    if (detailedMessages.remoteStartId === remoteStartId && detailedMessages.idToken?.idToken) {
      return detailedMessages.idToken.idToken;
    }
    for (const value of Object.values(detailedMessages)) {
      const tagID = findTagInDetailedMessages(value, remoteStartId, depth + 1);
      if (tagID) {
        return tagID;
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

// Only the start and end readings are known: a first consumption at the start (as the platform does)
// and one consumption covering the whole session (see ConsumptionStorage.buildConsumptionMDB)
function buildConsumptions(transaction) {
  const start = transaction.timestamp;
  const end = transaction.stop.timestamp;
  const totalWh = transaction.stop.totalConsumptionWh;
  const durationSecs = transaction.stop.totalDurationSecs;
  const consumptionID = (date) => crypto.createHash('sha256').update(`${transaction._id}~${date.toISOString()}`).digest('hex');
  const base = {
    transactionId: transaction._id,
    chargeBoxID: transaction.chargeBoxID,
    connectorId: transaction.connectorId,
    siteAreaID: transaction.siteAreaID,
    siteID: transaction.siteID,
    assetID: null,
    userID: transaction.userID,
    consumptionAmps: 0,
    cumulatedAmount: 0,
    cumulatedConsumptionAmps: 0,
    amount: 0,
    roundedAmount: 0,
    instantWattsL1: 0,
    instantWattsL2: 0,
    instantWattsL3: 0,
    instantWattsDC: 0,
    instantAmps: 0,
    instantAmpsL1: 0,
    instantAmpsL2: 0,
    instantAmpsL3: 0,
    instantAmpsDC: 0,
    instantVolts: 0,
    instantVoltsL1: 0,
    instantVoltsL2: 0,
    instantVoltsL3: 0,
    instantVoltsDC: 0,
    inactivitySecs: 0,
    totalInactivitySecs: 0,
    stateOfCharge: null,
    limitAmps: 0,
    limitWatts: 0,
    smartChargingActive: false,
    limitSiteAreaWatts: null,
    limitSiteAreaAmps: null,
    limitSiteAreaSource: null,
  };
  const consumptions = [{
    ...base,
    _id: consumptionID(start),
    startedAt: start,
    endedAt: start,
    consumptionWh: 0,
    cumulatedConsumptionWh: 0,
    instantWatts: 0,
    totalDurationSecs: 0,
  }];
  if (end.getTime() > start.getTime()) {
    consumptions.push({
      ...base,
      _id: consumptionID(end),
      startedAt: start,
      endedAt: end,
      consumptionWh: totalWh,
      cumulatedConsumptionWh: totalWh,
      // Average power over the session
      instantWatts: durationSecs > 0 ? Math.round(totalWh * 3600 / durationSecs) : 0,
      totalDurationSecs: durationSecs,
    });
  }
  return consumptions;
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
  await database.collection(`${TENANT_ID}.consumptions`).deleteMany({ transactionId: { $in: ids } });
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
      const consumptions = buildConsumptions(transaction);
      console.log(`${options.execute ? 'CREATED ' : 'TO CREATE'} ${label}: transaction ID ${id}, tag '${tagID}' (user ${String(tag.userID)}), ` +
        `${transaction.timestamp.toISOString()} -> ${transaction.stop.timestamp.toISOString()}, ` +
        `${(transaction.stop.totalConsumptionWh / 1000).toFixed(3)} kWh, ${consumptions.length} consumption(s)`);
      if (options.execute) {
        await transactions.insertOne(transaction);
        await database.collection(`${TENANT_ID}.consumptions`).insertMany(consumptions);
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
