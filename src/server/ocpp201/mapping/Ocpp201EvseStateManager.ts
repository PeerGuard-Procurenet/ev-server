import { ChargePointErrorCode, ChargePointStatus } from '../../../types/ocpp/OCPPServer';
import { Ocpp201ChargingState, Ocpp201ConnectorStatus } from '../types/Ocpp201Types';

// In OCPP 2.0.1 the platform connector ID is the EVSE ID: a transaction runs on an EVSE, whatever physical connector is used
export interface Ocpp201EvseState {
  // Last status of each physical connector of the EVSE
  connectorStatuses: Map<number, Ocpp201ConnectorStatus>;
  // Ongoing OCPP 2.0.1 transaction on the EVSE
  transactionId?: string;
  platformTransactionID?: number;
  chargingState?: Ocpp201ChargingState;
  // Set when a platform transaction has ended while the EV is still plugged in
  finishing: boolean;
  // Last status sent to the platform
  lastPlatformStatus?: ChargePointStatus;
}

export interface Ocpp201PlatformConnectorStatus {
  status: ChargePointStatus;
  errorCode: ChargePointErrorCode;
}

// Precedence used to aggregate the physical connector statuses of an EVSE
const CONNECTOR_STATUS_PRIORITY: Ocpp201ConnectorStatus[] = [
  Ocpp201ConnectorStatus.OCCUPIED,
  Ocpp201ConnectorStatus.RESERVED,
  Ocpp201ConnectorStatus.AVAILABLE,
  Ocpp201ConnectorStatus.FAULTED,
  Ocpp201ConnectorStatus.UNAVAILABLE,
];

// Keeps the runtime state of the EVSEs of all OCPP 2.0.1 charging stations of this server instance
export default class Ocpp201EvseStateManager {
  private static readonly states = new Map<string, Map<number, Ocpp201EvseState>>();

  public static getEvseState(tenantID: string, chargingStationID: string, evseId: number): Ocpp201EvseState {
    const stationKey = `${tenantID}~${chargingStationID}`;
    let stationStates = Ocpp201EvseStateManager.states.get(stationKey);
    if (!stationStates) {
      stationStates = new Map();
      Ocpp201EvseStateManager.states.set(stationKey, stationStates);
    }
    let evseState = stationStates.get(evseId);
    if (!evseState) {
      evseState = { connectorStatuses: new Map(), finishing: false };
      stationStates.set(evseId, evseState);
    }
    return evseState;
  }

  // On (re)boot, the charging station reports again the status of all its connectors
  public static resetChargingStation(tenantID: string, chargingStationID: string): void {
    Ocpp201EvseStateManager.states.delete(`${tenantID}~${chargingStationID}`);
  }

  public static getAggregatedConnectorStatus(evseState: Ocpp201EvseState): Ocpp201ConnectorStatus | undefined {
    const statuses = Array.from(evseState.connectorStatuses.values());
    return CONNECTOR_STATUS_PRIORITY.find((status) => statuses.includes(status));
  }

  // Compute the platform connector status (OCPP 1.6 semantic) from the OCPP 2.0.1 EVSE state
  public static computePlatformStatus(evseState: Ocpp201EvseState): Ocpp201PlatformConnectorStatus | null {
    const connectorStatus = Ocpp201EvseStateManager.getAggregatedConnectorStatus(evseState);
    const hasPlatformTransaction = !!evseState.transactionId && !!evseState.platformTransactionID;
    const noError = ChargePointErrorCode.NO_ERROR;
    switch (connectorStatus) {
      case Ocpp201ConnectorStatus.FAULTED:
        return { status: ChargePointStatus.FAULTED, errorCode: ChargePointErrorCode.OTHER_ERROR };
      case Ocpp201ConnectorStatus.UNAVAILABLE:
        return { status: ChargePointStatus.UNAVAILABLE, errorCode: noError };
      case Ocpp201ConnectorStatus.RESERVED:
        return { status: ChargePointStatus.RESERVED, errorCode: noError };
      case Ocpp201ConnectorStatus.AVAILABLE:
        // EV unplugged but the transaction end has not been received yet
        if (hasPlatformTransaction) {
          return { status: ChargePointStatus.FINISHING, errorCode: noError };
        }
        return { status: ChargePointStatus.AVAILABLE, errorCode: noError };
      case Ocpp201ConnectorStatus.OCCUPIED:
        if (hasPlatformTransaction) {
          switch (evseState.chargingState) {
            case Ocpp201ChargingState.SUSPENDED_EV:
              return { status: ChargePointStatus.SUSPENDED_EV, errorCode: noError };
            case Ocpp201ChargingState.SUSPENDED_EVSE:
            case Ocpp201ChargingState.EV_CONNECTED:
            case Ocpp201ChargingState.IDLE:
              return { status: ChargePointStatus.SUSPENDED_EVSE, errorCode: noError };
            default:
              return { status: ChargePointStatus.CHARGING, errorCode: noError };
          }
        }
        if (evseState.finishing) {
          return { status: ChargePointStatus.FINISHING, errorCode: noError };
        }
        return { status: ChargePointStatus.PREPARING, errorCode: noError };
      default:
        // No connector status received yet
        return null;
    }
  }
}
