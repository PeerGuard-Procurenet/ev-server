import { ChargePointErrorCode, ChargePointStatus, OCPPAuthorizationStatus, OCPPAuthorizeRequestExtended, OCPPBootNotificationRequestExtended, OCPPDataTransferRequestExtended, OCPPDiagnosticsStatusNotificationRequestExtended, OCPPFirmwareStatusNotificationRequestExtended, OCPPHeartbeatRequestExtended, OCPPMeterValuesRequestExtended, OCPPProtocol, OCPPStartTransactionRequestExtended, OCPPStatusNotificationRequestExtended, OCPPStopTransactionRequestExtended, OCPPVersion, RegistrationStatus } from '../../../types/ocpp/OCPPServer';
import { Ocpp201AuthorizationStatus, Ocpp201AuthorizeRequest, Ocpp201AuthorizeResponse, Ocpp201BootNotificationRequest, Ocpp201BootNotificationResponse, Ocpp201ConnectorStatus, Ocpp201DataTransferRequest, Ocpp201DataTransferResponse, Ocpp201DataTransferStatus, Ocpp201ErrorCode, Ocpp201FirmwareStatusNotificationRequest, Ocpp201IdTokenInfo, Ocpp201IdTokenType, Ocpp201IncomingAction, Ocpp201LogStatusNotificationRequest, Ocpp201MeterValuesRequest, Ocpp201Payload, Ocpp201RegistrationStatus, Ocpp201StatusNotificationRequest, Ocpp201TransactionEventRequest, Ocpp201TransactionEventResponse, Ocpp201TransactionEventType, Ocpp201TransactionMapping } from '../types/Ocpp201Types';
import { Ocpp201ConnectionIdentity, Ocpp201RequestHandler } from '../Ocpp201Connection';

import ChargingStationStorage from '../../../storage/mongodb/ChargingStationStorage';
import Configuration from '../../../utils/Configuration';
import { OCPPHeader } from '../../../types/ocpp/OCPPHeader';
import OCPPService from '../../ocpp/services/OCPPService';
import OCPPUtils from '../../ocpp/utils/OCPPUtils';
import Ocpp201Error from '../Ocpp201Error';
import Ocpp201EvseStateManager from '../mapping/Ocpp201EvseStateManager';
import Ocpp201Logger from '../Ocpp201Logger';
import Ocpp201Mapper from '../mapping/Ocpp201Mapper';
import Ocpp201TransactionStorage from '../storage/Ocpp201TransactionStorage';
import { ServerAction } from '../../../types/Server';
import Tenant from '../../../types/Tenant';
import TransactionStorage from '../../../storage/mongodb/TransactionStorage';
import Utils from '../../../utils/Utils';

const MODULE_NAME = 'Ocpp201ChargingStationService';

const TRANSACTION_BEGIN = 'Transaction.Begin';

// Handles the requests of an OCPP 2.0.1 Charging Station by translating them into the platform business logic (OCPPService)
export default class Ocpp201ChargingStationService implements Ocpp201RequestHandler {
  private readonly identity: Ocpp201ConnectionIdentity;
  private readonly ocppService: OCPPService;
  private bootRejected = false;
  private evseStatesRestored = false;
  private lastSeenUpdatedOn: number = null;

  public constructor(identity: Ocpp201ConnectionIdentity, ocppService: OCPPService) {
    this.identity = identity;
    this.ocppService = ocppService;
  }

