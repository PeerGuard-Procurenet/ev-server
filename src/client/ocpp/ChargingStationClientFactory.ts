import { OCPPProtocol, OCPPVersion } from '../../types/ocpp/OCPPServer';

import ChargingStation from '../../types/ChargingStation';
import ChargingStationClient from './ChargingStationClient';
import JsonRestChargingStationClient from './json/JsonRestChargingStationClient';
import SoapChargingStationClient from './soap/SoapChargingStationClient';
import Tenant from '../../types/Tenant';
import global from '../../types/GlobalType';

export default class ChargingStationClientFactory {
  public static async getChargingStationClient(tenant: Tenant, chargingStation: ChargingStation): Promise<ChargingStationClient> {
    let chargingClient: ChargingStationClient = null;
    if (chargingStation.issuer) {
      // Check protocol
      switch (chargingStation.ocppProtocol) {
        // JSON
        case OCPPProtocol.JSON:
          // OCPP 2.0.1 Server
          if (global.centralSystemOcpp201Server?.hasChargingStationConnected(tenant, chargingStation)) {
            chargingClient = global.centralSystemOcpp201Server.getChargingStationClient(tenant, chargingStation);
          // Json Server
          } else if (global.centralSystemJsonServer?.hasChargingStationConnected(tenant, chargingStation)) {
            // Get the local WS Connection Client
            chargingClient = await global.centralSystemJsonServer.getChargingStationClient(tenant, chargingStation);
          } else if (chargingStation.ocppVersion === OCPPVersion.VERSION_201) {
            // OCPP 2.0.1 Charging Station not connected to this server instance
            chargingClient = null;
          } else {
            // Get the Remote WS Connection Client (Rest)
            chargingClient = new JsonRestChargingStationClient(tenant.id, chargingStation);
          }
          break;
        // SOAP
        case OCPPProtocol.SOAP:
          // Init SOAP client
          chargingClient = await SoapChargingStationClient.getChargingStationClient(tenant, chargingStation);
          break;
      }
    }
    return chargingClient;
  }
}
