import { CurrentType } from '../ChargingStation';

export default interface ChargingStationConfiguration {
  heartbeatIntervalOCPPSSecs: number;
  heartbeatIntervalOCPPJSecs: number;
  pingIntervalOCPPJSecs: number;
  monitoringIntervalOCPPJSecs: number;
  checkEndOfChargeNotificationAfterMin: number;
  notifBeforeEndOfChargeEnabled: boolean;
  notifBeforeEndOfChargePercent: number;
  notifEndOfChargeEnabled: boolean;
  notifEndOfChargePercent: number;
  notifStopTransactionAndUnlockConnector: boolean;
  useServerLocalIPForRemoteCommand?: boolean;
  secureLocalServer?: boolean;
  maxLastSeenIntervalSecs: number;
  // Current type of the connectors whose current type is not provided by a template
  defaultCurrentType?: CurrentType;
}