  public async handleRequest(action: Ocpp201IncomingAction, payload: Ocpp201Payload): Promise<Ocpp201Payload> {
    // The Charging Station must not send other messages while its registration is rejected
    if (this.bootRejected && action !== Ocpp201IncomingAction.BOOT_NOTIFICATION) {
      throw new Ocpp201Error(Ocpp201ErrorCode.SECURITY_ERROR, 'Charging Station registration has been rejected, send a BootNotification first');
    }
    switch (action) {
      case Ocpp201IncomingAction.BOOT_NOTIFICATION:
        return this.handleBootNotification(payload as Ocpp201BootNotificationRequest);
      case Ocpp201IncomingAction.HEARTBEAT:
        return this.handleHeartbeat();
      case Ocpp201IncomingAction.STATUS_NOTIFICATION:
        return this.handleStatusNotification(payload as Ocpp201StatusNotificationRequest);
      case Ocpp201IncomingAction.AUTHORIZE:
        return this.handleAuthorize(payload as Ocpp201AuthorizeRequest);
      case Ocpp201IncomingAction.TRANSACTION_EVENT:
        return this.handleTransactionEvent(payload as Ocpp201TransactionEventRequest);
      case Ocpp201IncomingAction.METER_VALUES:
        return this.handleMeterValues(payload as Ocpp201MeterValuesRequest);
      case Ocpp201IncomingAction.FIRMWARE_STATUS_NOTIFICATION:
        return this.handleFirmwareStatusNotification(payload as Ocpp201FirmwareStatusNotificationRequest);
      case Ocpp201IncomingAction.LOG_STATUS_NOTIFICATION:
        return this.handleLogStatusNotification(payload as Ocpp201LogStatusNotificationRequest);
      case Ocpp201IncomingAction.DATA_TRANSFER:
        return this.handleDataTransfer(payload as Ocpp201DataTransferRequest);
      case Ocpp201IncomingAction.SECURITY_EVENT_NOTIFICATION:
        await this.checkChargingStation();
        this.log('warning', ServerAction.WS_SERVER_MESSAGE, `Security event '${payload.type as string}' received`, { payload });
        return {};
      case Ocpp201IncomingAction.NOTIFY_EVENT:
      case Ocpp201IncomingAction.NOTIFY_REPORT:
      case Ocpp201IncomingAction.NOTIFY_MONITORING_REPORT:
      case Ocpp201IncomingAction.NOTIFY_CUSTOMER_INFORMATION:
      case Ocpp201IncomingAction.NOTIFY_DISPLAY_MESSAGES:
      case Ocpp201IncomingAction.NOTIFY_CHARGING_LIMIT:
      case Ocpp201IncomingAction.CLEARED_CHARGING_LIMIT:
      case Ocpp201IncomingAction.REPORT_CHARGING_PROFILES:
      case Ocpp201IncomingAction.RESERVATION_STATUS_UPDATE:
      case Ocpp201IncomingAction.PUBLISH_FIRMWARE_STATUS_NOTIFICATION:
        // Informative messages: acknowledged and logged
        await this.checkChargingStation();
        this.log('info', ServerAction.WS_SERVER_MESSAGE, `'${action}' has been received`, { payload });
        return {};
      case Ocpp201IncomingAction.NOTIFY_EV_CHARGING_NEEDS:
      case Ocpp201IncomingAction.NOTIFY_EV_CHARGING_SCHEDULE:
      case Ocpp201IncomingAction.SIGN_CERTIFICATE:
        // Smart Charging (ISO 15118) and certificate management are not supported
        await this.checkChargingStation();
        this.log('info', ServerAction.WS_SERVER_MESSAGE, `'${action}' is not supported and has been rejected`, { payload });
        return { status: 'Rejected' };
      case Ocpp201IncomingAction.GET_15118_EV_CERTIFICATE:
        await this.checkChargingStation();
        this.log('info', ServerAction.WS_SERVER_MESSAGE, `'${action}' is not supported and has been rejected`, { payload });
        return { status: 'Failed', exiResponse: '' };
      case Ocpp201IncomingAction.GET_CERTIFICATE_STATUS:
        await this.checkChargingStation();
        this.log('info', ServerAction.WS_SERVER_MESSAGE, `'${action}' is not supported and has been rejected`, { payload });
        return { status: 'Failed' };
      default:
        throw new Ocpp201Error(Ocpp201ErrorCode.NOT_SUPPORTED, `Action '${action as string}' is not supported`);
    }
  }

