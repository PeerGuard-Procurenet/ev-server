require('dotenv').config();

const { MongoClient } = require('mongodb');

// Copies the 'MeterValue have been saved' logs (they hold the normalized meter values: Voltage, Current, Power, Energy, SoC)
// into a collection without TTL, as the logs collection expires its documents after 14 days.
// The copy is the source used by BackfillDcMeterValues.js. Running it again only adds the logs not copied yet.
//
// Usage:
//   node src/scripts/BackupMeterValueLogs.js              Dry run: shows what would be copied
//   node src/scripts/BackupMeterValueLogs.js --execute    Copies the logs
// Environment:
//   MONGODB_URI (required), BACKUP_TENANT_ID (optional)

const TENANT_ID = process.env.BACKUP_TENANT_ID || '6a97123c5ddfdce571887e9e';
const BACKUP_COLLECTION = 'metervaluelogsbackup';
const METER_VALUE_LOGS_QUERY = {
  module: 'OCPPService',
  action: 'OcppMeterValues',
  message: /MeterValue have been saved$/,
};

async function backup() {
  const execute = process.argv.includes('--execute');
  const mongoDBURI = process.env.MONGODB_URI?.trim();
  if (!mongoDBURI) {
    throw new Error('MONGODB_URI environment variable is required');
  }
  const client = new MongoClient(mongoDBURI);
  try {
    await client.connect();
    const database = client.db();
    const logs = database.collection(`${TENANT_ID}.logs`);
    const backupCollection = database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`);
    const total = await logs.countDocuments(METER_VALUE_LOGS_QUERY);
    const range = await logs.aggregate([
      { $match: METER_VALUE_LOGS_QUERY },
      { $group: { _id: null, first: { $min: '$timestamp' }, last: { $max: '$timestamp' }, chargingStations: { $addToSet: '$chargingStationID' } } },
    ]).toArray();
    const alreadyCopied = await backupCollection.countDocuments({});
    console.log(JSON.stringify({
      mode: execute ? 'execute' : 'dry-run',
      meterValueLogs: total,
      first: range[0]?.first ?? null,
      last: range[0]?.last ?? null,
      chargingStations: range[0]?.chargingStations.length ?? 0,
      alreadyInBackup: alreadyCopied,
    }, null, 2));
    if (!execute) {
      console.log('Dry run: nothing has been copied, run again with --execute');
      return;
    }
    // Upsert by log ID: existing copies are kept untouched
    await logs.aggregate([
      { $match: METER_VALUE_LOGS_QUERY },
      { $merge: { into: { db: database.databaseName, coll: `${TENANT_ID}.${BACKUP_COLLECTION}` }, on: '_id', whenMatched: 'keepExisting', whenNotMatched: 'insert' } },
    ]).toArray();
    await backupCollection.createIndex({ chargingStationID: 1, timestamp: 1 });
    console.log(JSON.stringify({ inBackup: await backupCollection.countDocuments({}) }, null, 2));
  } finally {
    await client.close();
  }
}

backup().catch((error) => {
  console.error(`Unable to back up the meter value logs: ${error.message}`);
  process.exitCode = 1;
});
