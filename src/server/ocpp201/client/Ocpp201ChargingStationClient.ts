import { OCPPAvailabilityStatus, OCPPCancelReservationResponse, OCPPCancelReservationStatus, OCPPChangeAvailabilityRequest, OCPPChangeAvailabilityResponse, OCPPChangeConfigurationRequest, OCPPChangeConfigurationResponse, OCPPChargingProfileStatus, OCPPClearCacheResponse, OCPPClearCacheStatus, OCPPClearChargingProfileResponse, OCPPClearChargingProfileStatus, OCPPConfigurationStatus, OCPPDataTransferRequest, OCPPDataTransferResponse, OCPPGetCompositeScheduleResponse, OCPPGetCompositeScheduleStatus, OCPPGetConfigurationRequest, OCPPGetConfigurationResponse, OCPPGetDiagnosticsRequest, OCPPGetDiagnosticsResponse, OCPPRemoteStartStopStatus, OCPPRemoteStartTransactionRequest, OCPPRemoteStartTransactionResponse, OCPPRemoteStopTransactionRequest, OCPPRemoteStopTransactionResponse, OCPPReserveNowResponse, OCPPReserveNowStatus, OCPPResetRequest, OCPPResetResponse, OCPPResetStatus, OCPPResetType, OCPPSetChargingProfileResponse, OCPPUnlockConnectorRequest, OCPPUnlockConnectorResponse, OCPPUnlockStatus, OCPPUpdateFirmwareRequest } from '../../../types/ocpp/OCPPClient';
import { Ocpp201ComponentVariable, Ocpp201GetVariableStatus, Ocpp201GetVariablesResponse, Ocpp201IdTokenType, Ocpp201OutgoingAction, Ocpp201Payload, Ocpp201SetVariablesResponse } from '../types/Ocpp201Types';
import Ocpp201Mapper, { OCPP201_STANDARD_CONFIGURATION_VARIABLES } from '../mapping/Ocpp201Mapper';

import ChargingStationClient from '../../../client/ocpp/ChargingStationClient';
import Logging from '../../../utils/Logging';
import { OCPPDataTransferStatus } from '../../../types/ocpp/OCPPServer';
import Ocpp201Connection from '../Ocpp201Connection';
import Ocpp201Error from '../Ocpp201Error';
import Ocpp201EvseStateManager from '../mapping/Ocpp201EvseStateManager';
import Ocpp201Logger from '../Ocpp201Logger';
import Ocpp201TransactionStorage from '../storage/Ocpp201TransactionStorage';
import { OcppParameter } from '../../../types/ChargingStation';
import { ServerAction } from '../../../types/Server';
import Tenant from '../../../types/Tenant';
import Utils from '../../../utils/Utils';

const MODULE_NAME = 'Ocpp201ChargingStationClient';

// Number of variables requested per GetVariables when the Charging Station does not report its limit
const DEFAULT_ITEMS_PER_GET_VARIABLES = 10;
const MAX_ATTRIBUTE_VALUE_LENGTH = 1000;

// Executes the platform commands (OCPP 1.6 semantic) on an OCPP 2.0.1 Charging Station
export default class Ocpp201ChargingStationClient extends ChargingStationClient {
  private readonly connection: Ocpp201Connection;
  private readonly tenant: Tenant;

  public constructor(connection: Ocpp201Connection, tenant: Tenant) {
    super();
    this.connection = connection;
    this.tenant = tenant;
  }

  private static generateRequestID(): number {
    // Positive 32 bits integer
    return Math.floor(Math.random() * 2147483646) + 1;
  }

  public getChargingStationID(): string {
    return this.connection.identity.chargingStationID;
  }

  public async reset(params: OCPPResetRequest): Promise<OCPPResetResponse> {
    const response = await this.send(Ocpp201OutgoingAction.RESET, {
      type: params.type === OCPPResetType.HARD ? 'Immediate' : 'OnIdle',
    });
    // 'Scheduled': the reset will be done once the ongoing transactions are finished
    return { status: response.status === 'Rejected' ? OCPPResetStatus.REJECTED : OCPPResetStatus.ACCEPTED };
  }

  public async clearCache(): Promise<OCPPClearCacheResponse> {
    const response = await this.send(Ocpp201OutgoingAction.CLEAR_CACHE, {});
    return { status: response.status === 'Accepted' ? OCPPClearCacheStatus.ACCEPTED : OCPPClearCacheStatus.REJECTED };
  }