  // Keep the 'last seen' date of the Charging Station up to date on WebSocket ping/pong
  public async onKeepAlive(): Promise<void> {
    const now = Date.now();
    const intervalMillis = Configuration.getChargingStationConfig().pingIntervalOCPPJSecs * 1000 / 2;
    if (this.lastSeenUpdatedOn && (now - this.lastSeenUpdatedOn) < intervalMillis) {
      return;
    }
    this.lastSeenUpdatedOn = now;
    const { tenant, chargingStation } = await OCPPUtils.checkAndGetChargingStationConnectionData(ServerAction.WS_SERVER_CONNECTION_PING,
      this.identity.tenantID, this.identity.chargingStationID, this.identity.tokenID, false);
    if (chargingStation) {
      await ChargingStationStorage.saveChargingStationRuntimeData(tenant, chargingStation.id, { lastSeen: new Date(now) });
    }
  }

  // ------------------------------------------------------------------------
  // Provisioning
  // ------------------------------------------------------------------------
  private async handleBootNotification(bootNotification: Ocpp201BootNotificationRequest): Promise<Ocpp201BootNotificationResponse> {
    const headers = await this.buildHeaders(ServerAction.OCPP_BOOT_NOTIFICATION);
    const result = await this.ocppService.handleBootNotification(headers,
      Ocpp201Mapper.mapBootNotification(bootNotification) as OCPPBootNotificationRequestExtended);
    this.bootRejected = result.status === RegistrationStatus.REJECTED;
    if (!this.bootRejected) {
      // All the connector statuses are sent again after a boot
      Ocpp201EvseStateManager.resetChargingStation(this.identity.tenantID, this.identity.chargingStationID);
      this.evseStatesRestored = false;
    }
    this.log('info', ServerAction.OCPP_BOOT_NOTIFICATION, `Boot Notification (reason '${bootNotification.reason}') has been answered with status '${result.status}'`,
      { bootNotification });
    return {
      currentTime: result.currentTime,
      interval: result.interval,
      status: result.status as unknown as Ocpp201RegistrationStatus,
    };
  }

  private async handleHeartbeat(): Promise<Ocpp201Payload> {
    const headers = await this.buildHeaders(ServerAction.OCPP_HEARTBEAT);
    const result = await this.ocppService.handleHeartbeat(headers, {} as OCPPHeartbeatRequestExtended);
    return { currentTime: result.currentTime };
  }

  // ------------------------------------------------------------------------
  // Availability
  // ------------------------------------------------------------------------
  private async handleStatusNotification(statusNotification: Ocpp201StatusNotificationRequest): Promise<Ocpp201Payload> {
    const headers = await this.buildHeaders(ServerAction.OCPP_STATUS_NOTIFICATION);
    if (statusNotification.evseId <= 0) {
      this.log('info', ServerAction.OCPP_STATUS_NOTIFICATION,
        `Status '${statusNotification.connectorStatus}' of EVSE ID '${statusNotification.evseId}' is ignored`, { statusNotification });
      return {};
    }
    await this.restoreEvseStates(headers.tenant);
    const evseState = Ocpp201EvseStateManager.getEvseState(this.identity.tenantID, this.identity.chargingStationID, statusNotification.evseId);
    evseState.connectorStatuses.set(statusNotification.connectorId, statusNotification.connectorStatus);
    if (Ocpp201EvseStateManager.getAggregatedConnectorStatus(evseState) !== Ocpp201ConnectorStatus.OCCUPIED) {
      // EV has left
      evseState.finishing = false;
    }
    await this.syncPlatformConnectorStatus(headers, statusNotification.evseId, statusNotification.timestamp);
    return {};
  }

  // ------------------------------------------------------------------------
  // Authorization
  // ------------------------------------------------------------------------
  private async handleAuthorize(authorize: Ocpp201AuthorizeRequest): Promise<Ocpp201AuthorizeResponse> {
    const headers = await this.buildHeaders(ServerAction.OCPP_AUTHORIZE);
    return { idTokenInfo: await this.authorize(headers, authorize.idToken?.idToken, Ocpp201Mapper.getPlatformTagID(authorize.idToken)) };
  }

  private async authorize(headers: OCPPHeader, idToken: string, tagID: string | null): Promise<Ocpp201IdTokenInfo> {
    if (!tagID) {
      this.log('warning', ServerAction.OCPP_AUTHORIZE, `ID Token '${idToken}' cannot be used to identify a user`);
      return { status: Ocpp201AuthorizationStatus.INVALID };
    }
    const result = await this.ocppService.handleAuthorize(headers, { idTag: tagID } as OCPPAuthorizeRequestExtended);
    return { status: Ocpp201Mapper.mapAuthorizationStatus(result.idTagInfo?.status) };
  }

