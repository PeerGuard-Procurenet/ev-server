require('dotenv').config();

const { MongoClient, ObjectId } = require('mongodb');

const STATION_ID = process.env.RECONCILE_STATION_ID || '20241012000005';
const TENANT_ID = process.env.RECONCILE_TENANT_ID || '6a97123c5ddfdce571887e9e';
const TOKEN_ID = process.env.RECONCILE_TOKEN_ID || '6a97123c5ddfdce571887e9f';
const FACTORY_IDENTITY = {
  chargePointVendor: 'SimpleCharge',
  chargePointModel: 'MultiSocketCharger',
  chargePointSerialNumber: '24090182',
  firmwareVersion: '1.26.0828.1'
};
const SIMULATOR_CUTOFF = new Date('2026-09-07T00:00:00.000Z');

async function reconcile() {
  if (process.argv[2] !== '--execute') {
    throw new Error('Refusing to modify the database without the --execute argument');
  }
  const mongoDBURI = process.env.MONGODB_URI?.trim();
  if (!mongoDBURI) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  const client = new MongoClient(mongoDBURI);
  try {
    await client.connect();
    const database = client.db();
    const tenant = await database.collection('default.tenants').findOne({ _id: new ObjectId(TENANT_ID) });
    const token = await database.collection(`${TENANT_ID}.registrationtokens`).findOne({
      _id: new ObjectId(TOKEN_ID),
      expirationDate: { $gt: new Date() },
      $or: [{ revocationDate: null }, { revocationDate: { $exists: false } }]
    });
    if (!tenant) {
      throw new Error(`Tenant '${TENANT_ID}' does not exist`);
    }
    if (!token) {
      throw new Error(`Registration token '${TOKEN_ID}' is missing, expired, or revoked`);
    }

    const chargingStations = database.collection(`${TENANT_ID}.chargingstations`);
    const existingStation = await chargingStations.findOne({ _id: STATION_ID });
    if (!existingStation) {
      throw new Error(`Charging station '${STATION_ID}' does not exist; no reconciliation was performed`);
    }
    const isExpectedSimulator = existingStation.chargePointVendor === 'OcppWeb' &&
      existingStation.chargePointModel === 'Simulator' &&
      (!existingStation.chargePointSerialNumber || existingStation.chargePointSerialNumber === '');
    if (!isExpectedSimulator) {
      throw new Error('The charging-station record is no longer the expected stale simulator record; no changes were made');
    }
    if (existingStation.tokenID !== TOKEN_ID) {
      throw new Error('The charging station is bound to an unexpected registration token; no changes were made');
    }

    const stationUpdate = await chargingStations.updateOne(
      {
        _id: STATION_ID,
        chargePointVendor: 'OcppWeb',
        chargePointModel: 'Simulator',
        tokenID: TOKEN_ID
      },
      {
        $set: {
          ...FACTORY_IDENTITY,
          chargeBoxSerialNumber: null,
          connectors: [],
          backupConnectors: [],
          deleted: false,
          lastChangedOn: new Date()
        },
        $unset: {
          templateHash: '',
          templateHashTechnical: '',
          templateHashCapabilities: '',
          templateHashOcppStandard: '',
          templateHashOcppVendor: '',
          firmwareUpdateStatus: ''
        }
      }
    );
    if (stationUpdate.modifiedCount !== 1) {
      throw new Error('The guarded charging-station update did not modify exactly one record');
    }

    const simulatorBootNotifications = await database.collection(`${TENANT_ID}.bootnotifications`).deleteMany({
      chargeBoxID: STATION_ID,
      chargePointVendor: 'OcppWeb',
      chargePointModel: 'Simulator'
    });
    const simulatorHeartbeats = await database.collection(`${TENANT_ID}.heartbeats`).deleteMany({
      chargeBoxID: STATION_ID,
      timestamp: { $lt: SIMULATOR_CUTOFF }
    });
    const simulatorStatuses = await database.collection(`${TENANT_ID}.statusnotifications`).deleteMany({
      chargeBoxID: STATION_ID,
      timestamp: { $lt: SIMULATOR_CUTOFF }
    });
    const simulatorConfiguration = await database.collection(`${TENANT_ID}.configurations`).deleteOne({
      _id: STATION_ID,
      timestamp: { $lt: SIMULATOR_CUTOFF }
    });

    const verifiedStation = await chargingStations.findOne({ _id: STATION_ID });
    const remainingHeartbeats = await database.collection(`${TENANT_ID}.heartbeats`).countDocuments({ chargeBoxID: STATION_ID });
    const remainingBootNotifications = await database.collection(`${TENANT_ID}.bootnotifications`).countDocuments({ chargeBoxID: STATION_ID });
    console.log(JSON.stringify({
      tenantPreserved: tenant._id.toString() === TENANT_ID,
      registrationTokenPreserved: token._id.toString() === TOKEN_ID,
      station: {
        id: verifiedStation._id,
        tokenID: verifiedStation.tokenID,
        chargePointVendor: verifiedStation.chargePointVendor,
        chargePointModel: verifiedStation.chargePointModel,
        chargePointSerialNumber: verifiedStation.chargePointSerialNumber,
        firmwareVersion: verifiedStation.firmwareVersion
      },
      removedSimulatorRecords: {
        bootNotifications: simulatorBootNotifications.deletedCount,
        heartbeats: simulatorHeartbeats.deletedCount,
        statusNotifications: simulatorStatuses.deletedCount,
        configurations: simulatorConfiguration.deletedCount
      },
      preservedRecords: {
        heartbeats: remainingHeartbeats,
        bootNotifications: remainingBootNotifications,
        logs: 'all preserved'
      }
    }, null, 2));
  } finally {
    await client.close();
  }
}

reconcile().catch((error) => {
  console.error(`Unable to reconcile charging-station data: ${error.message}`);
  process.exitCode = 1;
});
