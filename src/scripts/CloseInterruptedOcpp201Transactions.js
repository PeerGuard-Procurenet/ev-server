require('dotenv').config();

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// Ends the OCPP 2.0.1 transactions that the Charging Stations will never end (e.g. interrupted by a power outage: the Charging Station
// starts a new transaction instead of ending the interrupted one), and stops their platform transaction.
// Same rules as Ocpp201ChargingStationService.endInterruptedTransaction:
//   - Replaced: a more recent transaction has been started on the same EVSE. The platform transaction is stopped with the start reading
//     of the next transaction (same meter, read later) when it is higher than the last reading, otherwise with the last reading
//   - Stale: most recent transaction of the EVSE without any message for --stale-hours. Stopped with its last reading
// Records only: the energy after the last consumption is not priced, and no billing or roaming CDR is sent.
//
// Usage:
//   node src/scripts/CloseInterruptedOcpp201Transactions.js                 Dry run: shows what would be done
//   node src/scripts/CloseInterruptedOcpp201Transactions.js --execute       Ends the transactions
//   node src/scripts/CloseInterruptedOcpp201Transactions.js --rollback      Restores the data changed by this script
// Options:
//   --stale-hours <hours>   Age of the last message of a stale transaction (default 24)
// Environment:
//   MONGODB_URI (required), CLEANUP_TENANT_ID, CLEANUP_STATION_ID (optional: only this charging station)

const TENANT_ID = process.env.CLEANUP_TENANT_ID || '6a97123c5ddfdce571887e9e';
const STATION_ID = process.env.CLEANUP_STATION_ID?.trim() || null;
const MIGRATION_TAG = 'ocpp201-interrupted-cleanup';
const BACKUP_COLLECTION = 'ocpp201interruptedcleanup';
const DEFAULT_STALE_HOURS = 24;

// Removed from a stopped transaction (see TransactionStorage.saveTransaction)
const TRANSACTION_RUNTIME_PROPERTIES = [
  'currentInstantWatts', 'currentInstantWattsL1', 'currentInstantWattsL2', 'currentInstantWattsL3', 'currentInstantWattsDC',
  'currentCumulatedPrice', 'currentCumulatedRoundedPrice', 'currentSignedData', 'currentStateOfCharge', 'currentTotalConsumptionWh',
  'currentTotalInactivitySecs', 'currentInactivityStatus', 'lastConsumption', 'numberOfMeterValues', 'currentTotalDurationSecs',
  'currentInstantVolts', 'currentInstantVoltsL1', 'currentInstantVoltsL2', 'currentInstantVoltsL3', 'currentInstantVoltsDC',
  'currentInstantAmps', 'transactionEndReceived', 'currentInstantAmpsL1', 'currentInstantAmpsL2', 'currentInstantAmpsL3', 'currentInstantAmpsDC',
];
// Connector statuses that only make sense during a transaction
const TRANSACTION_CONNECTOR_STATUSES = ['Charging', 'SuspendedEV', 'SuspendedEVSE'];