  // ------------------------------------------------------------------------
  // Transactions
  // ------------------------------------------------------------------------
  private async handleTransactionEvent(transactionEvent: Ocpp201TransactionEventRequest): Promise<Ocpp201TransactionEventResponse> {
    const headers = await this.buildHeaders(ServerAction.WS_SERVER_MESSAGE);
    const tenant = headers.tenant;
    await this.restoreEvseStates(tenant);
    const transactionId = transactionEvent.transactionInfo.transactionId;
    const tagID = transactionEvent.idToken ? Ocpp201Mapper.getPlatformTagID(transactionEvent.idToken) : null;
    let mapping = await Ocpp201TransactionStorage.getMapping(tenant, this.identity.chargingStationID, transactionId);
    // Retransmitted message (same sequence number)
    if (mapping && mapping.lastSeqNo === transactionEvent.seqNo && mapping.lastEventTimestamp === transactionEvent.timestamp) {
      this.log('warning', ServerAction.WS_SERVER_MESSAGE, `Transaction Event '${transactionEvent.eventType}' with sequence number '${transactionEvent.seqNo}' of transaction '${transactionId}' has already been processed`,
        { transactionEvent });
      return this.buildTransactionEventResponse(transactionEvent, mapping, tagID);
    }
    // Transaction already ended
    if (mapping?.ended) {
      this.log('warning', ServerAction.WS_SERVER_MESSAGE, `Transaction Event '${transactionEvent.eventType}' received for transaction '${transactionId}' which has already ended`,
        { transactionEvent });
      return this.buildTransactionEventResponse(transactionEvent, mapping, tagID);
    }
    if (!mapping) {
      mapping = {
        id: Ocpp201TransactionStorage.buildMappingID(this.identity.chargingStationID, transactionId),
        chargingStationID: this.identity.chargingStationID,
        transactionId,
        ended: false,
        createdOn: new Date(),
        lastChangedOn: new Date(),
      };
    }
    this.updateMappingWithTransactionEvent(headers, mapping, transactionEvent);
    // Transaction started remotely: the Charging Station may only send the remoteStartId, not the ID Token
    let startTagID = tagID;
    if (!startTagID && !mapping.platformTransactionID && !mapping.authorizationStatus && !Utils.isNullOrUndefined(mapping.remoteStartId)) {
      const remoteStart = await Ocpp201TransactionStorage.getRemoteStart(tenant, this.identity.chargingStationID, mapping.remoteStartId);
      if (remoteStart) {
        startTagID = remoteStart.tagID;
        if (Utils.isNullOrUndefined(mapping.evseId) && remoteStart.evseId > 0) {
          mapping.evseId = remoteStart.evseId;
        }
      } else {
        this.log('warning', ServerAction.WS_SERVER_MESSAGE,
          `Remote start ID '${mapping.remoteStartId}' of transaction '${transactionId}' is unknown, waiting for an ID Token`, { transactionEvent });
      }
    }
    if (Utils.isNullOrUndefined(mapping.evseId)) {
      // The EVSE is mandatory in the first Transaction Event of a transaction
      this.log('error', ServerAction.WS_SERVER_MESSAGE, `Transaction '${transactionId}' cannot be processed: EVSE is unknown`, { transactionEvent });
      mapping.lastSeqNo = transactionEvent.seqNo;
      mapping.lastEventTimestamp = transactionEvent.timestamp;
      await Ocpp201TransactionStorage.saveMapping(tenant, mapping);
      return transactionEvent.idToken ? { idTokenInfo: await this.authorize(headers, transactionEvent.idToken.idToken, tagID) } : {};
    }
    let idTokenInfo: Ocpp201IdTokenInfo;
    // Start the platform transaction as soon as the user is identified
    if (!mapping.platformTransactionID && startTagID &&
        !(mapping.authorizationStatus && Ocpp201Mapper.isSameTagID(mapping.idToken, startTagID))) {
      mapping.idToken = startTagID;
      mapping.idTokenType = transactionEvent.idToken?.type ?? Ocpp201IdTokenType.CENTRAL;
      mapping.authorizationStatus = await this.startPlatformTransaction(headers, mapping);
      // The ID Token Info is only returned for the ID Token of the request
      if (transactionEvent.idToken) {
        idTokenInfo = { status: mapping.authorizationStatus };
      }
      // Keep the link with the platform transaction right away
      await Ocpp201TransactionStorage.saveMapping(tenant, mapping);
    } else if (transactionEvent.idToken) {
      idTokenInfo = await this.getIdTokenInfo(headers, transactionEvent, mapping, tagID);
    }
    // Meter Values
    if (mapping.platformTransactionID && !Utils.isEmptyArray(transactionEvent.meterValue)) {
      await this.processTransactionMeterValues(headers, mapping, transactionEvent);
    }
    // EVSE state
    const evseState = Ocpp201EvseStateManager.getEvseState(this.identity.tenantID, this.identity.chargingStationID, mapping.evseId);
    if (transactionEvent.eventType === Ocpp201TransactionEventType.ENDED) {
      if (mapping.platformTransactionID) {
        await this.stopPlatformTransaction(headers, mapping, transactionEvent, tagID);
        evseState.finishing = Ocpp201EvseStateManager.getAggregatedConnectorStatus(evseState) === Ocpp201ConnectorStatus.OCCUPIED;
      }
      mapping.ended = true;
      mapping.endedAt = new Date(transactionEvent.timestamp);
      if (evseState.transactionId === transactionId) {
        delete evseState.transactionId;
        delete evseState.platformTransactionID;
        delete evseState.chargingState;
      }
    } else {
      evseState.transactionId = transactionId;
      evseState.platformTransactionID = mapping.platformTransactionID;
      evseState.chargingState = mapping.chargingState;
      evseState.finishing = false;
    }
    mapping.lastSeqNo = transactionEvent.seqNo;
    mapping.lastEventTimestamp = transactionEvent.timestamp;
    await Ocpp201TransactionStorage.saveMapping(tenant, mapping);
    await this.syncPlatformConnectorStatus(headers, mapping.evseId, transactionEvent.timestamp);
    return idTokenInfo ? { idTokenInfo } : {};
  }

