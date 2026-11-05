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
  // IANA timezone of the charging stations whose location is not set (e.g. 'Africa/Lagos')
  defaultTimezone?: string;
  // Set the local time displayed by the OCPP 2.0.1 charging stations (timezone of their location) after their boot
  setLocalTimeOnChargingStations?: boolean;
  // Send the active tags to the OCPP 2.0.1 charging stations so that they can be used while the charging stations are offline
  offlineAuthorizationEnabled?: boolean;
  // User of the sessions authorized offline with a tag that does not exist anymore (not set: these sessions are not recorded)
  offlineFallbackUserID?: string;
}