  public async dataTransfer(params: OCPPDataTransferRequest): Promise<OCPPDataTransferResponse> {
    const request: Ocpp201Payload = { vendorId: params.vendorId };
    if (params.messageId) {
      request.messageId = params.messageId;
    }
    if (!Utils.isNullOrUndefined(params.data)) {
      request.data = params.data;
    }
    const response = await this.send(Ocpp201OutgoingAction.DATA_TRANSFER, request);
    const statuses = Object.values(OCPPDataTransferStatus) as string[];
    return {
      status: statuses.includes(response.status as string) ? response.status as OCPPDataTransferStatus : OCPPDataTransferStatus.REJECTED
    };
  }

  // Keys are either OCPP 1.6 standard keys (mapped to the device model) or 'Component.Variable' (see Ocpp201Mapper.buildConfigurationKey)
  public async getConfiguration(params: OCPPGetConfigurationRequest = {}): Promise<OCPPGetConfigurationResponse> {
    const configurationKey: OcppParameter[] = [];
    const unknownKey: string[] = [];
    // Requested key per device model variable key
    const requestedKeys = new Map<string, string>();
    const componentVariables: Ocpp201ComponentVariable[] = [];
    if (params.key?.length > 0) {
      for (const key of params.key) {
        const componentVariable = Ocpp201Mapper.parseConfigurationKey(key);
        if (componentVariable) {
          requestedKeys.set(Ocpp201Mapper.buildConfigurationKey(componentVariable), key);
          componentVariables.push(componentVariable);
        } else {
          unknownKey.push(key);
        }
      }
    } else {
      for (const componentVariable of OCPP201_STANDARD_CONFIGURATION_VARIABLES) {
        const key = Ocpp201Mapper.buildConfigurationKey(componentVariable);
        requestedKeys.set(key, key);
        componentVariables.push(componentVariable);
      }
    }
    const results = await this.getVariables(componentVariables);
    for (const result of results) {
      const builtKey = Ocpp201Mapper.buildConfigurationKey(result);
      const key = requestedKeys.get(builtKey) ?? builtKey;
      if (result.attributeStatus === Ocpp201GetVariableStatus.ACCEPTED) {
        configurationKey.push({ key, value: result.attributeValue ?? '', readonly: false });
      } else if (params.key?.length > 0) {
        unknownKey.push(key);
      }
    }
    return { configurationKey, unknownKey };
  }

