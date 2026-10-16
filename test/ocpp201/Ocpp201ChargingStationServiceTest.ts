import { Ocpp201IncomingAction, Ocpp201Payload, Ocpp201TransactionMapping } from '../../src/server/ocpp201/types/Ocpp201Types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import OCPPService from '../../src/server/ocpp/services/OCPPService';
import OCPPUtils from '../../src/server/ocpp/utils/OCPPUtils';
import Ocpp201ChargingStationService from '../../src/server/ocpp201/services/Ocpp201ChargingStationService';
import Ocpp201Error from '../../src/server/ocpp201/Ocpp201Error';
import Ocpp201EvseStateManager from '../../src/server/ocpp201/mapping/Ocpp201EvseStateManager';
import Ocpp201TransactionStorage from '../../src/server/ocpp201/storage/Ocpp201TransactionStorage';
import TransactionStorage from '../../src/storage/mongodb/TransactionStorage';

jest.mock('../../src/utils/Logging', () => ({
  __esModule: true,
  default: {
    logDebug: jest.fn(async () => Promise.resolve('')),
    logInfo: jest.fn(async () => Promise.resolve('')),
    logWarning: jest.fn(async () => Promise.resolve('')),
    logError: jest.fn(async () => Promise.resolve('')),
    logConsoleDebug: jest.fn(),
    logConsoleError: jest.fn(),
  },
}));
jest.mock('../../src/utils/Configuration', () => ({
  __esModule: true,
  default: {
    getJsonEndpointConfig: () => ({ baseSecureUrl: 'wss://ev-server.test' }),
    getChargingStationConfig: () => ({ pingIntervalOCPPJSecs: 60 }),
  },
}));
jest.mock('../../src/server/ocpp/services/OCPPService', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/server/ocpp/utils/OCPPUtils', () => ({
  __esModule: true,
  default: { checkAndGetChargingStationConnectionData: jest.fn(), checkChargingStationConnectionData: jest.fn() },
}));
jest.mock('../../src/storage/mongodb/ChargingStationStorage', () => ({
  __esModule: true,
  default: { saveChargingStationRuntimeData: jest.fn(async () => Promise.resolve()) },
}));
jest.mock('../../src/storage/mongodb/TransactionStorage', () => ({
  __esModule: true,
  default: { getTransaction: jest.fn(), saveTransaction: jest.fn(async () => Promise.resolve()) },
}));
// In memory storage behaving like MongoDB (undefined properties are stored as null)
jest.mock('../../src/server/ocpp201/storage/Ocpp201TransactionStorage', () => {
  const store = new Map<string, Record<string, unknown>>();
  const remoteStarts = new Map<string, Record<string, unknown>>();
  const clone = (mapping: Record<string, unknown>) => {
    if (!mapping) {
      return null;
    }
    const cloned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mapping)) {
      cloned[key] = value instanceof Date ? new Date(value.getTime()) : (typeof value === 'undefined' ? null : value);
    }
    return cloned;
  };
  const buildMappingID = (chargingStationID: string, transactionId: string) => `${chargingStationID}~${transactionId}`;
  return {
    __esModule: true,
    default: {
      store,
      remoteStarts,
      buildMappingID,
      getRemoteStart: jest.fn(async (tenant: unknown, chargingStationID: string, remoteStartId: number) =>
        Promise.resolve(clone(remoteStarts.get(`${chargingStationID}~${remoteStartId}`)))),
      getMapping: jest.fn(async (tenant: unknown, chargingStationID: string, transactionId: string) =>
        Promise.resolve(clone(store.get(buildMappingID(chargingStationID, transactionId))))),
      getMappingByPlatformTransactionID: jest.fn(async (tenant: unknown, chargingStationID: string, platformTransactionID: number) =>
        Promise.resolve(clone(Array.from(store.values()).find((mapping) =>
          mapping.chargingStationID === chargingStationID && mapping.platformTransactionID === platformTransactionID)))),
      getOngoingMappingsOfChargingStation: jest.fn(async (tenant: unknown, chargingStationID: string) =>
        Promise.resolve(Array.from(store.values()).filter((mapping) => mapping.chargingStationID === chargingStationID && !mapping.ended).map(clone))),
      saveMapping: jest.fn(async (tenant: unknown, mapping: Record<string, unknown>) => {
        store.set(mapping.id as string, clone(mapping));
        return Promise.resolve();
      }),
    },
  };
});

