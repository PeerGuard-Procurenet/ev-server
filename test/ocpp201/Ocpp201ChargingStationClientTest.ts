import { OCPPAvailabilityType, OCPPResetType } from '../../src/types/ocpp/OCPPClient';
import Ocpp201Connection, { Ocpp201RequestHandler, Ocpp201Socket } from '../../src/server/ocpp201/Ocpp201Connection';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import Ocpp201ChargingStationClient from '../../src/server/ocpp201/client/Ocpp201ChargingStationClient';
import Ocpp201EvseStateManager from '../../src/server/ocpp201/mapping/Ocpp201EvseStateManager';
import { Ocpp201Payload } from '../../src/server/ocpp201/types/Ocpp201Types';
import Ocpp201TransactionStorage from '../../src/server/ocpp201/storage/Ocpp201TransactionStorage';

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
  default: { getChargingStationConfig: () => ({ pingIntervalOCPPJSecs: 60 }) },
}));
jest.mock('../../src/server/ocpp201/storage/Ocpp201TransactionStorage', () => ({
  __esModule: true,
  default: { getMappingByPlatformTransactionID: jest.fn() },
}));

type Responder = (action: string, payload: Ocpp201Payload) => Ocpp201Payload | { error: string };

// Charging Station simulator answering the requests of the CSMS
class SimulatedChargingStation implements Ocpp201Socket {
  public requests: { action: string; payload: Ocpp201Payload }[] = [];
  public connection: Ocpp201Connection;
  public responder: Responder = () => ({ status: 'Accepted' });

  public send(message: string): boolean {
    const [messageType, messageID, action, payload] = JSON.parse(message);
    if (messageType === 2) {
      this.requests.push({ action, payload });
      const response = this.responder(action, payload);
      setImmediate(() => {
        if ('error' in response) {
          this.connection.onMessage(JSON.stringify([4, messageID, response.error, 'Error', {}]));
        } else {
          this.connection.onMessage(JSON.stringify([3, messageID, response]));
        }
      });
    }
    return true;
  }

  public close(): void {
    // Nothing to do
  }

  public ping(): boolean {
    return true;
  }
}

const TENANT_ID = '5be7fb271014d90008992f06';
let stationCounter = 0;