  public async changeConfiguration(params: OCPPChangeConfigurationRequest): Promise<OCPPChangeConfigurationResponse> {
    const componentVariable = Ocpp201Mapper.parseConfigurationKey(params.key);
    if (!componentVariable) {
      return { status: OCPPConfigurationStatus.NOT_SUPPORTED };
    }
    const value = Utils.isNullOrUndefined(params.value) ? '' : String(params.value);
    if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      return { status: OCPPConfigurationStatus.REJECTED };
    }
    const response = await this.send(Ocpp201OutgoingAction.SET_VARIABLES, {
      setVariableData: [{ ...componentVariable, attributeValue: value }],
    }) as Ocpp201SetVariablesResponse;
    const result = response.setVariableResult?.[0];
    if (!result) {
      return { status: OCPPConfigurationStatus.REJECTED };
    }
    return { status: Ocpp201Mapper.mapSetVariableStatus(result.attributeStatus) };
  }

  public async remoteStartTransaction(params: OCPPRemoteStartTransactionRequest): Promise<OCPPRemoteStartTransactionResponse> {
    if (params.chargingProfile) {
      this.log('warning', ServerAction.WS_SERVER_MESSAGE, 'Charging profile of the Remote Start is not supported in OCPP 2.0.1 and has been ignored',
        { chargingProfile: params.chargingProfile });
    }
    const request: Ocpp201Payload = {
      idToken: { idToken: params.idTag, type: Ocpp201IdTokenType.CENTRAL },
      remoteStartId: Ocpp201ChargingStationClient.generateRequestID(),
    };
    if (params.connectorId > 0) {
      request.evseId = params.connectorId;
    }
    // Keep the tag before sending: the Charging Station may report the transaction (with the remoteStartId only)
    // before answering this request
    await Ocpp201TransactionStorage.saveRemoteStart(this.tenant, {
      id: Ocpp201TransactionStorage.buildRemoteStartID(this.getChargingStationID(), request.remoteStartId),
      chargingStationID: this.getChargingStationID(),
      remoteStartId: request.remoteStartId,
      tagID: params.idTag,
      evseId: request.evseId,
      createdOn: new Date(),
    });
    const response = await this.send(Ocpp201OutgoingAction.REQUEST_START_TRANSACTION, request);
    return { status: response.status === 'Accepted' ? OCPPRemoteStartStopStatus.ACCEPTED : OCPPRemoteStartStopStatus.REJECTED };
  }

  public async remoteStopTransaction(params: OCPPRemoteStopTransactionRequest): Promise<OCPPRemoteStopTransactionResponse> {
    const mapping = await Ocpp201TransactionStorage.getMappingByPlatformTransactionID(
      this.tenant, this.getChargingStationID(), params.transactionId);
    if (!mapping || mapping.ended) {
      this.log('warning', ServerAction.WS_SERVER_MESSAGE, `No ongoing OCPP 2.0.1 transaction found for transaction ID '${params.transactionId}'`);
      return { status: OCPPRemoteStartStopStatus.REJECTED };
    }
    const response = await this.send(Ocpp201OutgoingAction.REQUEST_STOP_TRANSACTION, { transactionId: mapping.transactionId });
    return { status: response.status === 'Accepted' ? OCPPRemoteStartStopStatus.ACCEPTED : OCPPRemoteStartStopStatus.REJECTED };
  }

  public async unlockConnector(params: OCPPUnlockConnectorRequest): Promise<OCPPUnlockConnectorResponse> {
    const response = await this.send(Ocpp201OutgoingAction.UNLOCK_CONNECTOR, {
      evseId: params.connectorId,
      connectorId: this.getPhysicalConnectorID(params.connectorId),
    });
    switch (response.status) {
      case 'Unlocked':
        return { status: OCPPUnlockStatus.UNLOCKED };
      case 'UnknownConnector':
        return { status: OCPPUnlockStatus.NOT_SUPPORTED };
      default:
        return { status: OCPPUnlockStatus.UNLOCK_FAILED };
    }
  }

  public async changeAvailability(params: OCPPChangeAvailabilityRequest): Promise<OCPPChangeAvailabilityResponse> {
    const request: Ocpp201Payload = { operationalStatus: params.type };
    if (params.connectorId > 0) {
      request.evse = { id: params.connectorId };
    }
    const response = await this.send(Ocpp201OutgoingAction.CHANGE_AVAILABILITY, request);
    switch (response.status) {
      case 'Accepted':
        return { status: OCPPAvailabilityStatus.ACCEPTED };
      case 'Scheduled':
        return { status: OCPPAvailabilityStatus.SCHEDULED };
      default:
        return { status: OCPPAvailabilityStatus.REJECTED };
    }
  }

  public async getDiagnostics(params: OCPPGetDiagnosticsRequest): Promise<OCPPGetDiagnosticsResponse> {
    const log: Ocpp201Payload = { remoteLocation: params.location };
    if (params.startTime) {
      log.oldestTimestamp = new Date(params.startTime).toISOString();
    }
    if (params.stopTime) {
      log.latestTimestamp = new Date(params.stopTime).toISOString();
    }
    const request: Ocpp201Payload = {
      logType: 'DiagnosticsLog',
      requestId: Ocpp201ChargingStationClient.generateRequestID(),
      log,
    };
    if (Number.isInteger(params.retries)) {
      request.retries = params.retries;
    }
    if (Number.isInteger(params.retryInterval)) {
      request.retryInterval = params.retryInterval;
    }
    const response = await this.send(Ocpp201OutgoingAction.GET_LOG, request);
    if (response.status !== 'Accepted') {
      this.log('warning', ServerAction.WS_SERVER_MESSAGE, `Get Log has been answered with status '${response.status as string}'`, { response });
      return {};
    }
    return response.filename ? { fileName: response.filename } : {};
  }

  public async updateFirmware(params: OCPPUpdateFirmwareRequest): Promise<void> {
    const request: Ocpp201Payload = {
      requestId: Ocpp201ChargingStationClient.generateRequestID(),
      firmware: {
        location: params.location,
        retrieveDateTime: new Date(params.retrieveDate ?? new Date()).toISOString(),
      },
    };
    if (Number.isInteger(params.retries)) {
      request.retries = params.retries;
    }
    if (Number.isInteger(params.retryInterval)) {
      request.retryInterval = params.retryInterval;
    }
    const response = await this.send(Ocpp201OutgoingAction.UPDATE_FIRMWARE, request);
    if (response.status !== 'Accepted') {
      this.log('warning', ServerAction.WS_SERVER_MESSAGE, `Update Firmware has been answered with status '${response.status as string}'`, { response });
    }
  }

  // Smart Charging and Reservation are not supported for OCPP 2.0.1 Charging Stations
  public async setChargingProfile(): Promise<OCPPSetChargingProfileResponse> {
    await this.logNotSupported('Set Charging Profile');
    return { status: OCPPChargingProfileStatus.NOT_SUPPORTED };
  }

  public async getCompositeSchedule(): Promise<OCPPGetCompositeScheduleResponse> {
    await this.logNotSupported('Get Composite Schedule');
    return { status: OCPPGetCompositeScheduleStatus.REJECTED };
  }

  public async clearChargingProfile(): Promise<OCPPClearChargingProfileResponse> {
    await this.logNotSupported('Clear Charging Profile');
    return { status: OCPPClearChargingProfileStatus.UNKNOWN };
  }

  public async reserveNow(): Promise<OCPPReserveNowResponse> {
    await this.logNotSupported('Reserve Now');
    return { status: OCPPReserveNowStatus.REJECTED };
  }

  public async cancelReservation(): Promise<OCPPCancelReservationResponse> {
    await this.logNotSupported('Cancel Reservation');
    return { status: OCPPCancelReservationStatus.REJECTED };
  }

  private async getVariables(componentVariables: Ocpp201ComponentVariable[]): Promise<Ocpp201GetVariablesResponse['getVariableResult']> {
    const results: Ocpp201GetVariablesResponse['getVariableResult'] = [];
    if (componentVariables.length === 0) {
      return results;
    }
    const itemsPerMessage = await this.getItemsPerGetVariables();
    for (let i = 0; i < componentVariables.length; i += itemsPerMessage) {
      const chunk = componentVariables.slice(i, i + itemsPerMessage);
      try {
        results.push(...await this.sendGetVariables(chunk));
      } catch (error) {
        if (!(error instanceof Ocpp201Error) || chunk.length === 1) {
          throw error;
        }
        // Rejected by the Charging Station (e.g. too many items): request the variables one by one
        for (const componentVariable of chunk) {
          results.push(...await this.sendGetVariables([componentVariable]));
        }
      }
    }
    return results;
  }

  private async getItemsPerGetVariables(): Promise<number> {
    try {
      const results = await this.sendGetVariables([
        { component: { name: 'DeviceDataCtrlr' }, variable: { name: 'ItemsPerMessage', instance: 'GetVariables' } }
      ]);
      const itemsPerMessage = Number(results[0]?.attributeStatus === Ocpp201GetVariableStatus.ACCEPTED ? results[0].attributeValue : NaN);
      if (Number.isInteger(itemsPerMessage) && itemsPerMessage > 0) {
        return itemsPerMessage;
      }
    } catch (error) {
      if (!(error instanceof Ocpp201Error)) {
        throw error;
      }
    }
    return DEFAULT_ITEMS_PER_GET_VARIABLES;
  }

  private async sendGetVariables(componentVariables: Ocpp201ComponentVariable[]): Promise<Ocpp201GetVariablesResponse['getVariableResult']> {
    const response = await this.send(Ocpp201OutgoingAction.GET_VARIABLES, {
      getVariableData: componentVariables.map((componentVariable) => ({ ...componentVariable })),
    }) as Ocpp201GetVariablesResponse;
    return Array.isArray(response.getVariableResult) ? response.getVariableResult : [];
  }

  // Physical connector of the EVSE (as reported in the Status Notifications)
  private getPhysicalConnectorID(evseId: number): number {
    const evseState = Ocpp201EvseStateManager.getEvseState(this.tenant.id, this.getChargingStationID(), evseId);
    const connectorIDs = Array.from(evseState.connectorStatuses.keys());
    return connectorIDs.length === 1 ? connectorIDs[0] : 1;
  }

  private async send(action: Ocpp201OutgoingAction, payload: Ocpp201Payload): Promise<Ocpp201Payload> {
    this.log('debug', ServerAction.WS_SERVER_MESSAGE, `<< '${action}' sent`, { payload });
    const response = await this.connection.sendRequest(action, payload);
    this.log('debug', ServerAction.WS_SERVER_MESSAGE, `>> '${action}' answered`, { payload, response });
    return response;
  }

  private async logNotSupported(command: string): Promise<void> {
    await Logging.logInfo({
      tenantID: this.tenant.id,
      chargingStationID: this.getChargingStationID(),
      action: ServerAction.WS_SERVER_MESSAGE, module: MODULE_NAME, method: 'logNotSupported',
      message: `${command} is not supported for OCPP 2.0.1 Charging Stations`
    }).catch(() => { /* Intentional */ });
  }

  private log(level: 'debug' | 'info' | 'warning', action: ServerAction, message: string, detailedMessages?: Record<string, unknown>): void {
    Ocpp201Logger[level]({
      tenantID: this.tenant.id,
      chargingStationID: this.getChargingStationID(),
      action, module: MODULE_NAME, method: 'send',
      message, detailedMessages
    });
  }
}
