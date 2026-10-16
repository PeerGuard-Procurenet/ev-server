// OCPP 2.0.1 message types (subset used by the CSMS), derived from the official OCA JSON schemas
// stored in 'src/assets/server/ocpp201/schemas'. Field names and enum values match the specification exactly.

export const OCPP201_SUBPROTOCOL = 'ocpp2.0.1';
export const OCPP201_URL_PATH = 'OCPP201';
export const OCPP201_MESSAGE_ID_MAX_LENGTH = 36;

export enum Ocpp201MessageType {
  CALL = 2,
  CALL_RESULT = 3,
  CALL_ERROR = 4,
}

// OCPP-J 2.0.1 (Part 4) RPC framework error codes
export enum Ocpp201ErrorCode {
  FORMAT_VIOLATION = 'FormatViolation',
  GENERIC_ERROR = 'GenericError',
  INTERNAL_ERROR = 'InternalError',
  MESSAGE_TYPE_NOT_SUPPORTED = 'MessageTypeNotSupported',
  NOT_IMPLEMENTED = 'NotImplemented',
  NOT_SUPPORTED = 'NotSupported',
  OCCURRENCE_CONSTRAINT_VIOLATION = 'OccurrenceConstraintViolation',
  PROPERTY_CONSTRAINT_VIOLATION = 'PropertyConstraintViolation',
  PROTOCOL_ERROR = 'ProtocolError',
  RPC_FRAMEWORK_ERROR = 'RpcFrameworkError',
  SECURITY_ERROR = 'SecurityError',
  TYPE_CONSTRAINT_VIOLATION = 'TypeConstraintViolation',
}

// Messages initiated by the Charging Station
export enum Ocpp201IncomingAction {
  AUTHORIZE = 'Authorize',
  BOOT_NOTIFICATION = 'BootNotification',
  CLEARED_CHARGING_LIMIT = 'ClearedChargingLimit',
  DATA_TRANSFER = 'DataTransfer',
  FIRMWARE_STATUS_NOTIFICATION = 'FirmwareStatusNotification',
  GET_15118_EV_CERTIFICATE = 'Get15118EVCertificate',
  GET_CERTIFICATE_STATUS = 'GetCertificateStatus',
  HEARTBEAT = 'Heartbeat',
  LOG_STATUS_NOTIFICATION = 'LogStatusNotification',
  METER_VALUES = 'MeterValues',
  NOTIFY_CHARGING_LIMIT = 'NotifyChargingLimit',
  NOTIFY_CUSTOMER_INFORMATION = 'NotifyCustomerInformation',
  NOTIFY_DISPLAY_MESSAGES = 'NotifyDisplayMessages',
  NOTIFY_EV_CHARGING_NEEDS = 'NotifyEVChargingNeeds',
  NOTIFY_EV_CHARGING_SCHEDULE = 'NotifyEVChargingSchedule',
  NOTIFY_EVENT = 'NotifyEvent',
  NOTIFY_MONITORING_REPORT = 'NotifyMonitoringReport',
  NOTIFY_REPORT = 'NotifyReport',
  PUBLISH_FIRMWARE_STATUS_NOTIFICATION = 'PublishFirmwareStatusNotification',
  REPORT_CHARGING_PROFILES = 'ReportChargingProfiles',
  RESERVATION_STATUS_UPDATE = 'ReservationStatusUpdate',
  SECURITY_EVENT_NOTIFICATION = 'SecurityEventNotification',
  SIGN_CERTIFICATE = 'SignCertificate',
  STATUS_NOTIFICATION = 'StatusNotification',
  TRANSACTION_EVENT = 'TransactionEvent',
}