  private updateMappingWithTransactionEvent(headers: OCPPHeader, mapping: Ocpp201TransactionMapping,
      transactionEvent: Ocpp201TransactionEventRequest): void {
    if (Utils.isNullOrUndefined(mapping.evseId)) {
      if (transactionEvent.evse?.id > 0) {
        mapping.evseId = transactionEvent.evse.id;
        mapping.connectorId = transactionEvent.evse.connectorId;
      } else if (headers.chargingStation?.connectors?.length === 1) {
        // Single connector Charging Station
        mapping.evseId = headers.chargingStation.connectors[0].connectorId;
      }
    } else if (Utils.isNullOrUndefined(mapping.connectorId) && !Utils.isNullOrUndefined(transactionEvent.evse?.connectorId)) {
      mapping.connectorId = transactionEvent.evse.connectorId;
    }
    if (transactionEvent.transactionInfo.chargingState) {
      mapping.chargingState = transactionEvent.transactionInfo.chargingState;
    }
    if (!Utils.isNullOrUndefined(transactionEvent.transactionInfo.remoteStartId)) {
      mapping.remoteStartId = transactionEvent.transactionInfo.remoteStartId;
    }
    if (!mapping.startedAt) {
      // Transaction start: Transaction.Begin meter value or first event received
      const beginTimestamp = Ocpp201Mapper.findEarliestTimestamp(transactionEvent.meterValue, TRANSACTION_BEGIN);
      mapping.startedAt = new Date(beginTimestamp && new Date(beginTimestamp).getTime() < new Date(transactionEvent.timestamp).getTime() ?
        beginTimestamp : transactionEvent.timestamp);
    }
    if (Utils.isNullOrUndefined(mapping.meterStartWh)) {
      const beginReading = Ocpp201Mapper.findEnergyRegisterReading(transactionEvent.meterValue, 'first', TRANSACTION_BEGIN) ??
        (transactionEvent.eventType === Ocpp201TransactionEventType.STARTED ?
          Ocpp201Mapper.findEnergyRegisterReading(transactionEvent.meterValue, 'first') : null);
      if (beginReading) {
        mapping.meterStartWh = beginReading.valueWh;
      }
    }
    const lastReading = Ocpp201Mapper.findEnergyRegisterReading(transactionEvent.meterValue, 'last');
    if (lastReading) {
      mapping.lastMeterWh = lastReading.valueWh;
    }
  }