const TENANT_ID = '5be7fb271014d90008992f06';
const tenant = { id: TENANT_ID, subdomain: 'test' };
const mappingStore = (Ocpp201TransactionStorage as unknown as { store: Map<string, Ocpp201TransactionMapping> }).store;
const remoteStartStore = (Ocpp201TransactionStorage as unknown as { remoteStarts: Map<string, Record<string, unknown>> }).remoteStarts;

type OCPPServiceMock = Record<string, jest.Mock<(...args: any[]) => Promise<any>>>;

function buildOCPPServiceMock(): OCPPServiceMock {
  return {
    handleBootNotification: jest.fn(async () => Promise.resolve({ status: 'Accepted', currentTime: '2024-10-12T10:00:00.000Z', interval: 60 })),
    handleHeartbeat: jest.fn(async () => Promise.resolve({ currentTime: '2024-10-12T10:00:00.000Z' })),
    handleStatusNotification: jest.fn(async () => Promise.resolve({})),
    handleAuthorize: jest.fn(async () => Promise.resolve({ idTagInfo: { status: 'Accepted' } })),
    handleStartTransaction: jest.fn(async () => Promise.resolve({ transactionId: 555, idTagInfo: { status: 'Accepted' } })),
    handleMeterValues: jest.fn(async () => Promise.resolve({})),
    handleStopTransaction: jest.fn(async () => Promise.resolve({ idTagInfo: { status: 'Accepted' } })),
    handleFirmwareStatusNotification: jest.fn(async () => Promise.resolve({})),
    handleDiagnosticsStatusNotification: jest.fn(async () => Promise.resolve({})),
    handleDataTransfer: jest.fn(async () => Promise.resolve({ status: 'Accepted' })),
  };
}

let stationCounter = 0;

