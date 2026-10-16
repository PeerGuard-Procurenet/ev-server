import { ChargePointErrorCode, ChargePointStatus } from '../../src/types/ocpp/OCPPServer';
import { Ocpp201ChargingState, Ocpp201ConnectorStatus } from '../../src/server/ocpp201/types/Ocpp201Types';
import Ocpp201EvseStateManager, { Ocpp201EvseState } from '../../src/server/ocpp201/mapping/Ocpp201EvseStateManager';
import { describe, expect, it } from '@jest/globals';

function buildState(statuses: Ocpp201ConnectorStatus[], transaction?: { platformTransactionID?: number; chargingState?: Ocpp201ChargingState },
    finishing = false): Ocpp201EvseState {
  const state: Ocpp201EvseState = { connectorStatuses: new Map(), finishing };
  statuses.forEach((status, index) => state.connectorStatuses.set(index + 1, status));
  if (transaction) {
    state.transactionId = 'TX-1';
    state.platformTransactionID = transaction.platformTransactionID;
    state.chargingState = transaction.chargingState;
  }
  return state;
}

describe('OCPP 2.0.1 EVSE state manager', () => {
  it('should not report a status before the first Status Notification', () => {
    expect(Ocpp201EvseStateManager.computePlatformStatus(buildState([]))).toBeNull();
  });

  it('should aggregate the connectors of an EVSE', () => {
    expect(Ocpp201EvseStateManager.getAggregatedConnectorStatus(buildState(
      [Ocpp201ConnectorStatus.UNAVAILABLE, Ocpp201ConnectorStatus.OCCUPIED]))).toBe(Ocpp201ConnectorStatus.OCCUPIED);
    expect(Ocpp201EvseStateManager.getAggregatedConnectorStatus(buildState(
      [Ocpp201ConnectorStatus.FAULTED, Ocpp201ConnectorStatus.AVAILABLE]))).toBe(Ocpp201ConnectorStatus.AVAILABLE);
    expect(Ocpp201EvseStateManager.getAggregatedConnectorStatus(buildState(
      [Ocpp201ConnectorStatus.UNAVAILABLE, Ocpp201ConnectorStatus.FAULTED]))).toBe(Ocpp201ConnectorStatus.FAULTED);
  });

  it('should map the statuses without transaction', () => {
    const expectStatus = (state: Ocpp201EvseState, status: ChargePointStatus, errorCode = ChargePointErrorCode.NO_ERROR) =>
      expect(Ocpp201EvseStateManager.computePlatformStatus(state)).toEqual({ status, errorCode });
    expectStatus(buildState([Ocpp201ConnectorStatus.AVAILABLE]), ChargePointStatus.AVAILABLE);
    expectStatus(buildState([Ocpp201ConnectorStatus.OCCUPIED]), ChargePointStatus.PREPARING);
    expectStatus(buildState([Ocpp201ConnectorStatus.OCCUPIED], null, true), ChargePointStatus.FINISHING);
    expectStatus(buildState([Ocpp201ConnectorStatus.RESERVED]), ChargePointStatus.RESERVED);
    expectStatus(buildState([Ocpp201ConnectorStatus.UNAVAILABLE]), ChargePointStatus.UNAVAILABLE);
    expectStatus(buildState([Ocpp201ConnectorStatus.FAULTED]), ChargePointStatus.FAULTED, ChargePointErrorCode.OTHER_ERROR);
  });

  it('should map an OCPP 2.0.1 transaction not yet linked to a platform transaction as without transaction', () => {
    expect(Ocpp201EvseStateManager.computePlatformStatus(buildState([Ocpp201ConnectorStatus.OCCUPIED], { chargingState: Ocpp201ChargingState.EV_CONNECTED })).status)
      .toBe(ChargePointStatus.PREPARING);
    expect(Ocpp201EvseStateManager.computePlatformStatus(buildState([Ocpp201ConnectorStatus.AVAILABLE], { chargingState: Ocpp201ChargingState.IDLE })).status)
      .toBe(ChargePointStatus.AVAILABLE);
  });

  it('should map the charging states of an ongoing platform transaction', () => {
    const status = (chargingState: Ocpp201ChargingState) => Ocpp201EvseStateManager.computePlatformStatus(
      buildState([Ocpp201ConnectorStatus.OCCUPIED], { platformTransactionID: 10, chargingState })).status;
    expect(status(Ocpp201ChargingState.CHARGING)).toBe(ChargePointStatus.CHARGING);
    expect(status(null)).toBe(ChargePointStatus.CHARGING);
    expect(status(Ocpp201ChargingState.SUSPENDED_EV)).toBe(ChargePointStatus.SUSPENDED_EV);
    expect(status(Ocpp201ChargingState.SUSPENDED_EVSE)).toBe(ChargePointStatus.SUSPENDED_EVSE);
    expect(status(Ocpp201ChargingState.EV_CONNECTED)).toBe(ChargePointStatus.SUSPENDED_EVSE);
    expect(status(Ocpp201ChargingState.IDLE)).toBe(ChargePointStatus.SUSPENDED_EVSE);
  });

  it('should never report Available while a platform transaction is ongoing', () => {
    expect(Ocpp201EvseStateManager.computePlatformStatus(
      buildState([Ocpp201ConnectorStatus.AVAILABLE], { platformTransactionID: 10, chargingState: Ocpp201ChargingState.IDLE })).status)
      .toBe(ChargePointStatus.FINISHING);
  });

  it('should keep the state per charging station and reset it', () => {
    const state = Ocpp201EvseStateManager.getEvseState('tenant', 'CS1', 1);
    state.connectorStatuses.set(1, Ocpp201ConnectorStatus.OCCUPIED);
    expect(Ocpp201EvseStateManager.getEvseState('tenant', 'CS1', 1)).toBe(state);
    expect(Ocpp201EvseStateManager.getEvseState('tenant', 'CS2', 1)).not.toBe(state);
    Ocpp201EvseStateManager.resetChargingStation('tenant', 'CS1');
    expect(Ocpp201EvseStateManager.getEvseState('tenant', 'CS1', 1).connectorStatuses.size).toBe(0);
  });
});