  private async getIdTokenInfo(headers: OCPPHeader, transactionEvent: Ocpp201TransactionEventRequest,
      mapping: Ocpp201TransactionMapping, tagID: string | null): Promise<Ocpp201IdTokenInfo> {
    if (tagID && Ocpp201Mapper.isSameTagID(mapping.idToken, tagID)) {
      if (mapping.platformTransactionID) {
        return { status: Ocpp201AuthorizationStatus.ACCEPTED };
      }
      if (mapping.authorizationStatus) {
        return { status: mapping.authorizationStatus };
      }
    }
    // Another ID Token (e.g. used to stop the transaction)
    return this.authorize(headers, transactionEvent.idToken.idToken, tagID);
  }

  private async buildTransactionEventResponse(transactionEvent: Ocpp201TransactionEventRequest,
      mapping: Ocpp201TransactionMapping, tagID: string | null): Promise<Ocpp201TransactionEventResponse> {
    if (!transactionEvent.idToken) {
      return {};
    }
    const headers = await this.buildHeaders(ServerAction.OCPP_AUTHORIZE);
    return { idTokenInfo: await this.getIdTokenInfo(headers, transactionEvent, mapping, tagID) };
  }

  private async startPlatformTransaction(headers: OCPPHeader, mapping: Ocpp201TransactionMapping): Promise<Ocpp201AuthorizationStatus> {
    // The connector must exist in the platform
    if (!Utils.getConnectorFromID(headers.chargingStation, mapping.evseId)) {
      await this.ocppService.handleStatusNotification(headers, {
        connectorId: mapping.evseId,
        status: ChargePointStatus.PREPARING,
        errorCode: ChargePointErrorCode.NO_ERROR,
        timestamp: mapping.startedAt.toISOString(),
      } as OCPPStatusNotificationRequestExtended);
      const evseState = Ocpp201EvseStateManager.getEvseState(this.identity.tenantID, this.identity.chargingStationID, mapping.evseId);
      evseState.lastPlatformStatus = ChargePointStatus.PREPARING;
    }
    let meterStart = mapping.meterStartWh ?? mapping.lastMeterWh;
    mapping.meterStartUnknown = Utils.isNullOrUndefined(meterStart);
    if (mapping.meterStartUnknown) {
      meterStart = 0;
    }
    const result = await this.ocppService.handleStartTransaction(headers, {
      connectorId: mapping.evseId,
      idTag: mapping.idToken,
      meterStart,
      timestamp: mapping.startedAt.toISOString(),
    } as OCPPStartTransactionRequestExtended);
    if (result.transactionId > 0 && result.idTagInfo?.status === OCPPAuthorizationStatus.ACCEPTED) {
      mapping.platformTransactionID = result.transactionId;
      this.log('info', ServerAction.OCPP_START_TRANSACTION,
        `OCPP 2.0.1 transaction '${mapping.transactionId}' on EVSE '${mapping.evseId}' is linked to transaction ID '${result.transactionId}'`);
      return Ocpp201AuthorizationStatus.ACCEPTED;
    }
    const status = Ocpp201Mapper.mapAuthorizationStatus(result.idTagInfo?.status);
    // Never accept a transaction that could not be created
    return status === Ocpp201AuthorizationStatus.ACCEPTED ? Ocpp201AuthorizationStatus.INVALID : status;
  }