function parseArguments() {
  const args = process.argv.slice(2);
  const options = { execute: args.includes('--execute'), rollback: args.includes('--rollback'), staleHours: DEFAULT_STALE_HOURS };
  const staleHoursIndex = args.indexOf('--stale-hours');
  if (staleHoursIndex >= 0) {
    options.staleHours = Number(args[staleHoursIndex + 1]);
    if (!Number.isFinite(options.staleHours) || options.staleHours <= 0) {
      throw new Error('--stale-hours expects a positive number of hours');
    }
  }
  if (options.execute && options.rollback) {
    throw new Error('--execute and --rollback cannot be used together');
  }
  return options;
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const toDate = (value) => (value ? new Date(value) : null);
const startOf = (mapping) => toDate(mapping.startedAt) || toDate(mapping.createdOn);
const lastMessageOf = (mapping) => toDate(mapping.lastEventTimestamp) || toDate(mapping.lastChangedOn) || startOf(mapping);
const maxDate = (...dates) => dates.filter(Boolean).reduce((max, date) => (date.getTime() > max.getTime() ? date : max));

// Decide how each ongoing mapping is ended: the mappings of an EVSE are ordered by start date
function planMappings(mappings, staleHours) {
  const byEvse = new Map();
  for (const mapping of mappings) {
    const key = `${mapping.chargingStationID}~${mapping.evseId}`;
    if (!byEvse.has(key)) {
      byEvse.set(key, []);
    }
    byEvse.get(key).push(mapping);
  }
  const staleLimit = Date.now() - staleHours * 3600 * 1000;
  const plans = [];
  for (const evseMappings of byEvse.values()) {
    evseMappings.sort((mapping1, mapping2) => startOf(mapping1).getTime() - startOf(mapping2).getTime());
    for (const mapping of evseMappings) {
      if (mapping.ended) {
        continue;
      }
      if (!Number.isInteger(mapping.evseId) || mapping.evseId <= 0) {
        plans.push({ mapping, skipReason: 'EVSE is unknown' });
        continue;
      }
      const next = evseMappings.find((other) => startOf(other).getTime() > startOf(mapping).getTime());
      if (next) {
        plans.push({
          mapping, reason: 'Replaced', replacedBy: next.transactionId,
          nextReading: isNumber(next.meterStartWh) ? { valueWh: next.meterStartWh, timestamp: startOf(next) } : null,
        });
      } else if (lastMessageOf(mapping).getTime() < staleLimit) {
        plans.push({ mapping, reason: 'Stale' });
      } else {
        plans.push({ mapping, skipReason: `may still be ongoing (last message ${lastMessageOf(mapping).toISOString()})` });
      }
    }
  }
  return plans;
}

// Last known reading, or the next transaction start reading when consistent: never an estimated value
function computeStop(mapping, transaction, nextReading) {
  const lastConsumptionValue = transaction.lastConsumption?.value ?? transaction.meterStart;
  let meterStop = mapping.lastMeterWh ?? lastConsumptionValue ?? mapping.meterStartWh;
  // Never lower than what the platform already accounted
  if (isNumber(lastConsumptionValue) && meterStop < lastConsumptionValue) {
    meterStop = lastConsumptionValue;
  }
  let timestamp = maxDate(toDate(mapping.lastEventTimestamp), toDate(transaction.lastConsumption?.timestamp), toDate(transaction.timestamp));
  let source = 'last reading';
  // Only when energy has been delivered since the last reading (otherwise the last reading gives the right end)
  if (nextReading && nextReading.valueWh > meterStop && nextReading.timestamp.getTime() > timestamp.getTime()) {
    meterStop = nextReading.valueWh;
    timestamp = nextReading.timestamp;
    source = 'start reading of the next transaction';
  }
  return { meterStop, timestamp, source, lastConsumptionValue };
}

// Same document as the platform stores when it stops a transaction (see OCPPUtils.updateTransactionWithStopTransaction)
function buildStop(transaction, meterStop, timestamp, reason) {
  return {
    userID: transaction.userID ?? null,
    timestamp,
    tagID: transaction.tagID,
    meterStop,
    reason,
    stateOfCharge: transaction.currentStateOfCharge ?? 0,
    signedData: transaction.currentSignedData ?? '',
    totalConsumptionWh: meterStop - transaction.meterStart,
    totalInactivitySecs: transaction.currentTotalInactivitySecs ?? 0,
    extraInactivitySecs: 0,
    extraInactivityComputed: true,
    inactivityStatus: transaction.currentInactivityStatus ?? 'I',
    totalDurationSecs: Math.max(0, Math.floor((timestamp.getTime() - new Date(transaction.timestamp).getTime()) / 1000)),
    price: transaction.currentCumulatedPrice ?? 0,
    roundedPrice: transaction.currentCumulatedRoundedPrice ?? 0,
    priceUnit: transaction.priceUnit,
    pricingSource: transaction.pricingSource,
  };
}

// Consumption from the last consumption to the stop (see ConsumptionStorage.buildConsumptionMDB)
function buildLastConsumption(transaction, stop, lastConsumptionValue) {
  const startedAt = toDate(transaction.lastConsumption?.timestamp) || toDate(transaction.timestamp);
  const consumptionWh = stop.meterStop - lastConsumptionValue;
  if (stop.timestamp.getTime() <= startedAt.getTime()) {
    return null;
  }
  const durationSecs = (stop.timestamp.getTime() - startedAt.getTime()) / 1000;
  return {
    _id: crypto.createHash('sha256').update(`${transaction._id}~${stop.timestamp.toISOString()}`).digest('hex'),
    transactionId: transaction._id,
    chargeBoxID: transaction.chargeBoxID,
    connectorId: transaction.connectorId,
    siteAreaID: transaction.siteAreaID ?? null,
    siteID: transaction.siteID ?? null,
    assetID: null,
    userID: transaction.userID ?? null,
    startedAt,
    endedAt: stop.timestamp,
    consumptionWh,
    cumulatedConsumptionWh: stop.totalConsumptionWh,
    consumptionAmps: 0,
    cumulatedConsumptionAmps: 0,
    amount: 0,
    roundedAmount: 0,
    cumulatedAmount: stop.price,
    // Average power over the period
    instantWatts: Math.round(consumptionWh * 3600 / durationSecs),
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
    totalDurationSecs: stop.totalDurationSecs,
    inactivitySecs: 0,
    totalInactivitySecs: stop.totalInactivitySecs,
    stateOfCharge: stop.stateOfCharge || null,
    limitAmps: 0,
    limitWatts: 0,
    smartChargingActive: false,
    limitSiteAreaWatts: null,
    limitSiteAreaAmps: null,
    limitSiteAreaSource: null,
  };
}

// Same as OCPPUtils.clearChargingStationConnectorRuntimeData
function clearConnector(connector) {
  const cleared = {
    ...connector,
    currentInstantWatts: 0,
    currentTotalConsumptionWh: 0,
    currentTotalInactivitySecs: 0,
    currentInactivityStatus: 'I',
    currentStateOfCharge: 0,
    currentTransactionID: 0,
    currentTransactionDate: null,
    currentTagID: null,
    currentUserID: null,
  };
  if (TRANSACTION_CONNECTOR_STATUSES.includes(connector.status)) {
    cleared.status = 'Available';
  }
  return cleared;
}

async function closeMapping(database, plan, options) {
  const { mapping } = plan;
  const label = `Session '${mapping.transactionId}' of '${mapping.chargingStationID}' (EVSE ${mapping.evseId}, started ${startOf(mapping).toISOString()})`;
  const backup = { _id: mapping._id, mapping, executedOn: new Date() };
  const endedByCsms = { reason: plan.reason, endedOn: new Date() };
  if (plan.replacedBy) {
    endedByCsms.replacedByTransactionId = plan.replacedBy;
  }
  let endedAt = lastMessageOf(mapping);
  let description = 'no platform transaction';
  let transactionUpdate = null;
  let consumption = null;
  let chargingStationUpdate = null;
  if (mapping.platformTransactionID) {
    const transactions = database.collection(`${TENANT_ID}.transactions`);
    const transaction = await transactions.findOne({ _id: mapping.platformTransactionID });
    if (!transaction) {
      description = `transaction ID ${mapping.platformTransactionID} does not exist`;
    } else if (transaction.stop) {
      description = `transaction ID ${mapping.platformTransactionID} is already stopped`;
    } else {
      const { meterStop, timestamp, source, lastConsumptionValue } = computeStop(mapping, transaction, plan.nextReading);
      const stop = buildStop(transaction, meterStop, timestamp, plan.reason === 'Replaced' ? 'PowerLoss' : 'Other');
      endedAt = timestamp;
      backup.transaction = transaction;
      transactionUpdate = {
        $set: { stop, migrationTag: MIGRATION_TAG },
        $unset: Object.fromEntries(TRANSACTION_RUNTIME_PROPERTIES.map((property) => [property, ''])),
      };
      consumption = buildLastConsumption(transaction, stop, lastConsumptionValue);
      if (consumption) {
        backup.consumptionID = consumption._id;
      }
      const chargingStation = await database.collection(`${TENANT_ID}.chargingstations`).findOne({ _id: mapping.chargingStationID });
      const connector = chargingStation?.connectors?.find((c) => c.currentTransactionID === transaction._id);
      if (connector) {
        backup.connector = connector;
        chargingStationUpdate = { connectorId: connector.connectorId, connector: clearConnector(connector) };
      }
      description = `transaction ID ${transaction._id} (tag '${transaction.tagID}') stopped at ${timestamp.toISOString()} with ${meterStop} Wh (${source}), ` +
        `${(stop.totalConsumptionWh / 1000).toFixed(3)} kWh (+${meterStop - lastConsumptionValue} Wh after the last consumption)` +
        `${connector ? `, connector ${connector.connectorId} '${connector.status}' freed` : ''}`;
    }
  }
  console.log(`${options.execute ? 'ENDED   ' : 'TO END  '} ${label}: ${plan.reason}${plan.replacedBy ? ` by '${plan.replacedBy}'` : ''}, ${description}`);
  if (!options.execute) {
    return;
  }
  // Keep the original data first (rollback)
  await database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`).replaceOne({ _id: backup._id }, backup, { upsert: true });
  if (transactionUpdate) {
    await database.collection(`${TENANT_ID}.transactions`).updateOne({ _id: mapping.platformTransactionID }, transactionUpdate);
  }
  if (consumption) {
    await database.collection(`${TENANT_ID}.consumptions`).replaceOne({ _id: consumption._id }, consumption, { upsert: true });
  }
  if (chargingStationUpdate) {
    await database.collection(`${TENANT_ID}.chargingstations`).updateOne(
      { '_id': mapping.chargingStationID, 'connectors.connectorId': chargingStationUpdate.connectorId },
      { $set: { 'connectors.$': chargingStationUpdate.connector } });
  }
  await database.collection(`${TENANT_ID}.ocpp201transactions`).updateOne({ _id: mapping._id },
    { $set: { ended: true, endedAt, endedByCsms, lastChangedOn: new Date() } });
}

async function rollback(database) {
  const backups = await database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`).find({}).sort({ executedOn: -1 }).toArray();
  console.log(`Restoring ${backups.length} session(s)`);
  for (const backup of backups) {
    await database.collection(`${TENANT_ID}.ocpp201transactions`).replaceOne({ _id: backup.mapping._id }, backup.mapping);
    if (backup.transaction) {
      await database.collection(`${TENANT_ID}.transactions`).replaceOne({ _id: backup.transaction._id }, backup.transaction);
    }
    if (backup.consumptionID) {
      await database.collection(`${TENANT_ID}.consumptions`).deleteOne({ _id: backup.consumptionID });
    }
    if (backup.connector) {
      await database.collection(`${TENANT_ID}.chargingstations`).updateOne(
        { '_id': backup.mapping.chargingStationID, 'connectors.connectorId': backup.connector.connectorId },
        { $set: { 'connectors.$': backup.connector } });
    }
    await database.collection(`${TENANT_ID}.${BACKUP_COLLECTION}`).deleteOne({ _id: backup._id });
    console.log(`RESTORED Session '${backup.mapping.transactionId}' of '${backup.mapping.chargingStationID}'`);
  }
  console.log('Rollback done');
}

