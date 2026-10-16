import { OCPPAuthorizationStatus, OCPPBootNotificationRequest, OCPPDataTransferRequest, OCPPDiagnosticsStatus, OCPPFirmwareStatus, OCPPLocation, OCPPMeasurand, OCPPMeterValue, OCPPPhase, OCPPReadingContext, OCPPReason, OCPPSampledValue, OCPPUnitOfMeasure, OCPPValueFormat } from '../../../types/ocpp/OCPPServer';
import { Ocpp201AuthorizationStatus, Ocpp201BootNotificationRequest, Ocpp201Component, Ocpp201ComponentVariable, Ocpp201DataTransferRequest, Ocpp201IdToken, Ocpp201IdTokenType, Ocpp201MeterValue, Ocpp201SampledValue, Ocpp201SetVariableStatus, Ocpp201Variable } from '../types/Ocpp201Types';

import { Decimal } from 'decimal.js';
import { OCPPConfigurationStatus } from '../../../types/ocpp/OCPPClient';

// Limits of the platform (OCPP 1.6 based) business layer
const PLATFORM_MAX_TAG_ID_LENGTH = 20;
const PLATFORM_MAX_VENDOR_LENGTH = 25;

const ENERGY_ACTIVE_IMPORT_REGISTER = 'Energy.Active.Import.Register';

// Measurands understood by the platform meter values processing
const PLATFORM_MEASURANDS = new Set<string>([
  'Energy.Active.Export.Register', 'Energy.Active.Import.Register', 'Energy.Reactive.Export.Register', 'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval', 'Energy.Active.Import.Interval', 'Energy.Reactive.Export.Interval', 'Energy.Reactive.Import.Interval',
  'Power.Active.Export', 'Power.Active.Import', 'Power.Offered', 'Power.Reactive.Export', 'Power.Reactive.Import', 'Power.Factor',
  'Current.Import', 'Current.Export', 'Current.Offered', 'Voltage', 'Frequency', 'SoC',
]);

// Measurands without a unit in OCPP 1.6
const UNITLESS_MEASURANDS = new Set<string>(['Frequency', 'Power.Factor']);

// OCPP 2.0.1 unit => platform unit + conversion factor
const UNIT_CONVERSIONS: Record<string, { unit: OCPPUnitOfMeasure; factor: number }> = {
  'Wh': { unit: OCPPUnitOfMeasure.WATT_HOUR, factor: 1 },
  'kWh': { unit: OCPPUnitOfMeasure.WATT_HOUR, factor: 1000 },
  'varh': { unit: OCPPUnitOfMeasure.VAR_HOUR, factor: 1 },
  'kvarh': { unit: OCPPUnitOfMeasure.VAR_HOUR, factor: 1000 },
  'W': { unit: OCPPUnitOfMeasure.WATT, factor: 1 },
  'kW': { unit: OCPPUnitOfMeasure.WATT, factor: 1000 },
  'VA': { unit: OCPPUnitOfMeasure.VOLT_AMP, factor: 1 },
  'kVA': { unit: OCPPUnitOfMeasure.VOLT_AMP, factor: 1000 },
  'var': { unit: OCPPUnitOfMeasure.VAR, factor: 1 },
  'kvar': { unit: OCPPUnitOfMeasure.VAR, factor: 1000 },
  'A': { unit: OCPPUnitOfMeasure.AMP, factor: 1 },
  'V': { unit: OCPPUnitOfMeasure.VOLT, factor: 1 },
  'K': { unit: OCPPUnitOfMeasure.TEMP_KELVIN, factor: 1 },
  'Fahrenheit': { unit: OCPPUnitOfMeasure.TEMP_FAHRENHEIT, factor: 1 },
  'Percent': { unit: OCPPUnitOfMeasure.PERCENT, factor: 1 },
};