  private async processTransactionMeterValues(headers: OCPPHeader, mapping: Ocpp201TransactionMapping,
      transactionEvent: Ocpp201TransactionEventRequest): Promise<void> {
    // The transaction has been started without meter reading: start the consumption from the first reading
    if (mapping.meterStartUnknown) {
      const firstReading = Ocpp201Mapper.findEnergyRegisterReading(transactionEvent.meterValue, 'first');
      if (firstReading) {
        const transaction = await TransactionStorage.getTransaction(headers.tenant, mapping.platformTransactionID);
        if (transaction && !transaction.stop && !transaction.numberOfMeterValues) {
          transaction.meterStart = firstReading.valueWh;
          transaction.lastConsumption = { value: firstReading.valueWh, timestamp: transaction.timestamp };
          await TransactionStorage.saveTransaction(headers.tenant, transaction);
        }
        mapping.meterStartUnknown = false;
      }
    }
    const meterValues = Ocpp201Mapper.convertMeterValues(transactionEvent.meterValue);
    if (Utils.isEmptyArray(meterValues)) {
      return;
    }
    await this.ocppService.handleMeterValues(headers, {
      connectorId: mapping.evseId,
      transactionId: mapping.platformTransactionID,
      meterValue: meterValues,
    } as OCPPMeterValuesRequestExtended);
  }

  private async stopPlatformTransaction(headers: OCPPHeader, mapping: Ocpp201TransactionMapping,
      transactionEvent: Ocpp201TransactionEventRequest, tagID: string | null): Promise<void> {
    let meterStop = mapping.lastMeterWh;
    if (Utils.isNullOrUndefined(meterStop)) {
      const transaction = await TransactionStorage.getTransaction(headers.tenant, mapping.platformTransactionID);
      meterStop = transaction?.lastConsumption?.value ?? mapping.meterStartWh ?? 0;
    }
    const stopTransaction = {
      transactionId: mapping.platformTransactionID,
      meterStop,
      timestamp: transactionEvent.timestamp,
      reason: Ocpp201Mapper.mapStoppedReason(transactionEvent.transactionInfo.stoppedReason),
    } as OCPPStopTransactionRequestExtended;
    if (tagID) {
      stopTransaction.idTag = tagID;
    }
    const result = await this.ocppService.handleStopTransaction(headers, stopTransaction);
    this.log(result.idTagInfo?.status === OCPPAuthorizationStatus.ACCEPTED ? 'info' : 'error', ServerAction.OCPP_STOP_TRANSACTION,
      `OCPP 2.0.1 transaction '${mapping.transactionId}' ended (reason '${transactionEvent.transactionInfo.stoppedReason ?? 'Local'}'), stop of transaction ID '${mapping.platformTransactionID}': '${result.idTagInfo?.status}'`);
  }

  // Meter values sent outside of a transaction
  private async handleMeterValues(meterValues: Ocpp201MeterValuesRequest): Promise<Ocpp201Payload> {
    await this.checkChargingStation();
    this.log('debug', ServerAction.OCPP_METER_VALUES, `Meter Values of EVSE ID '${meterValues.evseId}' received outside of a transaction`, { meterValues });
    return {};
  }

  // ------------------------------------------------------------------------
  // Firmware, Diagnostics and Data Transfer
  // ------------------------------------------------------------------------
  private async handleFirmwareStatusNotification(firmwareStatusNotification: Ocpp201FirmwareStatusNotificationRequest): Promise<Ocpp201Payload> {
    const headers = await this.buildHeaders(ServerAction.OCPP_FIRMWARE_STATUS_NOTIFICATION);
    await this.ocppService.handleFirmwareStatusNotification(headers, {
      status: Ocpp201Mapper.mapFirmwareStatus(firmwareStatusNotification.status),
    } as OCPPFirmwareStatusNotificationRequestExtended);
    return {};
  }

  private async handleLogStatusNotification(logStatusNotification: Ocpp201LogStatusNotificationRequest): Promise<Ocpp201Payload> {
    const headers = await this.buildHeaders(ServerAction.OCPP_DIAGNOSTICS_STATUS_NOTIFICATION);
    await this.ocppService.handleDiagnosticsStatusNotification(headers, {
      status: Ocpp201Mapper.mapLogStatus(logStatusNotification.status),
    } as OCPPDiagnosticsStatusNotificationRequestExtended);
    return {};
  }