async function cleanup() {
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
    const filter = STATION_ID ? { chargingStationID: STATION_ID } : {};
    // All the mappings are needed to find the transaction replacing an ongoing one
    const mappings = await database.collection(`${TENANT_ID}.ocpp201transactions`).find(filter).toArray();
    const plans = planMappings(mappings, options.staleHours);
    console.log(`${options.execute ? 'EXECUTE' : 'DRY RUN'} - tenant '${TENANT_ID}'${STATION_ID ? ` - station '${STATION_ID}'` : ''} - ` +
      `${plans.length} ongoing OCPP 2.0.1 session(s), stale after ${options.staleHours} hour(s)`);
    let ended = 0;
    let skipped = 0;
    for (const plan of plans) {
      if (plan.skipReason) {
        skipped++;
        console.log(`SKIPPED  Session '${plan.mapping.transactionId}' of '${plan.mapping.chargingStationID}' (EVSE ${plan.mapping.evseId}): ${plan.skipReason}`);
        continue;
      }
      await closeMapping(database, plan, options);
      ended++;
    }
    console.log(`${ended} session(s) ${options.execute ? 'ended' : 'to end'}, ${skipped} skipped`);
    // Platform transactions still ongoing that are not linked to an OCPP 2.0.1 session (not handled by this script)
    const linkedIDs = new Set(mappings.filter((mapping) => mapping.platformTransactionID).map((mapping) => mapping.platformTransactionID));
    const transactionFilter = { stop: { $exists: false } };
    if (STATION_ID) {
      transactionFilter.chargeBoxID = STATION_ID;
    }
    const unlinked = (await database.collection(`${TENANT_ID}.transactions`).find(transactionFilter, { projection: { chargeBoxID: 1, connectorId: 1, timestamp: 1 } })
      .toArray()).filter((transaction) => !linkedIDs.has(transaction._id));
    for (const transaction of unlinked) {
      console.log(`NOT HANDLED Ongoing transaction ID ${transaction._id} of '${transaction.chargeBoxID}' (connector ${transaction.connectorId}, ` +
        `started ${new Date(transaction.timestamp).toISOString()}) is not linked to an OCPP 2.0.1 session`);
    }
    if (!options.execute && ended > 0) {
      console.log('Run again with --execute to end them');
    }
  } finally {
    await client.close();
  }
}

cleanup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
