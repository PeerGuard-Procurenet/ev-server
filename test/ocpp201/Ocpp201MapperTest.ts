import { OCPPAuthorizationStatus, OCPPDiagnosticsStatus, OCPPFirmwareStatus, OCPPReason } from '../../src/types/ocpp/OCPPServer';
import { Ocpp201AuthorizationStatus, Ocpp201IdTokenType, Ocpp201MeterValue, Ocpp201SetVariableStatus } from '../../src/server/ocpp201/types/Ocpp201Types';
import { describe, expect, it } from '@jest/globals';

import { OCPPConfigurationStatus } from '../../src/types/ocpp/OCPPClient';
import Ocpp201Mapper from '../../src/server/ocpp201/mapping/Ocpp201Mapper';

describe('OCPP 2.0.1 mapper', () => {
  describe('ID Tokens', () => {
    it('should map usable ID Tokens to a platform tag ID', () => {
      expect(Ocpp201Mapper.getPlatformTagID({ idToken: 'ABC123', type: Ocpp201IdTokenType.ISO14443 })).toBe('ABC123');
      expect(Ocpp201Mapper.getPlatformTagID({ idToken: 'X'.repeat(20), type: Ocpp201IdTokenType.CENTRAL })).toBe('X'.repeat(20));
    });

    it('should not map ID Tokens that cannot be a platform tag', () => {
      expect(Ocpp201Mapper.getPlatformTagID({ idToken: '', type: Ocpp201IdTokenType.NO_AUTHORIZATION })).toBeNull();
      expect(Ocpp201Mapper.getPlatformTagID({ idToken: 'ABC', type: Ocpp201IdTokenType.NO_AUTHORIZATION })).toBeNull();
      expect(Ocpp201Mapper.getPlatformTagID({ idToken: '   ', type: Ocpp201IdTokenType.ISO14443 })).toBeNull();
      expect(Ocpp201Mapper.getPlatformTagID({ idToken: 'X'.repeat(21), type: Ocpp201IdTokenType.E_MAID })).toBeNull();
      expect(Ocpp201Mapper.getPlatformTagID(null)).toBeNull();
    });

    it('should compare tag IDs case insensitively', () => {
      expect(Ocpp201Mapper.isSameTagID('abc', 'ABC')).toBe(true);
      expect(Ocpp201Mapper.isSameTagID('abc', 'abd')).toBe(false);
      expect(Ocpp201Mapper.isSameTagID(null, 'abc')).toBe(false);
    });

    it('should map the authorization statuses', () => {
      expect(Ocpp201Mapper.mapAuthorizationStatus(OCPPAuthorizationStatus.ACCEPTED)).toBe(Ocpp201AuthorizationStatus.ACCEPTED);
      expect(Ocpp201Mapper.mapAuthorizationStatus(OCPPAuthorizationStatus.BLOCKED)).toBe(Ocpp201AuthorizationStatus.BLOCKED);
      expect(Ocpp201Mapper.mapAuthorizationStatus(OCPPAuthorizationStatus.EXPIRED)).toBe(Ocpp201AuthorizationStatus.EXPIRED);
      expect(Ocpp201Mapper.mapAuthorizationStatus(OCPPAuthorizationStatus.CONCURRENT_TX)).toBe(Ocpp201AuthorizationStatus.CONCURRENT_TX);
      expect(Ocpp201Mapper.mapAuthorizationStatus(OCPPAuthorizationStatus.INVALID)).toBe(Ocpp201AuthorizationStatus.INVALID);
      expect(Ocpp201Mapper.mapAuthorizationStatus(null)).toBe(Ocpp201AuthorizationStatus.INVALID);
    });
  });

  describe('Boot Notification', () => {
    it('should map the charging station description', () => {
      expect(Ocpp201Mapper.mapBootNotification({
        chargingStation: { vendorName: 'Factory', model: 'AC22', serialNumber: 'SN1', firmwareVersion: '1.2', modem: { iccid: 'I1', imsi: 'M1' } },
        reason: 'PowerUp',
      })).toEqual({
        chargePointVendor: 'Factory', chargePointModel: 'AC22', chargePointSerialNumber: 'SN1', firmwareVersion: '1.2', iccid: 'I1', imsi: 'M1'
      });
    });

    it('should only keep the provided properties and truncate the vendor to the platform limit', () => {
      expect(Ocpp201Mapper.mapBootNotification({
        chargingStation: { vendorName: 'V'.repeat(50), model: 'AC22' }, reason: 'PowerUp',
      })).toEqual({ chargePointVendor: 'V'.repeat(25), chargePointModel: 'AC22' });
    });
  });

  describe('Meter Values', () => {
    const meterValues: Ocpp201MeterValue[] = [
      {
        timestamp: '2024-10-12T10:00:00Z',
        sampledValue: [
          { value: 12.5, measurand: 'Energy.Active.Import.Register', context: 'Transaction.Begin', unitOfMeasure: { unit: 'kWh' } },
          { value: 7.2, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'kW' }, context: 'Sample.Periodic' },
          { value: 230, measurand: 'Voltage', phase: 'L1-N', unitOfMeasure: { unit: 'V' }, location: 'Outlet' },
          { value: 50, measurand: 'Frequency', unitOfMeasure: { unit: 'Hz' } },
          { value: 3, measurand: 'Energy.Active.Net', unitOfMeasure: { unit: 'kWh' } },
          { value: 1, measurand: 'Current.Import', unitOfMeasure: { unit: 'mA' } },
        ],
      },
      {
        timestamp: '2024-10-12T10:15:00Z',
        sampledValue: [
          { value: 13600, context: 'Sample.Periodic' },
          { value: 136, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh', multiplier: 2 }, context: 'Sample.Periodic', location: 'Outlet' },
          { value: 80, measurand: 'SoC', unitOfMeasure: { unit: 'Percent' }, location: 'EV' },
        ],
      },
      {
        timestamp: '2024-10-12T10:20:00Z',
        sampledValue: [
          { value: 1, measurand: 'Energy.Apparent.Import' },
        ],
      },
    ];

    it('should convert the sampled values to the platform format and units', () => {
      expect(Ocpp201Mapper.convertMeterValues(meterValues)).toEqual([
        {
          timestamp: '2024-10-12T10:00:00Z',
          sampledValue: [
            { value: '12500', format: 'Raw', measurand: 'Energy.Active.Import.Register', context: 'Transaction.Begin', unit: 'Wh' },
            { value: '7200', format: 'Raw', measurand: 'Power.Active.Import', context: 'Sample.Periodic', unit: 'W' },
            { value: '230', format: 'Raw', measurand: 'Voltage', phase: 'L1-N', location: 'Outlet', unit: 'V' },
            { value: '50', format: 'Raw', measurand: 'Frequency' },
          ],
        },
        {
          timestamp: '2024-10-12T10:15:00Z',
          sampledValue: [
            { value: '13600', format: 'Raw', measurand: 'Energy.Active.Import.Register', context: 'Sample.Periodic' },
            { value: '13600', format: 'Raw', measurand: 'Energy.Active.Import.Register', context: 'Sample.Periodic', location: 'Outlet', unit: 'Wh' },
            { value: '80', format: 'Raw', measurand: 'SoC', location: 'EV', unit: 'Percent' },
          ],
        },
      ]);
    });

    it('should handle negative multipliers without floating point errors', () => {
      expect(Ocpp201Mapper.convertSampledValue({ value: 1234567, unitOfMeasure: { unit: 'Wh', multiplier: -3 } }).value).toBe('1234.567');
      expect(Ocpp201Mapper.getEnergyRegisterWh({ value: 0.1, unitOfMeasure: { unit: 'kWh', multiplier: 1 } })).toBe(1000);
    });

    it('should read the main energy register in Wh only', () => {
      expect(Ocpp201Mapper.getEnergyRegisterWh({ value: 12.5, unitOfMeasure: { unit: 'kWh' } })).toBe(12500);
      expect(Ocpp201Mapper.getEnergyRegisterWh({ value: 100 })).toBe(100);
      expect(Ocpp201Mapper.getEnergyRegisterWh({ value: 100, phase: 'L1' })).toBeNull();
      expect(Ocpp201Mapper.getEnergyRegisterWh({ value: 100, location: 'EV' })).toBeNull();
      expect(Ocpp201Mapper.getEnergyRegisterWh({ value: 100, measurand: 'Power.Active.Import' })).toBeNull();
      expect(Ocpp201Mapper.getEnergyRegisterWh({ value: 100, unitOfMeasure: { unit: 'varh' } })).toBeNull();
    });

    it('should find the first and last energy readings', () => {
      expect(Ocpp201Mapper.findEnergyRegisterReading(meterValues, 'first')).toEqual({ valueWh: 12500, timestamp: '2024-10-12T10:00:00Z' });
      expect(Ocpp201Mapper.findEnergyRegisterReading(meterValues, 'last')).toEqual({ valueWh: 13600, timestamp: '2024-10-12T10:15:00Z' });
      expect(Ocpp201Mapper.findEnergyRegisterReading(meterValues, 'first', 'Transaction.Begin')).toEqual({ valueWh: 12500, timestamp: '2024-10-12T10:00:00Z' });
      expect(Ocpp201Mapper.findEnergyRegisterReading(meterValues, 'first', 'Transaction.End')).toBeNull();
      expect(Ocpp201Mapper.findEnergyRegisterReading(null, 'last')).toBeNull();
    });

    it('should find the earliest timestamp of a reading context', () => {
      expect(Ocpp201Mapper.findEarliestTimestamp(meterValues, 'Transaction.Begin')).toBe('2024-10-12T10:00:00Z');
      expect(Ocpp201Mapper.findEarliestTimestamp(meterValues, 'Transaction.End')).toBeNull();
    });
  });

  describe('Statuses', () => {
    it('should map the stopped reasons', () => {
      expect(Ocpp201Mapper.mapStoppedReason(null)).toBe(OCPPReason.LOCAL);
      expect(Ocpp201Mapper.mapStoppedReason('EVDisconnected')).toBe(OCPPReason.EV_DISCONNECTED);
      expect(Ocpp201Mapper.mapStoppedReason('Remote')).toBe(OCPPReason.REMOTE);
      expect(Ocpp201Mapper.mapStoppedReason('ImmediateReset')).toBe(OCPPReason.HARD_RESET);
      expect(Ocpp201Mapper.mapStoppedReason('DeAuthorized')).toBe(OCPPReason.DE_AUTHORIZED);
      expect(Ocpp201Mapper.mapStoppedReason('EnergyLimitReached')).toBe(OCPPReason.OTHER);
    });

    it('should map the firmware statuses', () => {
      expect(Ocpp201Mapper.mapFirmwareStatus('DownloadScheduled')).toBe(OCPPFirmwareStatus.DOWNLOADING);
      expect(Ocpp201Mapper.mapFirmwareStatus('SignatureVerified')).toBe(OCPPFirmwareStatus.DOWNLOADED);
      expect(Ocpp201Mapper.mapFirmwareStatus('InstallRebooting')).toBe(OCPPFirmwareStatus.INSTALLING);
      expect(Ocpp201Mapper.mapFirmwareStatus('InvalidSignature')).toBe(OCPPFirmwareStatus.INSTALLATION_FAILED);
      expect(Ocpp201Mapper.mapFirmwareStatus('Installed')).toBe(OCPPFirmwareStatus.INSTALLED);
      expect(Ocpp201Mapper.mapFirmwareStatus('Idle')).toBe(OCPPFirmwareStatus.IDLE);
    });

    it('should map the log statuses', () => {
      expect(Ocpp201Mapper.mapLogStatus('Uploaded')).toBe(OCPPDiagnosticsStatus.UPLOADED);
      expect(Ocpp201Mapper.mapLogStatus('Uploading')).toBe(OCPPDiagnosticsStatus.UPLOADING);
      expect(Ocpp201Mapper.mapLogStatus('PermissionDenied')).toBe(OCPPDiagnosticsStatus.UPLOAD_FAILED);
      expect(Ocpp201Mapper.mapLogStatus('AcceptedCanceled')).toBe(OCPPDiagnosticsStatus.IDLE);
    });

    it('should map the set variable statuses', () => {
      expect(Ocpp201Mapper.mapSetVariableStatus(Ocpp201SetVariableStatus.ACCEPTED)).toBe(OCPPConfigurationStatus.ACCEPTED);
      expect(Ocpp201Mapper.mapSetVariableStatus(Ocpp201SetVariableStatus.REBOOT_REQUIRED)).toBe(OCPPConfigurationStatus.REBOOT_REQUIRED);
      expect(Ocpp201Mapper.mapSetVariableStatus(Ocpp201SetVariableStatus.REJECTED)).toBe(OCPPConfigurationStatus.REJECTED);
      expect(Ocpp201Mapper.mapSetVariableStatus(Ocpp201SetVariableStatus.UNKNOWN_VARIABLE)).toBe(OCPPConfigurationStatus.NOT_SUPPORTED);
    });
  });

  describe('Data Transfer', () => {
    it('should convert the data to a string', () => {
      expect(Ocpp201Mapper.mapDataTransfer({ vendorId: 'V', messageId: 'M', data: { a: 1 } })).toEqual({ vendorId: 'V', messageId: 'M', data: '{"a":1}' });
      expect(Ocpp201Mapper.mapDataTransfer({ vendorId: 'V', data: 'raw' })).toEqual({ vendorId: 'V', data: 'raw' });
      expect(Ocpp201Mapper.mapDataTransfer({ vendorId: 'V' })).toEqual({ vendorId: 'V' });
    });
  });

  describe('Configuration keys', () => {
    it('should build and parse device model keys', () => {
      const componentVariables = [
        { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
        { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'MessageTimeout', instance: 'Default' } },
        { component: { name: 'EVSE', evse: { id: 2 } }, variable: { name: 'Power' } },
        { component: { name: 'Connector', instance: 'Main', evse: { id: 1, connectorId: 2 } }, variable: { name: 'ConnectorType', instance: 'x' } },
      ];
      const keys = componentVariables.map((componentVariable) => Ocpp201Mapper.buildConfigurationKey(componentVariable));
      expect(keys).toEqual([
        'OCPPCommCtrlr.HeartbeatInterval',
        'OCPPCommCtrlr.MessageTimeout[Default]',
        'EVSE@2.Power',
        'Connector[Main]@1/2.ConnectorType[x]',
      ]);
      expect(keys.map((key) => Ocpp201Mapper.parseConfigurationKey(key))).toEqual(componentVariables);
    });

    it('should map OCPP 1.6 keys', () => {
      expect(Ocpp201Mapper.parseConfigurationKey('MeterValueSampleInterval')).toEqual(
        { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedInterval' } });
      // The alias must not be altered by the caller
      Ocpp201Mapper.parseConfigurationKey('HeartbeatInterval').component.name = 'Changed';
      expect(Ocpp201Mapper.parseConfigurationKey('HeartbeatInterval').component.name).toBe('OCPPCommCtrlr');
    });

    it('should reject invalid keys', () => {
      expect(Ocpp201Mapper.parseConfigurationKey('UnknownOcpp16Key')).toBeNull();
      expect(Ocpp201Mapper.parseConfigurationKey('')).toBeNull();
      expect(Ocpp201Mapper.parseConfigurationKey('.Variable')).toBeNull();
      expect(Ocpp201Mapper.parseConfigurationKey('Component.')).toBeNull();
    });
  });
});