// Messages initiated by the CSMS
export enum Ocpp201OutgoingAction {
  CANCEL_RESERVATION = 'CancelReservation',
  CERTIFICATE_SIGNED = 'CertificateSigned',
  CHANGE_AVAILABILITY = 'ChangeAvailability',
  CLEAR_CACHE = 'ClearCache',
  CLEAR_CHARGING_PROFILE = 'ClearChargingProfile',
  CLEAR_DISPLAY_MESSAGE = 'ClearDisplayMessage',
  CLEAR_VARIABLE_MONITORING = 'ClearVariableMonitoring',
  COST_UPDATED = 'CostUpdated',
  CUSTOMER_INFORMATION = 'CustomerInformation',
  DATA_TRANSFER = 'DataTransfer',
  DELETE_CERTIFICATE = 'DeleteCertificate',
  GET_BASE_REPORT = 'GetBaseReport',
  GET_CHARGING_PROFILES = 'GetChargingProfiles',
  GET_COMPOSITE_SCHEDULE = 'GetCompositeSchedule',
  GET_DISPLAY_MESSAGES = 'GetDisplayMessages',
  GET_INSTALLED_CERTIFICATE_IDS = 'GetInstalledCertificateIds',
  GET_LOCAL_LIST_VERSION = 'GetLocalListVersion',
  GET_LOG = 'GetLog',
  GET_MONITORING_REPORT = 'GetMonitoringReport',
  GET_REPORT = 'GetReport',
  GET_TRANSACTION_STATUS = 'GetTransactionStatus',
  GET_VARIABLES = 'GetVariables',
  INSTALL_CERTIFICATE = 'InstallCertificate',
  PUBLISH_FIRMWARE = 'PublishFirmware',
  REQUEST_START_TRANSACTION = 'RequestStartTransaction',
  REQUEST_STOP_TRANSACTION = 'RequestStopTransaction',
  RESERVE_NOW = 'ReserveNow',
  RESET = 'Reset',
  SEND_LOCAL_LIST = 'SendLocalList',
  SET_CHARGING_PROFILE = 'SetChargingProfile',
  SET_DISPLAY_MESSAGE = 'SetDisplayMessage',
  SET_MONITORING_BASE = 'SetMonitoringBase',
  SET_MONITORING_LEVEL = 'SetMonitoringLevel',
  SET_NETWORK_PROFILE = 'SetNetworkProfile',
  SET_VARIABLE_MONITORING = 'SetVariableMonitoring',
  SET_VARIABLES = 'SetVariables',
  TRIGGER_MESSAGE = 'TriggerMessage',
  UNLOCK_CONNECTOR = 'UnlockConnector',
  UNPUBLISH_FIRMWARE = 'UnpublishFirmware',
  UPDATE_FIRMWARE = 'UpdateFirmware',
}

export type Ocpp201Payload = Record<string, any>;

export interface Ocpp201StatusInfo {
  reasonCode: string;
  additionalInfo?: string;
}

export interface Ocpp201EVSE {
  id: number;
  connectorId?: number;
}

// --------------------------------------------------------------------------
// BootNotification
// --------------------------------------------------------------------------
export enum Ocpp201RegistrationStatus {
  ACCEPTED = 'Accepted',
  PENDING = 'Pending',
  REJECTED = 'Rejected',
}

export interface Ocpp201BootNotificationRequest {
  chargingStation: {
    serialNumber?: string;
    model: string;
    modem?: { iccid?: string; imsi?: string };
    vendorName: string;
    firmwareVersion?: string;
  };
  reason: string;
}

export interface Ocpp201BootNotificationResponse {
  currentTime: string;
  interval: number;
  status: Ocpp201RegistrationStatus;
  statusInfo?: Ocpp201StatusInfo;
}

// --------------------------------------------------------------------------
// Authorization
// --------------------------------------------------------------------------
export enum Ocpp201IdTokenType {
  CENTRAL = 'Central',
  E_MAID = 'eMAID',
  ISO14443 = 'ISO14443',
  ISO15693 = 'ISO15693',
  KEY_CODE = 'KeyCode',
  LOCAL = 'Local',
  MAC_ADDRESS = 'MacAddress',
  NO_AUTHORIZATION = 'NoAuthorization',
}

