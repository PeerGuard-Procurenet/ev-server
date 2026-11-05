import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { Ocpp201Payload } from '../../src/server/ocpp201/types/Ocpp201Types';
import { Ocpp201RequestChannel } from '../../src/server/ocpp201/Ocpp201Connection';
import Ocpp201ClockSynchronizer from '../../src/server/ocpp201/services/Ocpp201ClockSynchronizer';

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
let chargingStationConfig: Record<string, unknown> = {};
jest.mock('../../src/utils/Configuration', () => ({
  __esModule: true,
  default: { getChargingStationConfig: () => chargingStationConfig },
}));

const identity = { tenantID: '5be7fb271014d90008992f06', tokenID: 'token', chargingStationID: 'CS-CLOCK', clientIP: '127.0.0.1' };
const clockVariable = (name: string) => ({ component: { name: 'ClockCtrlr' }, variable: { name } });

describe('OCPP 2.0.1 clock synchronization', () => {
  let channel: { isClosed: jest.Mock<any>; sendRequest: jest.Mock<any>; runAfterReceivedRequests: jest.Mock<any> };
  let synchronizer: Ocpp201ClockSynchronizer;
  let responses: Record<string, Ocpp201Payload>;

  beforeEach(() => {
    chargingStationConfig = {};
    responses = { SetVariables: { setVariableResult: [] }, TriggerMessage: { status: 'Accepted' } };
    channel = {
      isClosed: jest.fn(() => false),
      sendRequest: jest.fn(async (action: string) => Promise.resolve(responses[action])),
      runAfterReceivedRequests: jest.fn(async (task: () => Promise<unknown>) => task()),
    };
    synchronizer = new Ocpp201ClockSynchronizer(identity, channel as unknown as Ocpp201RequestChannel);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Local time', () => {
    it('should compute the local time settings of West Africa Time', () => {
      expect(Ocpp201ClockSynchronizer.getLocalTimeSettings('Africa/Lagos')).toEqual({ TimeOffset: '+01:00', TimeZone: 'Africa/Lagos' });
      // Daylight saving time is taken into account at the given date
      expect(Ocpp201ClockSynchronizer.getLocalTimeSettings('Europe/Paris', new Date('2026-07-01T00:00:00Z')).TimeOffset).toBe('+02:00');
    });

    it('should set the supported variables that are not set to the local time', async () => {
      responses.GetVariables = { getVariableResult: [
        { ...clockVariable('TimeOffset'), attributeStatus: 'Accepted', attributeValue: '+08:00' },
        { ...clockVariable('TimeZone'), attributeStatus: 'UnknownVariable' },
      ] };
      responses.SetVariables = { setVariableResult: [{ ...clockVariable('TimeOffset'), attributeStatus: 'Accepted' }] };
      await synchronizer.configureLocalTime('Africa/Lagos');
      expect(channel.sendRequest.mock.calls[0]).toEqual(['GetVariables', { getVariableData: [clockVariable('TimeOffset'), clockVariable('TimeZone')] }]);
      expect(channel.sendRequest.mock.calls[1]).toEqual(['SetVariables', { setVariableData: [{ ...clockVariable('TimeOffset'), attributeValue: '+01:00' }] }]);
    });

    it('should not set the variables already set to the local time', async () => {
      responses.GetVariables = { getVariableResult: [
        { ...clockVariable('TimeOffset'), attributeStatus: 'Accepted', attributeValue: '+01:00' },
        { ...clockVariable('TimeZone'), attributeStatus: 'Accepted', attributeValue: 'Africa/Lagos' },
      ] };
      await synchronizer.configureLocalTime('Africa/Lagos');
      expect(channel.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('should not set the local time when disabled, without timezone or without connection', async () => {
      await synchronizer.configureLocalTime(null);
      chargingStationConfig = { setLocalTimeOnChargingStations: false };
      await synchronizer.configureLocalTime('Africa/Lagos');
      expect(channel.sendRequest).not.toHaveBeenCalled();
      chargingStationConfig = {};
      await new Ocpp201ClockSynchronizer(identity, null).configureLocalTime('Africa/Lagos');
      expect(channel.sendRequest).not.toHaveBeenCalled();
    });

    it('should fail when the Charging Station does not answer', async () => {
      channel.sendRequest.mockRejectedValueOnce(new Error('Timeout'));
      await expect(synchronizer.configureLocalTime('Africa/Lagos')).rejects.toThrow('Timeout');
    });
  });

  describe('Clock drift', () => {
    const at = (offsetSecs: number) => new Date(Date.now() + offsetSecs * 1000).toISOString();

    it('should not resynchronize a clock in line with the CSMS or a message delivered late', () => {
      synchronizer.checkMessageTimestamp('StatusNotification', at(60));
      synchronizer.checkMessageTimestamp('StatusNotification', at(-3600));
      synchronizer.checkMessageTimestamp('StatusNotification', 'not a date');
      expect(channel.sendRequest).not.toHaveBeenCalled();
    });

    it('should request a Heartbeat when the clock is ahead', () => {
      // 7 hours ahead (seen on some Charging Stations)
      synchronizer.checkMessageTimestamp('TransactionEvent', at(7 * 3600));
      expect(channel.sendRequest).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'Heartbeat' });
    });

    it('should request a Heartbeat when the clock is far behind (reset after a power loss)', () => {
      synchronizer.checkMessageTimestamp('StatusNotification', '2024-10-30T13:12:58.024Z');
      expect(channel.sendRequest).toHaveBeenCalledWith('TriggerMessage', { requestedMessage: 'Heartbeat' });
    });

    it('should not request a Heartbeat more than once every 10 minutes', () => {
      jest.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z') });
      synchronizer.checkMessageTimestamp('StatusNotification', at(7 * 3600));
      synchronizer.checkMessageTimestamp('StatusNotification', at(7 * 3600));
      expect(channel.sendRequest).toHaveBeenCalledTimes(1);
      jest.setSystemTime(new Date('2026-11-05T10:10:01Z'));
      synchronizer.checkMessageTimestamp('StatusNotification', at(7 * 3600));
      expect(channel.sendRequest).toHaveBeenCalledTimes(2);
    });
  });
});