describe('OCPP 2.0.1 Charging Station client (platform commands)', () => {
  let station: SimulatedChargingStation;
  let client: Ocpp201ChargingStationClient;
  let chargingStationID: string;

  beforeEach(() => {
    jest.clearAllMocks();
    stationCounter++;
    chargingStationID = `CS-${stationCounter}`;
    station = new SimulatedChargingStation();
    station.connection = new Ocpp201Connection(station, { tenantID: TENANT_ID, tokenID: 'token', chargingStationID, clientIP: '127.0.0.1' }, 1000);
    station.connection.setRequestHandler({ handleRequest: jest.fn() } as unknown as Ocpp201RequestHandler);
    client = new Ocpp201ChargingStationClient(station.connection, { id: TENANT_ID } as any);
  });

  it('should reset the Charging Station', async () => {
    station.responder = () => ({ status: 'Scheduled' });
    await expect(client.reset({ type: OCPPResetType.HARD })).resolves.toEqual({ status: 'Accepted' });
    await expect(client.reset({ type: OCPPResetType.SOFT })).resolves.toEqual({ status: 'Accepted' });
    station.responder = () => ({ status: 'Rejected' });
    await expect(client.reset({ type: OCPPResetType.SOFT })).resolves.toEqual({ status: 'Rejected' });
    expect(station.requests.map((request) => request.payload)).toEqual([{ type: 'Immediate' }, { type: 'OnIdle' }, { type: 'OnIdle' }]);
  });

  it('should clear the cache', async () => {
    await expect(client.clearCache()).resolves.toEqual({ status: 'Accepted' });
    expect(station.requests[0]).toEqual({ action: 'ClearCache', payload: {} });
  });

  it('should remotely start a transaction', async () => {
    await expect(client.remoteStartTransaction({ connectorId: 2, idTag: 'TAG1' })).resolves.toEqual({ status: 'Accepted' });
    const { action, payload } = station.requests[0];
    expect(action).toBe('RequestStartTransaction');
    expect(payload).toEqual({ idToken: { idToken: 'TAG1', type: 'Central' }, remoteStartId: expect.any(Number), evseId: 2 });
    expect(Number.isInteger(payload.remoteStartId) && payload.remoteStartId > 0).toBe(true);
    station.responder = () => ({ status: 'Rejected' });
    await expect(client.remoteStartTransaction({ connectorId: 0, idTag: 'TAG1', chargingProfile: {} as any })).resolves.toEqual({ status: 'Rejected' });
    expect(station.requests[1].payload.evseId).toBeUndefined();
    expect(station.requests[1].payload.chargingProfile).toBeUndefined();
  });

  it('should remotely stop a transaction with the OCPP 2.0.1 transaction ID', async () => {
    (Ocpp201TransactionStorage.getMappingByPlatformTransactionID as jest.Mock<any>).mockResolvedValueOnce({ transactionId: 'TX-1', ended: false });
    await expect(client.remoteStopTransaction({ transactionId: 555 })).resolves.toEqual({ status: 'Accepted' });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(Ocpp201TransactionStorage.getMappingByPlatformTransactionID).toHaveBeenCalledWith({ id: TENANT_ID }, chargingStationID, 555);
    expect(station.requests[0]).toEqual({ action: 'RequestStopTransaction', payload: { transactionId: 'TX-1' } });
  });

  it('should refuse to stop an unknown or ended transaction', async () => {
    (Ocpp201TransactionStorage.getMappingByPlatformTransactionID as jest.Mock<any>).mockResolvedValueOnce(null);
    await expect(client.remoteStopTransaction({ transactionId: 1 })).resolves.toEqual({ status: 'Rejected' });
    (Ocpp201TransactionStorage.getMappingByPlatformTransactionID as jest.Mock<any>).mockResolvedValueOnce({ transactionId: 'TX-1', ended: true });
    await expect(client.remoteStopTransaction({ transactionId: 1 })).resolves.toEqual({ status: 'Rejected' });
    expect(station.requests).toEqual([]);
  });

  it('should unlock the connector of the EVSE', async () => {
    const evseState = Ocpp201EvseStateManager.getEvseState(TENANT_ID, chargingStationID, 1);
    evseState.connectorStatuses.set(2, 'Occupied' as any);
    station.responder = () => ({ status: 'Unlocked' });
    await expect(client.unlockConnector({ connectorId: 1 })).resolves.toEqual({ status: 'Unlocked' });
    expect(station.requests[0].payload).toEqual({ evseId: 1, connectorId: 2 });
    station.responder = () => ({ status: 'UnknownConnector' });
    await expect(client.unlockConnector({ connectorId: 3 })).resolves.toEqual({ status: 'NotSupported' });
    expect(station.requests[1].payload).toEqual({ evseId: 3, connectorId: 1 });
    station.responder = () => ({ status: 'OngoingAuthorizedTransaction' });
    await expect(client.unlockConnector({ connectorId: 1 })).resolves.toEqual({ status: 'UnlockFailed' });
  });

  it('should change the availability of the Charging Station or of an EVSE', async () => {
    station.responder = () => ({ status: 'Scheduled' });
    await expect(client.changeAvailability({ connectorId: 0, type: OCPPAvailabilityType.INOPERATIVE })).resolves.toEqual({ status: 'Scheduled' });
    await expect(client.changeAvailability({ connectorId: 2, type: OCPPAvailabilityType.OPERATIVE })).resolves.toEqual({ status: 'Scheduled' });
    expect(station.requests.map((request) => request.payload)).toEqual([
      { operationalStatus: 'Inoperative' }, { operationalStatus: 'Operative', evse: { id: 2 } }]);
  });

  it('should request the diagnostics', async () => {
    station.responder = () => ({ status: 'Accepted', filename: 'diag.zip' });
    await expect(client.getDiagnostics({ location: 'ftp://logs', startTime: new Date('2024-10-01T00:00:00Z'), retries: 2 }))
      .resolves.toEqual({ fileName: 'diag.zip' });
    expect(station.requests[0]).toEqual({ action: 'GetLog', payload: {
      logType: 'DiagnosticsLog', requestId: expect.any(Number), retries: 2,
      log: { remoteLocation: 'ftp://logs', oldestTimestamp: '2024-10-01T00:00:00.000Z' } } });
    station.responder = () => ({ status: 'Rejected' });
    await expect(client.getDiagnostics({ location: 'ftp://logs' })).resolves.toEqual({});
  });

  it('should update the firmware', async () => {
    await client.updateFirmware({ location: 'https://fw/1.bin', retrieveDate: new Date('2024-10-12T00:00:00Z') });
    expect(station.requests[0]).toEqual({ action: 'UpdateFirmware', payload: {
      requestId: expect.any(Number), firmware: { location: 'https://fw/1.bin', retrieveDateTime: '2024-10-12T00:00:00.000Z' } } });
  });

  it('should transfer data', async () => {
    station.responder = () => ({ status: 'UnknownVendorId' });
    await expect(client.dataTransfer({ vendorId: 'V', messageId: 'M', data: 'payload' })).resolves.toEqual({ status: 'UnknownVendorId' });
    expect(station.requests[0].payload).toEqual({ vendorId: 'V', messageId: 'M', data: 'payload' });
  });

  it('should read the standard configuration with the device model', async () => {
    station.responder = (action, payload) => {
      const data = payload.getVariableData as any[];
      if (data.length === 1 && data[0].component.name === 'DeviceDataCtrlr') {
        return { getVariableResult: [{ ...data[0], attributeStatus: 'Accepted', attributeValue: '4' }] };
      }
      return {
        getVariableResult: data.map((item) => (item.component.name === 'OCPPCommCtrlr' ?
          { ...item, attributeStatus: 'Accepted', attributeValue: '42' } : { ...item, attributeStatus: 'UnknownComponent' }))
      };
    };
    const configuration = await client.getConfiguration();
    // ItemsPerMessage + chunks of 4 items
    const chunks = station.requests.slice(1).map((request) => (request.payload.getVariableData as any[]).length);
    expect(chunks.every((size) => size <= 4)).toBe(true);
    expect(configuration.unknownKey).toEqual([]);
    expect(configuration.configurationKey).toContainEqual({ key: 'OCPPCommCtrlr.HeartbeatInterval', value: '42', readonly: false });
    expect(configuration.configurationKey).toContainEqual({ key: 'OCPPCommCtrlr.MessageTimeout[Default]', value: '42', readonly: false });
    expect(configuration.configurationKey.every((parameter) => parameter.key.startsWith('OCPPCommCtrlr.'))).toBe(true);
  });

  it('should read the requested keys', async () => {
    station.responder = (action, payload) => {
      const data = payload.getVariableData as any[];
      if (data[0].component.name === 'DeviceDataCtrlr') {
        return { error: 'NotSupported' };
      }
      return { getVariableResult: data.map((item) => (item.variable.name === 'HeartbeatInterval' ?
        { ...item, attributeStatus: 'Accepted', attributeValue: '300' } : { ...item, attributeStatus: 'UnknownVariable' })) };
    };
    const configuration = await client.getConfiguration({ key: ['HeartbeatInterval', 'TxCtrlr.EVConnectionTimeOut', 'Unknown16Key'] });
    expect(configuration).toEqual({
      configurationKey: [{ key: 'HeartbeatInterval', value: '300', readonly: false }],
      unknownKey: ['Unknown16Key', 'TxCtrlr.EVConnectionTimeOut'],
    });
  });

  it('should request the variables one by one when the Charging Station refuses a chunk', async () => {
    station.responder = (action, payload) => {
      const data = payload.getVariableData as any[];
      if (data.length > 1) {
        return { error: 'OccurrenceConstraintViolation' };
      }
      return { getVariableResult: [{ ...data[0], attributeStatus: 'Accepted', attributeValue: 'v' }] };
    };
    const configuration = await client.getConfiguration({ key: ['HeartbeatInterval', 'MeterValueSampleInterval'] });
    expect(configuration.configurationKey.map((parameter) => parameter.key)).toEqual(['HeartbeatInterval', 'MeterValueSampleInterval']);
  });

  it('should change the configuration with the device model', async () => {
    station.responder = (action, payload) => ({ setVariableResult: (payload.setVariableData as any[]).map((item) => ({
      component: item.component, variable: item.variable, attributeStatus: 'RebootRequired' })) });
    await expect(client.changeConfiguration({ key: 'HeartbeatInterval', value: '300' })).resolves.toEqual({ status: 'RebootRequired' });
    expect(station.requests[0]).toEqual({ action: 'SetVariables', payload: { setVariableData: [{
      component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' }, attributeValue: '300' }] } });
    await expect(client.changeConfiguration({ key: 'Unknown16Key', value: '1' })).resolves.toEqual({ status: 'NotSupported' });
    await expect(client.changeConfiguration({ key: 'OCPPCommCtrlr.HeartbeatInterval', value: 'x'.repeat(1001) })).resolves.toEqual({ status: 'Rejected' });
    expect(station.requests.length).toBe(1);
  });

  it('should answer the unsupported commands without contacting the Charging Station', async () => {
    await expect(client.setChargingProfile()).resolves.toEqual({ status: 'NotSupported' });
    await expect(client.getCompositeSchedule()).resolves.toEqual({ status: 'Rejected' });
    await expect(client.clearChargingProfile()).resolves.toEqual({ status: 'Unknown' });
    await expect(client.reserveNow()).resolves.toEqual({ status: 'Rejected' });
    await expect(client.cancelReservation()).resolves.toEqual({ status: 'Rejected' });
    expect(station.requests).toEqual([]);
  });

  it('should propagate the errors of the Charging Station', async () => {
    station.responder = () => ({ error: 'InternalError' });
    await expect(client.clearCache()).rejects.toMatchObject({ code: 'InternalError' });
  });
});