export interface Ocpp201IdToken {
  idToken: string;
  type: Ocpp201IdTokenType;
  additionalInfo?: { additionalIdToken: string; type: string }[];
}

export enum Ocpp201AuthorizationStatus {
  ACCEPTED = 'Accepted',
  BLOCKED = 'Blocked',
  CONCURRENT_TX = 'ConcurrentTx',
  EXPIRED = 'Expired',
  INVALID = 'Invalid',
  NO_CREDIT = 'NoCredit',
  NOT_ALLOWED_TYPE_EVSE = 'NotAllowedTypeEVSE',
  NOT_AT_THIS_LOCATION = 'NotAtThisLocation',
  NOT_AT_THIS_TIME = 'NotAtThisTime',
  UNKNOWN = 'Unknown',
}

export interface Ocpp201IdTokenInfo {
  status: Ocpp201AuthorizationStatus;
  cacheExpiryDateTime?: string;
}

export interface Ocpp201AuthorizeRequest {
  idToken: Ocpp201IdToken;
  certificate?: string;
  iso15118CertificateHashData?: Record<string, unknown>[];
}

export interface Ocpp201AuthorizeResponse {
  idTokenInfo: Ocpp201IdTokenInfo;
}

// --------------------------------------------------------------------------
// StatusNotification
// --------------------------------------------------------------------------
export enum Ocpp201ConnectorStatus {
  AVAILABLE = 'Available',
  OCCUPIED = 'Occupied',
  RESERVED = 'Reserved',
  UNAVAILABLE = 'Unavailable',
  FAULTED = 'Faulted',
}

export interface Ocpp201StatusNotificationRequest {
  timestamp: string;
  connectorStatus: Ocpp201ConnectorStatus;
  evseId: number;
  connectorId: number;
}

// --------------------------------------------------------------------------
// Meter values
// --------------------------------------------------------------------------
export interface Ocpp201SignedMeterValue {
  signedMeterData: string;
  signingMethod: string;
  encodingMethod: string;
  publicKey: string;
}

export interface Ocpp201SampledValue {
  value: number;
  context?: string;
  measurand?: string;
  phase?: string;
  location?: string;
  signedMeterValue?: Ocpp201SignedMeterValue;
  unitOfMeasure?: { unit?: string; multiplier?: number };
}

export interface Ocpp201MeterValue {
  timestamp: string;
  sampledValue: Ocpp201SampledValue[];
}

export interface Ocpp201MeterValuesRequest {
  evseId: number;
  meterValue: Ocpp201MeterValue[];
}

// --------------------------------------------------------------------------
// TransactionEvent
// --------------------------------------------------------------------------
export enum Ocpp201TransactionEventType {
  STARTED = 'Started',
  UPDATED = 'Updated',
  ENDED = 'Ended',
}

export enum Ocpp201ChargingState {
  CHARGING = 'Charging',
  EV_CONNECTED = 'EVConnected',
  SUSPENDED_EV = 'SuspendedEV',
  SUSPENDED_EVSE = 'SuspendedEVSE',
  IDLE = 'Idle',
}

export interface Ocpp201TransactionInfo {
  transactionId: string;
  chargingState?: Ocpp201ChargingState;
  timeSpentCharging?: number;
  stoppedReason?: string;
  remoteStartId?: number;
}

export interface Ocpp201TransactionEventRequest {
  eventType: Ocpp201TransactionEventType;
  meterValue?: Ocpp201MeterValue[];
  timestamp: string;
  triggerReason: string;
  seqNo: number;
  offline?: boolean;
  numberOfPhasesUsed?: number;
  cableMaxCurrent?: number;
  reservationId?: number;
  transactionInfo: Ocpp201TransactionInfo;
  evse?: Ocpp201EVSE;
  idToken?: Ocpp201IdToken;
}

