require('dotenv').config();

const { MongoClient } = require('mongodb');
const tzlookup = require('tz-lookup');

// Sets the timezone of the transactions created without one (charging stations without location), as the platform now does
// with Utils.getTimezone: timezone of the charging station location, or the default timezone of the network.
//
// Usage:
//   node src/scripts/BackfillTransactionTimezones.js                 Dry run: shows what would be updated
//   node src/scripts/BackfillTransactionTimezones.js --execute       Updates the transactions
//   node src/scripts/BackfillTransactionTimezones.js --rollback      Removes the timezones set by this script
// Environment:
//   MONGODB_URI (required), BACKFILL_TENANT_ID, BACKFILL_DEFAULT_TIMEZONE (default 'Africa/Lagos')

const TENANT_ID = process.env.BACKFILL_TENANT_ID || '6a97123c5ddfdce571887e9e';
const DEFAULT_TIMEZONE = process.env.BACKFILL_DEFAULT_TIMEZONE?.trim() || 'Africa/Lagos';
const BACKUP_COLLECTION = 'transactiontimezonebackfill';

function parseArguments() {
  const args = process.argv.slice(2);
  const options = { execute: args.includes('--execute'), rollback: args.includes('--rollback') };
  if (options.execute && options.rollback) {
    throw new Error('--execute and --rollback cannot be used together');
  }
  return options;
}

// Same as Utils.getTimezone
function getTimezone(coordinates) {
  if (Array.isArray(coordinates) && coordinates.length === 2 && (coordinates[0] !== 0 || coordinates[1] !== 0)) {
    return tzlookup(coordinates[1], coordinates[0]);
  }
  return DEFAULT_TIMEZONE;
}

async function rollback(database) {
  const backups = await database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`).find({}).toArray();
  console.log(`Restoring the timezone of ${backups.length} transaction(s)`);
  for (const backup of backups) {
    await database.collection(`${TENANT_ID}.transactions`).updateOne({ _id: backup._id }, { $set: { timezone: backup.previousTimezone ?? null } });
  }
  await database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`).deleteMany({ _id: { $in: backups.map((backup) => backup._id) } });
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
    const transactions = await database.collection(`${TENANT_ID}.transactions`)
      .find({ $or: [{ timezone: null }, { timezone: { $exists: false } }, { timezone: '' }] }, { projection: { chargeBoxID: 1, timezone: 1 } })
      .toArray();
    const chargingStations = await database.collection(`${TENANT_ID}.chargingstations`).find({}, { projection: { coordinates: 1 } }).toArray();
    const coordinatesByStation = new Map(chargingStations.map((chargingStation) => [chargingStation._id, chargingStation.coordinates]));
    const countByTimezone = new Map();
    for (const transaction of transactions) {
      const timezone = getTimezone(coordinatesByStation.get(transaction.chargeBoxID));
      countByTimezone.set(timezone, (countByTimezone.get(timezone) ?? 0) + 1);
      if (options.execute) {
        // Keep the original value first (rollback)
        await database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`).replaceOne({ _id: transaction._id },
          { _id: transaction._id, previousTimezone: transaction.timezone ?? null, executedOn: new Date() }, { upsert: true });
        await database.collection(`${TENANT_ID}.transactions`).updateOne({ _id: transaction._id }, { $set: { timezone } });
      }
    }
    console.log(`${options.execute ? 'EXECUTE' : 'DRY RUN'} - tenant '${TENANT_ID}' - ${transactions.length} transaction(s) without timezone`);
    for (const [timezone, count] of countByTimezone) {
      console.log(`${options.execute ? 'UPDATED ' : 'TO UPDATE'} ${count} transaction(s) with timezone '${timezone}'`);
    }
    if (!options.execute && transactions.length > 0) {
      console.log('Run again with --execute to update them');
    }
  } finally {
    await client.close();
  }
}

backfill().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
