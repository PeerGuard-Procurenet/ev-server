require('dotenv').config();

const { MongoClient } = require('mongodb');

// The charging stations had no current type (no template): the measured Voltage, Current and Power were dropped
// and the consumptions only got values estimated from the energy (Power) and an AC voltage of 230 V (Current).
// This script:
//   - Sets the DC current type on the connectors of the charging stations that have none
//   - Restores the measured DC Voltage, Current and Power in the consumptions, from the meter values logs copied by BackupMeterValueLogs.js
//     (the consumptions older than the logs are left as they are)
// The previous values are saved to allow a rollback.
//
// Usage:
//   node src/scripts/BackfillDcMeterValues.js                 Dry run: shows what would be updated
//   node src/scripts/BackfillDcMeterValues.js --execute       Updates the charging stations and the consumptions
//   node src/scripts/BackfillDcMeterValues.js --rollback      Restores the values saved by --execute
// Environment:
//   MONGODB_URI (required), BACKFILL_TENANT_ID, BACKFILL_VENDOR (optional)

const TENANT_ID = process.env.BACKFILL_TENANT_ID || '6a97123c5ddfdce571887e9e';
const VENDOR = process.env.BACKFILL_VENDOR || 'SimpleCharge';
const BACKUP_COLLECTION = 'metervaluelogsbackup';
const ROLLBACK_COLLECTION = 'dcmetervaluesbackfill';
const CONSUMPTION_FIELDS = ['instantVolts', 'instantAmps', 'instantWatts', 'instantVoltsDC', 'instantAmpsDC', 'instantWattsDC'];

function parseArguments() {
  const args = process.argv.slice(2);
  const options = { execute: args.includes('--execute'), rollback: args.includes('--rollback') };
  if (options.execute && options.rollback) {
    throw new Error('--execute and --rollback cannot be used together');
  }
  return options;
}

// Measured DC values per transaction and timestamp, as processed by the server ('Sample.Periodic' context)
function extractMeasuredValues(meterValueLogs, chargingStationIDs) {
  const measuredValues = new Map();
  for (const log of meterValueLogs) {
    let detailedMessages;
    try {
      detailedMessages = typeof log.detailedMessages === 'string' ? JSON.parse(log.detailedMessages) : log.detailedMessages;
    } catch {
      continue;
    }
    for (const detailedMessage of [].concat(detailedMessages ?? [])) {
      for (const value of detailedMessage?.normalizedMeterValues?.values ?? []) {
        if (!chargingStationIDs.has(value.chargeBoxID) || value.attribute?.context !== 'Sample.Periodic' || value.attribute?.phase) {
          continue;
        }
        const reading = Number(value.value);
        if (!Number.isFinite(reading)) {
          continue;
        }
        const key = `${value.transactionId}~${new Date(value.timestamp).getTime()}`;
        const measured = measuredValues.get(key) ?? { transactionId: value.transactionId, timestamp: new Date(value.timestamp) };
        switch (value.attribute.measurand) {
          case 'Voltage':
            measured.volts = reading;
            break;
          case 'Current.Import':
            measured.amps = reading;
            break;
          case 'Power.Active.Import':
            measured.watts = value.attribute.unit === 'kW' ? reading * 1000 : reading;
            break;
          default:
            continue;
        }
        measuredValues.set(key, measured);
      }
    }
  }
  return measuredValues;
}

// Same rules as OCPPUtils.assertConsistencyInConsumption() for DC connectors
function buildConsumptionUpdate(consumption, measured) {
  const voltsDC = measured.volts ?? 0;
  const ampsDC = measured.amps ?? 0;
  let wattsDC = measured.watts ?? 0;
  if (!wattsDC && ampsDC > 0 && voltsDC > 0) {
    wattsDC = ampsDC * voltsDC;
  }
  const update = { instantVoltsDC: voltsDC, instantAmpsDC: ampsDC, instantWattsDC: wattsDC };
  update.instantWatts = wattsDC > 0 ? wattsDC : (consumption.instantWatts ?? 0);
  update.instantVolts = voltsDC > 0 ? voltsDC : (consumption.instantVolts ?? 0);
  if (ampsDC > 0) {
    update.instantAmps = ampsDC;
  } else if (update.instantWatts > 0 && update.instantVolts > 0) {
    update.instantAmps = update.instantWatts / update.instantVolts;
  } else {
    update.instantAmps = consumption.instantAmps ?? 0;
  }
  return update;
}