export interface Ocpp201TransactionEventResponse {
  totalCost?: number;
  chargingPriority?: number;
  idTokenInfo?: Ocpp201IdTokenInfo;
}

// --------------------------------------------------------------------------
// Firmware / Log / DataTransfer
// --------------------------------------------------------------------------
export interface Ocpp201FirmwareStatusNotificationRequest {
  status: string;
  requestId?: number;
}

export interface Ocpp201LogStatusNotificationRequest {
  status: string;
  requestId?: number;
}

export enum Ocpp201DataTransferStatus {
  ACCEPTED = 'Accepted',
  REJECTED = 'Rejected',
  UNKNOWN_MESSAGE_ID = 'UnknownMessageId',
  UNKNOWN_VENDOR_ID = 'UnknownVendorId',
}

export interface Ocpp201DataTransferRequest {
  vendorId: string;
  messageId?: string;
  data?: unknown;
}

export interface Ocpp201DataTransferResponse {
  status: Ocpp201DataTransferStatus;
  statusInfo?: Ocpp201StatusInfo;
  data?: unknown;
}

// --------------------------------------------------------------------------
// Device model (GetVariables / SetVariables)
// --------------------------------------------------------------------------
export interface Ocpp201Component {
  name: string;
  instance?: string;
  evse?: Ocpp201EVSE;
}

export interface Ocpp201Variable {
  name: string;
  instance?: string;
}

export interface Ocpp201ComponentVariable {
  component: Ocpp201Component;
  variable: Ocpp201Variable;
}

export enum Ocpp201GetVariableStatus {
  ACCEPTED = 'Accepted',
  REJECTED = 'Rejected',
  UNKNOWN_COMPONENT = 'UnknownComponent',
  UNKNOWN_VARIABLE = 'UnknownVariable',
  NOT_SUPPORTED_ATTRIBUTE_TYPE = 'NotSupportedAttributeType',
}

export interface Ocpp201GetVariableResult extends Ocpp201ComponentVariable {
  attributeStatus: Ocpp201GetVariableStatus;
  attributeType?: string;
  attributeValue?: string;
}

export interface Ocpp201GetVariablesResponse {
  getVariableResult: Ocpp201GetVariableResult[];
}

export enum Ocpp201SetVariableStatus {
  ACCEPTED = 'Accepted',
  REJECTED = 'Rejected',
  UNKNOWN_COMPONENT = 'UnknownComponent',
  UNKNOWN_VARIABLE = 'UnknownVariable',
  NOT_SUPPORTED_ATTRIBUTE_TYPE = 'NotSupportedAttributeType',
  REBOOT_REQUIRED = 'RebootRequired',
}

export interface Ocpp201SetVariableResult extends Ocpp201ComponentVariable {
  attributeStatus: Ocpp201SetVariableStatus;
  attributeType?: string;
}

export interface Ocpp201SetVariablesResponse {
  setVariableResult: Ocpp201SetVariableResult[];
}

// --------------------------------------------------------------------------
// Persisted mapping between an OCPP 2.0.1 transaction and the platform transaction
// --------------------------------------------------------------------------
export interface Ocpp201TransactionMapping {
  id: string; // '<chargingStationID>~<transactionId>'
  chargingStationID: string;
  transactionId: string;
  evseId?: number;
  connectorId?: number;
  platformTransactionID?: number;
  idToken?: string;
  idTokenType?: string;
  authorizationStatus?: Ocpp201AuthorizationStatus;
  remoteStartId?: number;
  startedAt?: Date;
  meterStartWh?: number;
  lastMeterWh?: number;
  meterStartUnknown?: boolean;
  chargingState?: Ocpp201ChargingState;
  lastSeqNo?: number;
  lastEventTimestamp?: string;
  ended: boolean;
  endedAt?: Date;
  createdOn: Date;
  lastChangedOn: Date;
}