// OCPP 1.6 configuration keys commonly used by the platform => OCPP 2.0.1 device model variables
const OCPP16_KEY_ALIASES: Record<string, Ocpp201ComponentVariable> = {
  'HeartbeatInterval': { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
  'WebSocketPingInterval': { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'WebSocketPingInterval' } },
  'ResetRetries': { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'ResetRetries' } },
  'TransactionMessageAttempts': { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'MessageAttempts', instance: 'TransactionEvent' } },
  'TransactionMessageRetryInterval': { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'MessageAttemptInterval', instance: 'TransactionEvent' } },
  'UnlockConnectorOnEVSideDisconnect': { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'UnlockOnEVSideDisconnect' } },
  'MeterValueSampleInterval': { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedInterval' } },
  'MeterValuesSampledData': { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedMeasurands' } },
  'StopTxnSampledData': { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxEndedMeasurands' } },
  'ClockAlignedDataInterval': { component: { name: 'AlignedDataCtrlr' }, variable: { name: 'Interval' } },
  'MeterValuesAlignedData': { component: { name: 'AlignedDataCtrlr' }, variable: { name: 'Measurands' } },
  'StopTxnAlignedData': { component: { name: 'AlignedDataCtrlr' }, variable: { name: 'TxEndedMeasurands' } },
  'ConnectionTimeOut': { component: { name: 'TxCtrlr' }, variable: { name: 'EVConnectionTimeOut' } },
  'StopTransactionOnEVSideDisconnect': { component: { name: 'TxCtrlr' }, variable: { name: 'StopTxOnEVSideDisconnect' } },
  'StopTransactionOnInvalidId': { component: { name: 'TxCtrlr' }, variable: { name: 'StopTxOnInvalidId' } },
  'AuthorizeRemoteTxRequests': { component: { name: 'AuthCtrlr' }, variable: { name: 'AuthorizeRemoteStart' } },
  'LocalAuthorizeOffline': { component: { name: 'AuthCtrlr' }, variable: { name: 'LocalAuthorizeOffline' } },
  'LocalPreAuthorize': { component: { name: 'AuthCtrlr' }, variable: { name: 'LocalPreAuthorize' } },
  'AuthorizationCacheEnabled': { component: { name: 'AuthCacheCtrlr' }, variable: { name: 'Enabled' } },
  'LocalAuthListEnabled': { component: { name: 'LocalAuthListCtrlr' }, variable: { name: 'Enabled' } },
};

// Device model variables reported when the platform requests the whole configuration
export const OCPP201_STANDARD_CONFIGURATION_VARIABLES: Ocpp201ComponentVariable[] = [
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'MessageTimeout', instance: 'Default' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'MessageAttempts', instance: 'TransactionEvent' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'MessageAttemptInterval', instance: 'TransactionEvent' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'NetworkConfigurationPriority' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'NetworkProfileConnectionAttempts' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'OfflineThreshold' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'ResetRetries' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'UnlockOnEVSideDisconnect' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'WebSocketPingInterval' } },
  { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'FileTransferProtocols' } },
  { component: { name: 'SecurityCtrlr' }, variable: { name: 'SecurityProfile' } },
  { component: { name: 'SecurityCtrlr' }, variable: { name: 'OrganizationName' } },
  { component: { name: 'AuthCtrlr' }, variable: { name: 'AuthorizeRemoteStart' } },
  { component: { name: 'AuthCtrlr' }, variable: { name: 'LocalAuthorizeOffline' } },
  { component: { name: 'AuthCtrlr' }, variable: { name: 'LocalPreAuthorize' } },
  { component: { name: 'TxCtrlr' }, variable: { name: 'EVConnectionTimeOut' } },
  { component: { name: 'TxCtrlr' }, variable: { name: 'StopTxOnEVSideDisconnect' } },
  { component: { name: 'TxCtrlr' }, variable: { name: 'StopTxOnInvalidId' } },
  { component: { name: 'TxCtrlr' }, variable: { name: 'TxStartPoint' } },
  { component: { name: 'TxCtrlr' }, variable: { name: 'TxStopPoint' } },
  { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxStartedMeasurands' } },
  { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxEndedMeasurands' } },
  { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxEndedInterval' } },
  { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedMeasurands' } },
  { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedInterval' } },
  { component: { name: 'AlignedDataCtrlr' }, variable: { name: 'Measurands' } },
  { component: { name: 'AlignedDataCtrlr' }, variable: { name: 'Interval' } },
  { component: { name: 'AlignedDataCtrlr' }, variable: { name: 'TxEndedMeasurands' } },
  { component: { name: 'AlignedDataCtrlr' }, variable: { name: 'TxEndedInterval' } },
  { component: { name: 'ClockCtrlr' }, variable: { name: 'DateTime' } },
  { component: { name: 'ClockCtrlr' }, variable: { name: 'TimeSource' } },
];

const isNil = (value: unknown): boolean => value === null || typeof value === 'undefined';

const CONFIGURATION_KEY_REGEX = /^([^.[@]+)(?:\[([^\]]+)\])?(?:@(\d+)(?:\/(\d+))?)?\.([^[]+)(?:\[([^\]]+)\])?$/;

export default class Ocpp201Mapper {
  // ------------------------------------------------------------------------
  // Identification
  // ------------------------------------------------------------------------
  // Returns the tag ID to be used in the platform or null if the token cannot identify a platform tag
  public static getPlatformTagID(idToken: Ocpp201IdToken): string | null {
    if (!idToken || idToken.type === Ocpp201IdTokenType.NO_AUTHORIZATION) {
      return null;
    }
    const tagID = idToken.idToken?.trim();
    if (!tagID || tagID.length > PLATFORM_MAX_TAG_ID_LENGTH) {
      return null;
    }
    return tagID;
  }

  public static isSameTagID(tagID1: string, tagID2: string): boolean {
    if (!tagID1 || !tagID2) {
      return false;
    }
    return tagID1.toUpperCase() === tagID2.toUpperCase();
  }

  public static mapAuthorizationStatus(status: OCPPAuthorizationStatus): Ocpp201AuthorizationStatus {
    switch (status) {
      case OCPPAuthorizationStatus.ACCEPTED:
        return Ocpp201AuthorizationStatus.ACCEPTED;
      case OCPPAuthorizationStatus.BLOCKED:
        return Ocpp201AuthorizationStatus.BLOCKED;
      case OCPPAuthorizationStatus.EXPIRED:
        return Ocpp201AuthorizationStatus.EXPIRED;
      case OCPPAuthorizationStatus.CONCURRENT_TX:
        return Ocpp201AuthorizationStatus.CONCURRENT_TX;
      default:
        return Ocpp201AuthorizationStatus.INVALID;
    }
  }

  // ------------------------------------------------------------------------
  // Boot Notification
  // ------------------------------------------------------------------------
  public static mapBootNotification(bootNotification: Ocpp201BootNotificationRequest): OCPPBootNotificationRequest {
    const chargingStation = bootNotification.chargingStation;
    const platformBootNotification: OCPPBootNotificationRequest = {
      chargePointVendor: chargingStation.vendorName.substring(0, PLATFORM_MAX_VENDOR_LENGTH),
      chargePointModel: chargingStation.model,
    };
    if (chargingStation.serialNumber) {
      platformBootNotification.chargePointSerialNumber = chargingStation.serialNumber;
    }
    if (chargingStation.firmwareVersion) {
      platformBootNotification.firmwareVersion = chargingStation.firmwareVersion;
    }
    if (chargingStation.modem?.iccid) {
      platformBootNotification.iccid = chargingStation.modem.iccid;
    }
    if (chargingStation.modem?.imsi) {
      platformBootNotification.imsi = chargingStation.modem.imsi;
    }
    return platformBootNotification;
  }

  // ------------------------------------------------------------------------
  // Meter Values
  // ------------------------------------------------------------------------
  public static convertMeterValues(meterValues: Ocpp201MeterValue[]): OCPPMeterValue[] {
    const platformMeterValues: OCPPMeterValue[] = [];
    for (const meterValue of meterValues ?? []) {
      const sampledValues: OCPPSampledValue[] = [];
      for (const sampledValue of meterValue.sampledValue ?? []) {
        // Note: signed meter data is not forwarded as the platform consumption processing would read it as an energy value
        const platformSampledValue = Ocpp201Mapper.convertSampledValue(sampledValue);
        if (platformSampledValue) {
          sampledValues.push(platformSampledValue);
        }
      }
      if (sampledValues.length > 0) {
        platformMeterValues.push({
          timestamp: meterValue.timestamp,
          sampledValue: sampledValues,
        });
      }
    }
    return platformMeterValues;
  }

  public static convertSampledValue(sampledValue: Ocpp201SampledValue): OCPPSampledValue | null {
    const measurand = sampledValue.measurand ?? ENERGY_ACTIVE_IMPORT_REGISTER;
    if (!PLATFORM_MEASURANDS.has(measurand) || !Number.isFinite(sampledValue.value)) {
      return null;
    }
    let factor = 1;
    let unit: OCPPUnitOfMeasure;
    if (!isNil(sampledValue.unitOfMeasure?.unit)) {
      const conversion = UNIT_CONVERSIONS[sampledValue.unitOfMeasure.unit];
      if (conversion) {
        unit = conversion.unit;
        factor = conversion.factor;
      } else if (!UNITLESS_MEASURANDS.has(measurand)) {
        // Unit not supported by the platform
        return null;
      }
    }
    const value = Ocpp201Mapper.applyMultiplierAndFactor(sampledValue.value, sampledValue.unitOfMeasure?.multiplier, factor);
    const platformSampledValue: OCPPSampledValue = {
      value: value.toString(),
      format: OCPPValueFormat.RAW,
      measurand: measurand as OCPPMeasurand,
    };
    if (sampledValue.context) {
      platformSampledValue.context = sampledValue.context as OCPPReadingContext;
    }
    if (sampledValue.phase) {
      platformSampledValue.phase = sampledValue.phase as OCPPPhase;
    }
    if (sampledValue.location) {
      platformSampledValue.location = sampledValue.location as OCPPLocation;
    }
    if (unit && !UNITLESS_MEASURANDS.has(measurand)) {
      platformSampledValue.unit = unit;
    }
    return platformSampledValue;
  }

  // Energy register in Wh (main meter, all phases), or null if not provided
  public static getEnergyRegisterWh(sampledValue: Ocpp201SampledValue): number | null {
    const measurand = sampledValue.measurand ?? ENERGY_ACTIVE_IMPORT_REGISTER;
    if (measurand !== ENERGY_ACTIVE_IMPORT_REGISTER || sampledValue.phase ||
        (sampledValue.location && sampledValue.location !== OCPPLocation.OUTLET) ||
        !Number.isFinite(sampledValue.value)) {
      return null;
    }
    const unit = sampledValue.unitOfMeasure?.unit ?? OCPPUnitOfMeasure.WATT_HOUR;
    if (unit !== OCPPUnitOfMeasure.WATT_HOUR && unit !== OCPPUnitOfMeasure.KILO_WATT_HOUR) {
      return null;
    }
    return Ocpp201Mapper.applyMultiplierAndFactor(sampledValue.value, sampledValue.unitOfMeasure?.multiplier,
      UNIT_CONVERSIONS[unit].factor);
  }

  // Returns the first (or last) energy register reading by timestamp, optionally restricted to a reading context
  public static findEnergyRegisterReading(meterValues: Ocpp201MeterValue[], which: 'first' | 'last',
      context?: string): { valueWh: number; timestamp: string } | null {
    let found: { valueWh: number; timestamp: string; time: number } = null;
    for (const meterValue of meterValues ?? []) {
      const time = new Date(meterValue.timestamp).getTime();
      for (const sampledValue of meterValue.sampledValue ?? []) {
        if (context && sampledValue.context !== context) {
          continue;
        }
        const valueWh = Ocpp201Mapper.getEnergyRegisterWh(sampledValue);
        if (valueWh === null) {
          continue;
        }
        if (!found || (which === 'first' ? time < found.time : time >= found.time)) {
          found = { valueWh, timestamp: meterValue.timestamp, time };
        }
      }
    }
    return found ? { valueWh: found.valueWh, timestamp: found.timestamp } : null;
  }

  public static findEarliestTimestamp(meterValues: Ocpp201MeterValue[], context: string): string | null {
    let earliest: string = null;
    for (const meterValue of meterValues ?? []) {
      if ((meterValue.sampledValue ?? []).some((sampledValue) => sampledValue.context === context) &&
          (!earliest || new Date(meterValue.timestamp).getTime() < new Date(earliest).getTime())) {
        earliest = meterValue.timestamp;
      }
    }
    return earliest;
  }

  // ------------------------------------------------------------------------
  // Transaction
  // ------------------------------------------------------------------------
  public static mapStoppedReason(stoppedReason: string): OCPPReason {
    // Default value in OCPP 2.0.1 when the reason is omitted
    if (isNil(stoppedReason)) {
      return OCPPReason.LOCAL;
    }
    switch (stoppedReason) {
      case 'DeAuthorized':
        return OCPPReason.DE_AUTHORIZED;
      case 'EmergencyStop':
        return OCPPReason.EMERGENCY_STOP;
      case 'EVDisconnected':
        return OCPPReason.EV_DISCONNECTED;
      case 'ImmediateReset':
        return OCPPReason.HARD_RESET;
      case 'Local':
        return OCPPReason.LOCAL;
      case 'PowerLoss':
        return OCPPReason.POWER_LOSS;
      case 'Reboot':
        return OCPPReason.REBOOT;
      case 'Remote':
        return OCPPReason.REMOTE;
      default:
        return OCPPReason.OTHER;
    }
  }

  // ------------------------------------------------------------------------
  // Firmware / Log / Data Transfer
  // ------------------------------------------------------------------------
  public static mapFirmwareStatus(status: string): OCPPFirmwareStatus {
    switch (status) {
      case 'Downloaded':
      case 'SignatureVerified':
        return OCPPFirmwareStatus.DOWNLOADED;
      case 'DownloadFailed':
        return OCPPFirmwareStatus.DOWNLOAD_FAILED;
      case 'Downloading':
      case 'DownloadScheduled':
      case 'DownloadPaused':
        return OCPPFirmwareStatus.DOWNLOADING;
      case 'Installing':
      case 'InstallRebooting':
      case 'InstallScheduled':
        return OCPPFirmwareStatus.INSTALLING;
      case 'Installed':
        return OCPPFirmwareStatus.INSTALLED;
      case 'InstallationFailed':
      case 'InstallVerificationFailed':
      case 'InvalidSignature':
        return OCPPFirmwareStatus.INSTALLATION_FAILED;
      default:
        return OCPPFirmwareStatus.IDLE;
    }
  }

  public static mapLogStatus(status: string): OCPPDiagnosticsStatus {
    switch (status) {
      case 'Uploaded':
        return OCPPDiagnosticsStatus.UPLOADED;
      case 'Uploading':
        return OCPPDiagnosticsStatus.UPLOADING;
      case 'BadMessage':
      case 'NotSupportedOperation':
      case 'PermissionDenied':
      case 'UploadFailure':
        return OCPPDiagnosticsStatus.UPLOAD_FAILED;
      default:
        return OCPPDiagnosticsStatus.IDLE;
    }
  }

  public static mapDataTransfer(dataTransfer: Ocpp201DataTransferRequest): OCPPDataTransferRequest {
    const platformDataTransfer: OCPPDataTransferRequest = {
      vendorId: dataTransfer.vendorId,
    };
    if (!isNil(dataTransfer.messageId)) {
      platformDataTransfer.messageId = dataTransfer.messageId;
    }
    if (!isNil(dataTransfer.data)) {
      platformDataTransfer.data = typeof dataTransfer.data === 'string' ? dataTransfer.data : JSON.stringify(dataTransfer.data);
    }
    return platformDataTransfer;
  }

  // ------------------------------------------------------------------------
  // Device model <=> platform OCPP parameters
  // ------------------------------------------------------------------------
  // Format: Component[instance]@evseId/connectorId.Variable[instance] (instance and EVSE parts are optional)
  public static buildConfigurationKey(componentVariable: Ocpp201ComponentVariable): string {
    const component: Ocpp201Component = componentVariable.component;
    const variable: Ocpp201Variable = componentVariable.variable;
    let key = component.name;
    if (component.instance) {
      key += `[${component.instance}]`;
    }
    if (component.evse) {
      key += `@${component.evse.id}`;
      if (!isNil(component.evse.connectorId)) {
        key += `/${component.evse.connectorId}`;
      }
    }
    key += `.${variable.name}`;
    if (variable.instance) {
      key += `[${variable.instance}]`;
    }
    return key;
  }

  public static parseConfigurationKey(key: string): Ocpp201ComponentVariable | null {
    if (!key) {
      return null;
    }
    // OCPP 1.6 key alias
    if (OCPP16_KEY_ALIASES[key]) {
      return JSON.parse(JSON.stringify(OCPP16_KEY_ALIASES[key]));
    }
    const match = CONFIGURATION_KEY_REGEX.exec(key);
    if (!match) {
      return null;
    }
    const [, componentName, componentInstance, evseId, connectorId, variableName, variableInstance] = match;
    const componentVariable: Ocpp201ComponentVariable = {
      component: { name: componentName },
      variable: { name: variableName },
    };
    if (componentInstance) {
      componentVariable.component.instance = componentInstance;
    }
    if (!isNil(evseId)) {
      componentVariable.component.evse = { id: Number(evseId) };
      if (!isNil(connectorId)) {
        componentVariable.component.evse.connectorId = Number(connectorId);
      }
    }
    if (variableInstance) {
      componentVariable.variable.instance = variableInstance;
    }
    return componentVariable;
  }

  public static mapSetVariableStatus(status: Ocpp201SetVariableStatus): OCPPConfigurationStatus {
    switch (status) {
      case Ocpp201SetVariableStatus.ACCEPTED:
        return OCPPConfigurationStatus.ACCEPTED;
      case Ocpp201SetVariableStatus.REBOOT_REQUIRED:
        return OCPPConfigurationStatus.REBOOT_REQUIRED;
      case Ocpp201SetVariableStatus.REJECTED:
        return OCPPConfigurationStatus.REJECTED;
      default:
        return OCPPConfigurationStatus.NOT_SUPPORTED;
    }
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------
  private static applyMultiplierAndFactor(value: number, multiplier = 0, factor = 1): number {
    return new Decimal(value).mul(new Decimal(10).pow(multiplier ?? 0)).mul(factor).toNumber();
  }
}