async function rollback(database) {
  const rollbackCollection = database.collection(`${TENANT_ID}.${ROLLBACK_COLLECTION}`);
  const saved = await rollbackCollection.find({}).toArray();
  let consumptions = 0;
  let chargingStations = 0;
  for (const entry of saved) {
    if (entry.kind === 'consumption') {
      await database.collection(`${TENANT_ID}.consumptions`).updateOne({ _id: entry.consumptionID }, { $set: entry.previous });
      consumptions++;
    } else if (entry.kind === 'chargingStation') {
      for (const connectorId of entry.connectorIDs) {
        await database.collection(`${TENANT_ID}.chargingstations`).updateOne(
          { _id: entry.chargingStationID, 'connectors.connectorId': connectorId },
          { $set: { 'connectors.$.currentType': null } });
      }
      chargingStations++;
    }
    await rollbackCollection.deleteOne({ _id: entry._id });
  }
  console.log(JSON.stringify({ mode: 'rollback', restoredConsumptions: consumptions, restoredChargingStations: chargingStations }, null, 2));
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
    const rollbackCollection = database.collection(`${TENANT_ID}.${ROLLBACK_COLLECTION}`);
    if (options.execute && await rollbackCollection.countDocuments({}) > 0) {
      throw new Error(`'${ROLLBACK_COLLECTION}' is not empty: the backfill has already been executed, run --rollback first to execute it again`);
    }
    // Charging Stations
    const chargingStations = await database.collection(`${TENANT_ID}.chargingstations`)
      .find({ chargePointVendor: VENDOR }, { projection: { connectors: 1, chargePoints: 1 } }).toArray();
    const chargingStationIDs = new Set(chargingStations.map((chargingStation) => chargingStation._id));
    const chargingStationsToUpdate = chargingStations
      .map((chargingStation) => ({
        chargingStationID: chargingStation._id,
        connectorIDs: (chargingStation.connectors ?? [])
          .filter((connector) => !connector.currentType)
          .map((connector) => connector.connectorId),
      }))
      .filter((chargingStation) => chargingStation.connectorIDs.length > 0);
    // Consumptions
    const meterValueLogs = await database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`).find({}).toArray();
    const measuredValues = extractMeasuredValues(meterValueLogs, chargingStationIDs);
    const transactionIDs = [...new Set([...measuredValues.values()].map((measured) => measured.transactionId))];
    const consumptions = await database.collection(`${TENANT_ID}.consumptions`)
      .find({ transactionId: { $in: transactionIDs } }).toArray();
    const consumptionsByKey = new Map(consumptions.map((consumption) => [`${consumption.transactionId}~${new Date(consumption.endedAt).getTime()}`, consumption]));
    const consumptionUpdates = [];
    let unmatchedReadings = 0;
    for (const [key, measured] of measuredValues) {
      const consumption = consumptionsByKey.get(key);
      if (!consumption) {
        unmatchedReadings++;
        continue;
      }
      consumptionUpdates.push({ consumption, update: buildConsumptionUpdate(consumption, measured) });
    }
    const samples = consumptionUpdates.filter(({ update }) => update.instantWattsDC > 0).slice(0, 3).map(({ consumption, update }) => ({
      consumptionID: consumption._id,
      transactionId: consumption.transactionId,
      endedAt: consumption.endedAt,
      before: Object.fromEntries(CONSUMPTION_FIELDS.map((field) => [field, consumption[field] ?? null])),
      after: update,
    }));
    console.log(JSON.stringify({
      mode: options.execute ? 'execute' : 'dry-run',
      vendor: VENDOR,
      chargingStations: chargingStations.length,
      chargingStationsToSetDC: chargingStationsToUpdate.length,
      connectorsToSetDC: chargingStationsToUpdate.reduce((count, chargingStation) => count + chargingStation.connectorIDs.length, 0),
      meterValueLogs: meterValueLogs.length,
      measuredSamples: measuredValues.size,
      transactions: transactionIDs.length,
      consumptionsToUpdate: consumptionUpdates.length,
      consumptionsWithMeasuredPower: consumptionUpdates.filter(({ update }) => update.instantWattsDC > 0).length,
      unmatchedReadings,
      samples,
    }, null, 2));
    if (!options.execute) {
      console.log('Dry run: nothing has been updated, run again with --execute');
      return;
    }
    // Save the previous values first
    for (const chargingStation of chargingStationsToUpdate) {
      await rollbackCollection.insertOne({ _id: `chargingStation~${chargingStation.chargingStationID}`, kind: 'chargingStation', ...chargingStation });
    }
    for (const { consumption } of consumptionUpdates) {
      await rollbackCollection.insertOne({
        _id: `consumption~${consumption._id}`,
        kind: 'consumption',
        consumptionID: consumption._id,
        previous: Object.fromEntries(CONSUMPTION_FIELDS.map((field) => [field, consumption[field] ?? 0])),
      });
    }
    for (const chargingStation of chargingStationsToUpdate) {
      for (const connectorId of chargingStation.connectorIDs) {
        await database.collection(`${TENANT_ID}.chargingstations`).updateOne(
          { _id: chargingStation.chargingStationID, 'connectors.connectorId': connectorId },
          { $set: { 'connectors.$.currentType': 'DC' } });
      }
    }
    for (const { consumption, update } of consumptionUpdates) {
      await database.collection(`${TENANT_ID}.consumptions`).updateOne({ _id: consumption._id }, { $set: update });
    }
    console.log(JSON.stringify({ updatedChargingStations: chargingStationsToUpdate.length, updatedConsumptions: consumptionUpdates.length }, null, 2));
  } finally {
    await client.close();
  }
}

backfill().catch((error) => {
  console.error(`Unable to backfill the DC meter values: ${error.message}`);
  process.exitCode = 1;
});