describe('OCPP 2.0.1 Charging Station service (business adapter)', () => {
  let chargingStationID: string;
  let ocppService: OCPPServiceMock;
  let service: Ocpp201ChargingStationService;
  let chargingStation: Record<string, any>;

  const statusesSent = () => ocppService.handleStatusNotification.mock.calls.map((call) => call[1].status as string);
  const handle = async (action: Ocpp201IncomingAction, payload: Ocpp201Payload) => service.handleRequest(action, payload);
  const statusNotification = async (connectorStatus: string, evseId = 1, connectorId = 1) =>
    handle(Ocpp201IncomingAction.STATUS_NOTIFICATION, { timestamp: '2024-10-12T10:00:00Z', connectorStatus, evseId, connectorId });
  const energy = (value: number, context = 'Sample.Periodic', timestamp = '2024-10-12T10:05:00Z') => [{
    timestamp, sampledValue: [{ value, context, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } }],
  }];
  const transactionEvent = async (eventType: string, seqNo: number, extra: Ocpp201Payload = {}) => handle(Ocpp201IncomingAction.TRANSACTION_EVENT, {
    eventType, seqNo, timestamp: `2024-10-12T10:${String(10 + seqNo).padStart(2, '0')}:00Z`, triggerReason: 'Trigger',
    ...extra,
    transactionInfo: { transactionId: 'TX-1', ...(extra.transactionInfo ?? {}) },
  });
  const idToken = { idToken: 'TAG1', type: 'ISO14443' };

  beforeEach(() => {
    jest.clearAllMocks();
    stationCounter++;
    chargingStationID = `CS-${stationCounter}`;
    chargingStation = { id: chargingStationID, connectors: [{ connectorId: 1 }], siteArea: {} };
    (OCPPUtils.checkAndGetChargingStationConnectionData as jest.Mock<any>).mockImplementation(
      async () => Promise.resolve({ tenant, chargingStation, token: { id: 'token' } }));
    (TransactionStorage.getTransaction as jest.Mock<any>).mockImplementation(async () => Promise.resolve(null));
    ocppService = buildOCPPServiceMock();
    service = new Ocpp201ChargingStationService({ tenantID: TENANT_ID, tokenID: 'token', chargingStationID, clientIP: '10.0.0.1' },
      ocppService as unknown as OCPPService);
  });

  describe('Provisioning', () => {
    it('should register the Charging Station with the Boot Notification', async () => {
      const response = await handle(Ocpp201IncomingAction.BOOT_NOTIFICATION, {
        chargingStation: { vendorName: 'Factory', model: 'AC22', serialNumber: 'SN1', firmwareVersion: '1.0' }, reason: 'PowerUp'
      });
      expect(response).toEqual({ status: 'Accepted', currentTime: '2024-10-12T10:00:00.000Z', interval: 60 });
      const [headers, bootNotification] = ocppService.handleBootNotification.mock.calls[0];
      expect(headers).toMatchObject({ chargeBoxIdentity: chargingStationID, ocppVersion: '2.0.1', ocppProtocol: 'json', tenantID: TENANT_ID,
        tokenID: 'token', currentIPAddress: '10.0.0.1', chargingStationURL: 'wss://ev-server.test' });
      expect(bootNotification).toEqual({ chargePointVendor: 'Factory', chargePointModel: 'AC22', chargePointSerialNumber: 'SN1', firmwareVersion: '1.0' });
    });

    it('should reject the other messages while the registration is rejected', async () => {
      ocppService.handleBootNotification.mockResolvedValueOnce({ status: 'Rejected', currentTime: '2024-10-12T10:00:00.000Z', interval: 60 });
      await expect(handle(Ocpp201IncomingAction.BOOT_NOTIFICATION, { chargingStation: { vendorName: 'F', model: 'M' }, reason: 'PowerUp' }))
        .resolves.toMatchObject({ status: 'Rejected' });
      await expect(handle(Ocpp201IncomingAction.HEARTBEAT, {})).rejects.toMatchObject({ code: 'SecurityError' });
      await expect(handle(Ocpp201IncomingAction.BOOT_NOTIFICATION, { chargingStation: { vendorName: 'F', model: 'M' }, reason: 'PowerUp' }))
        .resolves.toMatchObject({ status: 'Accepted' });
      await expect(handle(Ocpp201IncomingAction.HEARTBEAT, {})).resolves.toEqual({ currentTime: '2024-10-12T10:00:00.000Z' });
    });

    it('should reject the messages of an unknown Charging Station with a SecurityError', async () => {
      (OCPPUtils.checkAndGetChargingStationConnectionData as jest.Mock<any>).mockRejectedValue(new Error('Charging Station does not exist!'));
      await expect(handle(Ocpp201IncomingAction.HEARTBEAT, {})).rejects.toBeInstanceOf(Ocpp201Error);
      await expect(handle(Ocpp201IncomingAction.HEARTBEAT, {})).rejects.toMatchObject({ code: 'SecurityError' });
    });

    it('should reject the informative messages of a Charging Station that is not registered yet', async () => {
      (OCPPUtils.checkAndGetChargingStationConnectionData as jest.Mock<any>).mockResolvedValue({ tenant, token: { id: 'token' } });
      await expect(handle(Ocpp201IncomingAction.NOTIFY_EVENT, {})).rejects.toMatchObject({ code: 'SecurityError' });
    });

    it('should answer the unsupported messages with a valid response', async () => {
      await expect(handle(Ocpp201IncomingAction.SIGN_CERTIFICATE, { csr: 'x' })).resolves.toEqual({ status: 'Rejected' });
      await expect(handle(Ocpp201IncomingAction.GET_15118_EV_CERTIFICATE, {})).resolves.toEqual({ status: 'Failed', exiResponse: '' });
      await expect(handle(Ocpp201IncomingAction.GET_CERTIFICATE_STATUS, {})).resolves.toEqual({ status: 'Failed' });
      await expect(handle(Ocpp201IncomingAction.NOTIFY_EVENT, {})).resolves.toEqual({});
      await expect(handle(Ocpp201IncomingAction.SECURITY_EVENT_NOTIFICATION, { type: 'StartupOfTheDevice' })).resolves.toEqual({});
    });
  });

  describe('Authorization, firmware, logs and data transfer', () => {
    it('should authorize with the platform tags', async () => {
      ocppService.handleAuthorize.mockResolvedValueOnce({ idTagInfo: { status: 'Blocked' } });
      await expect(handle(Ocpp201IncomingAction.AUTHORIZE, { idToken })).resolves.toEqual({ idTokenInfo: { status: 'Blocked' } });
      expect(ocppService.handleAuthorize.mock.calls[0][1]).toEqual({ idTag: 'TAG1' });
    });

    it('should refuse an ID Token that cannot be a platform tag', async () => {
      await expect(handle(Ocpp201IncomingAction.AUTHORIZE, { idToken: { idToken: '', type: 'NoAuthorization' } }))
        .resolves.toEqual({ idTokenInfo: { status: 'Invalid' } });
      expect(ocppService.handleAuthorize).not.toHaveBeenCalled();
    });

    it('should convert the firmware, log and data transfer messages', async () => {
      await handle(Ocpp201IncomingAction.FIRMWARE_STATUS_NOTIFICATION, { status: 'InstallScheduled', requestId: 1 });
      expect(ocppService.handleFirmwareStatusNotification.mock.calls[0][1]).toEqual({ status: 'Installing' });
      await handle(Ocpp201IncomingAction.LOG_STATUS_NOTIFICATION, { status: 'UploadFailure', requestId: 1 });
      expect(ocppService.handleDiagnosticsStatusNotification.mock.calls[0][1]).toEqual({ status: 'UploadFailed' });
      ocppService.handleDataTransfer.mockResolvedValueOnce({ status: 'UnknownVendorId' });
      await expect(handle(Ocpp201IncomingAction.DATA_TRANSFER, { vendorId: 'V', data: { a: 1 } })).resolves.toEqual({ status: 'UnknownVendorId' });
      expect(ocppService.handleDataTransfer.mock.calls[0][1]).toEqual({ vendorId: 'V', data: '{"a":1}' });
    });
  });

  describe('Transactions', () => {
    it('should run a complete transaction (EV unplugged after the end of the transaction)', async () => {
      await statusNotification('Available');
      await statusNotification('Occupied');
      const started = await transactionEvent('Started', 0, {
        idToken, evse: { id: 1, connectorId: 1 }, transactionInfo: { chargingState: 'EVConnected' },
        meterValue: energy(1000, 'Transaction.Begin', '2024-10-12T10:09:00Z'),
      });
      expect(started).toEqual({ idTokenInfo: { status: 'Accepted' } });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toEqual(
        { connectorId: 1, idTag: 'TAG1', meterStart: 1000, timestamp: '2024-10-12T10:09:00.000Z' });
      const updated = await transactionEvent('Updated', 1, { transactionInfo: { chargingState: 'Charging' }, meterValue: energy(1500) });
      expect(updated).toEqual({});
      expect(ocppService.handleMeterValues.mock.calls[1][1]).toEqual({
        connectorId: 1, transactionId: 555,
        meterValue: [{ timestamp: '2024-10-12T10:05:00Z', sampledValue: [
          { value: '1500', format: 'Raw', context: 'Sample.Periodic', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }],
      });
      await transactionEvent('Ended', 2, {
        transactionInfo: { chargingState: 'EVConnected', stoppedReason: 'Local' }, meterValue: energy(2500, 'Transaction.End'),
      });
      expect(ocppService.handleStopTransaction.mock.calls[0][1]).toEqual(
        { transactionId: 555, meterStop: 2500, timestamp: '2024-10-12T10:12:00Z', reason: 'Local' });
      await statusNotification('Available');
      expect(statusesSent()).toEqual(['Available', 'Preparing', 'SuspendedEVSE', 'Charging', 'Finishing', 'Available']);
      const mapping = mappingStore.get(`${chargingStationID}~TX-1`);
      expect(mapping).toMatchObject({ platformTransactionID: 555, evseId: 1, ended: true, idToken: 'TAG1' });
    });

    it('should never report Available while the platform transaction is ongoing (EV unplugged before the end)', async () => {
      await statusNotification('Occupied');
      await transactionEvent('Started', 0, { idToken, evse: { id: 1, connectorId: 1 }, transactionInfo: { chargingState: 'Charging' },
        meterValue: energy(0, 'Transaction.Begin') });
      await statusNotification('Available');
      await transactionEvent('Ended', 1, { transactionInfo: { stoppedReason: 'EVDisconnected', chargingState: 'Idle' } });
      expect(statusesSent()).toEqual(['Preparing', 'Charging', 'Finishing', 'Available']);
      expect(ocppService.handleStopTransaction.mock.calls[0][1]).toMatchObject({ transactionId: 555, meterStop: 0, reason: 'EVDisconnected' });
    });

    it('should start the platform transaction when the user is identified after the start', async () => {
      await statusNotification('Occupied');
      await expect(transactionEvent('Started', 0, { evse: { id: 1, connectorId: 1 }, transactionInfo: { chargingState: 'EVConnected' },
        meterValue: energy(1000, 'Transaction.Begin') })).resolves.toEqual({});
      expect(ocppService.handleStartTransaction).not.toHaveBeenCalled();
      expect(ocppService.handleMeterValues).not.toHaveBeenCalled();
      await expect(transactionEvent('Updated', 1, { idToken, transactionInfo: { chargingState: 'Charging' } }))
        .resolves.toEqual({ idTokenInfo: { status: 'Accepted' } });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toMatchObject({ connectorId: 1, idTag: 'TAG1', meterStart: 1000 });
      expect(statusesSent()).toEqual(['Preparing', 'Charging']);
    });

    it('should not start a transaction refused by the platform', async () => {
      ocppService.handleStartTransaction.mockResolvedValue({ transactionId: 0, idTagInfo: { status: 'Invalid' } });
      await statusNotification('Occupied');
      await expect(transactionEvent('Started', 0, { idToken, evse: { id: 1 }, meterValue: energy(1000, 'Transaction.Begin') }))
        .resolves.toEqual({ idTokenInfo: { status: 'Invalid' } });
      await expect(transactionEvent('Updated', 1, { idToken, meterValue: energy(1100) })).resolves.toEqual({ idTokenInfo: { status: 'Invalid' } });
      await transactionEvent('Ended', 2, { transactionInfo: { stoppedReason: 'DeAuthorized' } });
      expect(ocppService.handleStartTransaction).toHaveBeenCalledTimes(1);
      expect(ocppService.handleMeterValues).not.toHaveBeenCalled();
      expect(ocppService.handleStopTransaction).not.toHaveBeenCalled();
      expect(statusesSent()).toEqual(['Preparing']);
    });

    it('should never accept a transaction that could not be created', async () => {
      ocppService.handleStartTransaction.mockResolvedValue({ transactionId: 0, idTagInfo: { status: 'Accepted' } });
      await expect(transactionEvent('Started', 0, { idToken, evse: { id: 1 } })).resolves.toEqual({ idTokenInfo: { status: 'Invalid' } });
    });

    it('should start the consumption from the first reading when the start reading is missing', async () => {
      (TransactionStorage.getTransaction as jest.Mock<any>).mockResolvedValue({ id: 555, timestamp: new Date('2024-10-12T10:10:00Z'), numberOfMeterValues: 0 });
      await transactionEvent('Started', 0, { idToken, evse: { id: 1 } });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toMatchObject({ meterStart: 0 });
      await transactionEvent('Updated', 1, { meterValue: energy(5000) });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(TransactionStorage.saveTransaction).toHaveBeenCalledWith(tenant, expect.objectContaining({
        meterStart: 5000, lastConsumption: { value: 5000, timestamp: new Date('2024-10-12T10:10:00Z') } }));
      expect(ocppService.handleMeterValues).toHaveBeenCalledTimes(1);
      // Done only once
      await transactionEvent('Updated', 2, { meterValue: energy(6000) });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(TransactionStorage.saveTransaction).toHaveBeenCalledTimes(1);
    });

    it('should ignore a retransmitted Transaction Event', async () => {
      await transactionEvent('Started', 0, { idToken, evse: { id: 1 }, meterValue: energy(1000, 'Transaction.Begin') });
      await transactionEvent('Updated', 1, { meterValue: energy(1500) });
      await expect(transactionEvent('Updated', 1, { idToken, meterValue: energy(1500) })).resolves.toEqual({ idTokenInfo: { status: 'Accepted' } });
      expect(ocppService.handleMeterValues).toHaveBeenCalledTimes(2);
      await transactionEvent('Ended', 2, {});
      await transactionEvent('Ended', 2, {});
      expect(ocppService.handleStopTransaction).toHaveBeenCalledTimes(1);
    });

    it('should use the last known meter value to stop the transaction', async () => {
      (TransactionStorage.getTransaction as jest.Mock<any>).mockResolvedValue({ id: 555, lastConsumption: { value: 4242 } });
      await transactionEvent('Started', 0, { idToken, evse: { id: 1 } });
      await transactionEvent('Ended', 1, { idToken: { idToken: 'TAG2', type: 'ISO14443' }, transactionInfo: { stoppedReason: 'Remote' } });
      expect(ocppService.handleStopTransaction.mock.calls[0][1]).toEqual(
        { transactionId: 555, meterStop: 4242, timestamp: '2024-10-12T10:11:00Z', reason: 'Remote', idTag: 'TAG2' });
      // The other tag has been checked
      expect(ocppService.handleAuthorize.mock.calls[0][1]).toEqual({ idTag: 'TAG2' });
    });

    it('should process a transaction received after the fact (offline)', async () => {
      await transactionEvent('Ended', 3, {
        offline: true, idToken, evse: { id: 1, connectorId: 1 }, transactionInfo: { stoppedReason: 'Local' },
        meterValue: [...energy(100, 'Transaction.Begin', '2024-10-12T09:00:00Z'), ...energy(900, 'Transaction.End', '2024-10-12T09:30:00Z')],
      });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toEqual(
        { connectorId: 1, idTag: 'TAG1', meterStart: 100, timestamp: '2024-10-12T09:00:00.000Z' });
      expect(ocppService.handleStopTransaction.mock.calls[0][1]).toMatchObject({ transactionId: 555, meterStop: 900 });
    });

    it('should create the connector before starting a transaction on an unknown EVSE', async () => {
      await transactionEvent('Started', 0, { idToken, evse: { id: 2, connectorId: 1 } });
      expect(ocppService.handleStatusNotification.mock.calls[0][1]).toMatchObject({ connectorId: 2, status: 'Preparing', errorCode: 'NoError' });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toMatchObject({ connectorId: 2 });
    });

    it('should use the single connector of the Charging Station when the EVSE is missing', async () => {
      await transactionEvent('Started', 0, { idToken });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toMatchObject({ connectorId: 1 });
    });

    it('should not process a transaction without EVSE on a multi connector Charging Station', async () => {
      chargingStation.connectors = [{ connectorId: 1 }, { connectorId: 2 }];
      await expect(transactionEvent('Started', 0, { idToken })).resolves.toEqual({ idTokenInfo: { status: 'Accepted' } });
      expect(ocppService.handleStartTransaction).not.toHaveBeenCalled();
    });

    it('should start a remotely started transaction reported without ID Token', async () => {
      remoteStartStore.set(`${chargingStationID}~2047274519`, { chargingStationID, remoteStartId: 2047274519, tagID: 'TAG1', evseId: 1 });
      await statusNotification('Occupied');
      // Only the remoteStartId is sent by the Charging Station
      await expect(transactionEvent('Started', 0, { evse: { id: 1, connectorId: 1 }, triggerReason: 'RemoteStart',
        transactionInfo: { remoteStartId: 2047274519, chargingState: 'Charging' }, meterValue: energy(581, 'Transaction.Begin') }))
        .resolves.toEqual({});
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toMatchObject({ connectorId: 1, idTag: 'TAG1', meterStart: 581 });
      await transactionEvent('Updated', 1, { meterValue: energy(4000) });
      await transactionEvent('Ended', 2, { transactionInfo: { stoppedReason: 'Remote' }, meterValue: energy(8513, 'Transaction.End') });
      expect(ocppService.handleStartTransaction).toHaveBeenCalledTimes(1);
      expect(ocppService.handleStopTransaction.mock.calls[0][1]).toMatchObject({ transactionId: 555, meterStop: 8513, reason: 'Remote' });
      expect(mappingStore.get(`${chargingStationID}~TX-1`)).toMatchObject({ platformTransactionID: 555, idToken: 'TAG1', idTokenType: 'Central' });
      expect(statusesSent()).toEqual(['Preparing', 'Charging', 'Finishing']);
    });

    it('should use the EVSE of the remote start when the Transaction Event does not provide it', async () => {
      chargingStation.connectors = [{ connectorId: 1 }, { connectorId: 2 }];
      remoteStartStore.set(`${chargingStationID}~42`, { chargingStationID, remoteStartId: 42, tagID: 'TAG1', evseId: 2 });
      await transactionEvent('Started', 0, { transactionInfo: { remoteStartId: 42 } });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toMatchObject({ connectorId: 2, idTag: 'TAG1' });
    });

    it('should wait for an ID Token when the remote start is unknown', async () => {
      await transactionEvent('Started', 0, { evse: { id: 1 }, transactionInfo: { remoteStartId: 99 }, meterValue: energy(100, 'Transaction.Begin') });
      expect(ocppService.handleStartTransaction).not.toHaveBeenCalled();
      await expect(transactionEvent('Updated', 1, { idToken })).resolves.toEqual({ idTokenInfo: { status: 'Accepted' } });
      expect(ocppService.handleStartTransaction.mock.calls[0][1]).toMatchObject({ idTag: 'TAG1', meterStart: 100 });
    });

    it('should restore the ongoing transactions after a server restart', async () => {
      mappingStore.set(`${chargingStationID}~TX-9`, {
        id: `${chargingStationID}~TX-9`, chargingStationID, transactionId: 'TX-9', evseId: 1, platformTransactionID: 777,
        chargingState: null, ended: false, createdOn: new Date(), lastChangedOn: new Date(),
      } as unknown as Ocpp201TransactionMapping);
      await statusNotification('Occupied');
      expect(statusesSent()).toEqual(['Charging']);
    });

    it('should forget the connector statuses after a reboot', async () => {
      await statusNotification('Occupied');
      await handle(Ocpp201IncomingAction.BOOT_NOTIFICATION, { chargingStation: { vendorName: 'F', model: 'M' }, reason: 'PowerUp' });
      const evseState = Ocpp201EvseStateManager.getEvseState(TENANT_ID, chargingStationID, 1);
      expect(evseState.connectorStatuses.size).toBe(0);
      await statusNotification('Occupied');
      // Sent again as the platform connectors are recreated after a boot
      expect(statusesSent()).toEqual(['Preparing', 'Preparing']);
    });

    it('should ignore the status of the EVSE 0', async () => {
      await statusNotification('Unavailable', 0, 0);
      expect(ocppService.handleStatusNotification).not.toHaveBeenCalled();
    });
  });
});