  private async handleDataTransfer(dataTransfer: Ocpp201DataTransferRequest): Promise<Ocpp201DataTransferResponse> {
    const headers = await this.buildHeaders(ServerAction.OCPP_DATA_TRANSFER);
    const result = await this.ocppService.handleDataTransfer(headers,
      Ocpp201Mapper.mapDataTransfer(dataTransfer) as OCPPDataTransferRequestExtended);
    return { status: result.status as unknown as Ocpp201DataTransferStatus };
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------
  private async buildHeaders(action: ServerAction): Promise<OCPPHeader> {
    let connectionData: Awaited<ReturnType<typeof OCPPUtils.checkAndGetChargingStationConnectionData>>;
    try {
      connectionData = await OCPPUtils.checkAndGetChargingStationConnectionData(action,
        this.identity.tenantID, this.identity.chargingStationID, this.identity.tokenID);
    } catch (error) {
      throw new Ocpp201Error(Ocpp201ErrorCode.SECURITY_ERROR, (error as Error).message);
    }
    return {
      chargeBoxIdentity: this.identity.chargingStationID,
      ocppVersion: OCPPVersion.VERSION_201,
      ocppProtocol: OCPPProtocol.JSON,
      chargingStationURL: Configuration.getJsonEndpointConfig().baseSecureUrl,
      tenantID: this.identity.tenantID,
      tokenID: this.identity.tokenID,
      currentIPAddress: this.identity.clientIP,
      From: { Address: this.identity.clientIP },
      tenant: connectionData.tenant,
      chargingStation: connectionData.chargingStation,
      token: connectionData.token,
    };
  }

  // Only a registered Charging Station can send messages other than the Boot Notification
  private async checkChargingStation(): Promise<void> {
    const headers = await this.buildHeaders(ServerAction.WS_SERVER_MESSAGE);
    if (!headers.chargingStation) {
      throw new Ocpp201Error(Ocpp201ErrorCode.SECURITY_ERROR, 'Charging Station is not registered, send a BootNotification first');
    }
  }

  // Rebuild the EVSE transaction states from the database (e.g. after a server restart), the most recent transaction wins
  private async restoreEvseStates(tenant: Tenant): Promise<void> {
    if (this.evseStatesRestored) {
      return;
    }
    const mappings = await Ocpp201TransactionStorage.getOngoingMappingsOfChargingStation(tenant, this.identity.chargingStationID);
    for (const mapping of mappings) {
      if (Utils.isNullOrUndefined(mapping.evseId)) {
        continue;
      }
      const evseState = Ocpp201EvseStateManager.getEvseState(this.identity.tenantID, this.identity.chargingStationID, mapping.evseId);
      if (!evseState.transactionId) {
        evseState.transactionId = mapping.transactionId;
        evseState.platformTransactionID = mapping.platformTransactionID;
        evseState.chargingState = mapping.chargingState;
      }
    }
    this.evseStatesRestored = true;
  }

  // Report the EVSE status to the platform when it changes
  private async syncPlatformConnectorStatus(headers: OCPPHeader, evseId: number, timestamp: string): Promise<void> {
    const evseState = Ocpp201EvseStateManager.getEvseState(this.identity.tenantID, this.identity.chargingStationID, evseId);
    const platformStatus = Ocpp201EvseStateManager.computePlatformStatus(evseState);
    if (!platformStatus || platformStatus.status === evseState.lastPlatformStatus) {
      return;
    }
    await this.ocppService.handleStatusNotification(headers, {
      connectorId: evseId,
      status: platformStatus.status,
      errorCode: platformStatus.errorCode,
      timestamp,
    } as OCPPStatusNotificationRequestExtended);
    evseState.lastPlatformStatus = platformStatus.status;
  }

  private log(level: 'debug' | 'info' | 'warning' | 'error', action: ServerAction, message: string, detailedMessages?: Record<string, unknown>): void {
    Ocpp201Logger[level]({
      tenantID: this.identity.tenantID,
      chargingStationID: this.identity.chargingStationID,
      action, module: MODULE_NAME, method: 'handleRequest',
      message, detailedMessages
    });
  }
}
