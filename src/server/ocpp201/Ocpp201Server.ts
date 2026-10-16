import * as uWS from 'uWebSockets.js';

import { OCPP201_SUBPROTOCOL, OCPP201_URL_PATH } from './types/Ocpp201Types';
import Ocpp201Connection, { Ocpp201ConnectionIdentity, Ocpp201RequestHandler } from './Ocpp201Connection';
import { ServerAction, ServerType } from '../../types/Server';

import CentralSystemConfiguration from '../../types/configuration/CentralSystemConfiguration';
import ChargingStation from '../../types/ChargingStation';
import ChargingStationClient from '../../client/ocpp/ChargingStationClient';
import ChargingStationConfiguration from '../../types/configuration/ChargingStationConfiguration';
import Constants from '../../utils/Constants';
import Logging from '../../utils/Logging';
import OCPPServer from '../ocpp/OCPPServer';
import OCPPUtils from '../ocpp/utils/OCPPUtils';
import { OCPPVersion } from '../../types/ocpp/OCPPServer';
import Ocpp201ChargingStationClient from './client/Ocpp201ChargingStationClient';
import Ocpp201ChargingStationService from './services/Ocpp201ChargingStationService';
import Ocpp201Logger from './Ocpp201Logger';
import Ocpp201SchemaValidator from './validator/Ocpp201SchemaValidator';
import Tenant from '../../types/Tenant';
import Utils from '../../utils/Utils';
import global from '../../types/GlobalType';

const MODULE_NAME = 'Ocpp201Server';

// WebSocket close codes (RFC 6455)
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_POLICY_VIOLATION = 1008;

export interface Ocpp201ServerDependencies {
  // Check the tenant, token and charging station of a new connection (throws if not allowed)
  authenticate: (identity: Ocpp201ConnectionIdentity) => Promise<void>;
  // Create the handler of the requests sent by the charging station
  createRequestHandler: (identity: Ocpp201ConnectionIdentity) => Ocpp201RequestHandler;
}

interface Ocpp201WebSocket extends uWS.WebSocket {
  url: string;
  forwardedFor: string;
  connection?: Ocpp201Connection;
  closed?: boolean;
}

// OCPP 2.0.1 (OCPP-J) Central System server: wss://<host>/OCPP201/<TENANT_ID>/<TOKEN_ID>/<CHARGING_STATION_ID>
export default class Ocpp201Server extends OCPPServer {
  private readonly connections = new Map<string, Ocpp201Connection>();
  private readonly dependencies: Ocpp201ServerDependencies;
  private listenSocket: uWS.us_listen_socket = null;
  private pingInterval: NodeJS.Timeout = null;

  public constructor(centralSystemConfig: CentralSystemConfiguration, chargingStationConfig: ChargingStationConfiguration,
      dependencies?: Partial<Ocpp201ServerDependencies>) {
    super(centralSystemConfig, chargingStationConfig);
    this.dependencies = {
      authenticate: dependencies?.authenticate ?? (async (identity) => {
        await OCPPUtils.checkAndGetChargingStationConnectionData(ServerAction.WS_SERVER_CONNECTION,
          identity.tenantID, identity.chargingStationID, identity.tokenID);
      }),
      createRequestHandler: dependencies?.createRequestHandler ?? ((identity) =>
        new Ocpp201ChargingStationService(identity, this.getChargingStationService(OCPPVersion.VERSION_201))),
    };
  }

  // Parse '/OCPP201/<TENANT_ID>/<TOKEN_ID>/<CHARGING_STATION_ID>' (an extra trailing segment is ignored like in OCPP 1.6)
  public static parseConnectionURL(url: string): { tenantID: string; tokenID: string; chargingStationID: string } | null {
    const path = (url ?? '').split('?')[0].replace(/^\/+|\/+$/g, '');
    const segments = path.split('/');
    if (segments.length < 4 || segments[0] !== OCPP201_URL_PATH) {
      return null;
    }
    let chargingStationID: string;
    try {
      chargingStationID = decodeURIComponent(segments[3]);
    } catch (error) {
      return null;
    }
    const [, tenantID, tokenID] = segments;
    if (!tenantID || !tokenID || !chargingStationID) {
      return null;
    }
    return { tenantID, tokenID, chargingStationID };
  }

  // The client offers a comma separated list of subprotocols
  public static isOcpp201SubprotocolRequested(secWebSocketProtocol: string): boolean {
    return (secWebSocketProtocol ?? '').split(',').map((protocol) => protocol.trim()).includes(OCPP201_SUBPROTOCOL);
  }

  public start(): void {
    // Load the schemas at startup
    Ocpp201SchemaValidator.getInstance();
    global.centralSystemOcpp201Server = this;
    Logging.logConsoleDebug(`Starting ${ServerType.OCPP201_SERVER} Server...`);
    uWS.App({}).ws('/*', {
      compression: uWS.SHARED_COMPRESSOR,
      maxPayloadLength: 512 * 1024,
      idleTimeout: 1 * 3600,
      sendPingsAutomatically: true,
      upgrade: (res: uWS.HttpResponse, req: uWS.HttpRequest, context: uWS.us_socket_context_t) => {
        this.onUpgrade(res, req, context);
      },
      open: (ws: uWS.WebSocket) => {
        void this.onOpen(ws as Ocpp201WebSocket);
      },
      message: (ws: uWS.WebSocket, message: ArrayBuffer) => {
        // The buffer is only valid during the callback
        const messageAsString = Utils.convertBufferArrayToString(message);
        (ws as Ocpp201WebSocket).connection?.onMessage(messageAsString);
      },
      close: (ws: uWS.WebSocket, code: number, message: ArrayBuffer) => {
        const reason = Utils.convertBufferArrayToString(message);
        this.onClose(ws as Ocpp201WebSocket, code, reason);
      },
      ping: (ws: uWS.WebSocket) => {
        this.onKeepAlive(ws as Ocpp201WebSocket);
      },
      pong: (ws: uWS.WebSocket) => {
        this.onKeepAlive(ws as Ocpp201WebSocket);
      },
    }).any(Constants.HEALTH_CHECK_ROUTE, (res: uWS.HttpResponse) => {
      res.end('OK');
    }).any('/*', (res: uWS.HttpResponse) => {
      res.writeStatus('404 Not Found').end();
    }).listen(this.centralSystemConfig.port, (listenSocket) => {
      if (listenSocket) {
        this.listenSocket = listenSocket;
        Logging.logConsoleDebug(
          `${ServerType.OCPP201_SERVER} Server listening on 'http://${this.centralSystemConfig.host}:${this.centralSystemConfig.port}'`);
      } else {
        Logging.logConsoleError(
          `${ServerType.OCPP201_SERVER} Server failed to listen on 'http://${this.centralSystemConfig.host}:${this.centralSystemConfig.port}'`);
      }
    });
    // Ping the connections periodically (keeps the proxies' connections alive and detects the dead ones)
    this.pingInterval = setInterval(() => this.pingConnections(),
      (this.chargingStationConfig?.pingIntervalOCPPJSecs ?? 60) * 1000);
  }

  public stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const connection of Array.from(this.connections.values())) {
      connection.close(WS_CLOSE_NORMAL, 'Server shutdown');
    }
    this.connections.clear();
    if (this.listenSocket) {
      uWS.us_listen_socket_close(this.listenSocket);
      this.listenSocket = null;
    }
  }

  public hasChargingStationConnected(tenant: Tenant, chargingStation: ChargingStation): boolean {
    const connection = this.connections.get(`${tenant.id}~${chargingStation.id}`);
    return !!connection && !connection.isClosed();
  }

  public getChargingStationClient(tenant: Tenant, chargingStation: ChargingStation): ChargingStationClient | null {
    const connection = this.connections.get(`${tenant.id}~${chargingStation.id}`);
    if (!connection || connection.isClosed()) {
      return null;
    }
    return new Ocpp201ChargingStationClient(connection, tenant);
  }

  public getNumberOfConnections(): number {
    return this.connections.size;
  }

  private onUpgrade(res: uWS.HttpResponse, req: uWS.HttpRequest, context: uWS.us_socket_context_t): void {
    // Request data must be read synchronously
    const url = req.getUrl();
    const secWebSocketKey = req.getHeader('sec-websocket-key');
    const secWebSocketProtocol = req.getHeader('sec-websocket-protocol');
    const secWebSocketExtensions = req.getHeader('sec-websocket-extensions');
    // Set by the public gateway / hosting platform proxy
    const forwardedFor = req.getHeader('x-forwarded-for');
    if (!Ocpp201Server.parseConnectionURL(url)) {
      res.writeStatus('404 Not Found').end();
      this.logConnectionRejected(url, `Invalid URL, expected '/${OCPP201_URL_PATH}/<TENANT_ID>/<TOKEN_ID>/<CHARGING_STATION_ID>'`);
      return;
    }
    if (!Ocpp201Server.isOcpp201SubprotocolRequested(secWebSocketProtocol)) {
      res.writeStatus('400 Bad Request').end();
      this.logConnectionRejected(url, `Subprotocol '${OCPP201_SUBPROTOCOL}' is required but got '${secWebSocketProtocol}'`);
      return;
    }
    res.upgrade({ url, forwardedFor }, secWebSocketKey, OCPP201_SUBPROTOCOL, secWebSocketExtensions, context);
  }

  private async onOpen(ws: Ocpp201WebSocket): Promise<void> {
    const { tenantID, tokenID, chargingStationID } = Ocpp201Server.parseConnectionURL(ws.url);
    const identity: Ocpp201ConnectionIdentity = {
      tenantID, tokenID, chargingStationID,
      clientIP: ws.forwardedFor?.split(',')[0].trim() || Utils.convertBufferArrayToString(ws.getRemoteAddressAsText()).toString(),
    };
    const connection = new Ocpp201Connection({
      send: (message: string) => {
        if (ws.closed) {
          return false;
        }
        // 0 = buffered (backpressure), 1 = sent, 2 = dropped
        return ws.send(message) !== 2;
      },
      close: (code: number, reason: string) => {
        if (!ws.closed) {
          ws.closed = true;
          ws.end(code, reason);
        }
      },
      ping: () => {
        if (ws.closed) {
          return false;
        }
        return ws.ping() !== 2;
      },
    }, identity);
    ws.connection = connection;
    try {
      OCPPUtils.checkChargingStationConnectionData(ServerAction.WS_SERVER_CONNECTION, tenantID, tokenID, chargingStationID);
      await this.dependencies.authenticate(identity);
    } catch (error) {
      // The tenant is not trusted: only log in the default tenant
      this.log('error', identity, ServerAction.WS_SERVER_CONNECTION_OPEN,
        `Connection ID '${connection.guid}' from '${identity.clientIP}' has been rejected: ${(error as Error)?.message}`, { url: ws.url }, false);
      connection.close(WS_CLOSE_POLICY_VIOLATION, 'Connection rejected');
      return;
    }
    // Closed during the authentication
    if (connection.isClosed()) {
      return;
    }
    // Replace any previous connection of the Charging Station
    const existingConnection = this.connections.get(connection.getKey());
    if (existingConnection && existingConnection !== connection) {
      this.log('warning', identity, ServerAction.WS_SERVER_CONNECTION_OPEN,
        `Existing connection ID '${existingConnection.guid}' is replaced by the new connection ID '${connection.guid}'`);
      existingConnection.close(WS_CLOSE_NORMAL, 'Replaced by a new connection');
    }
    try {
      connection.setRequestHandler(this.dependencies.createRequestHandler(identity));
    } catch (error) {
      this.log('error', identity, ServerAction.WS_SERVER_CONNECTION_OPEN,
        `Connection ID '${connection.guid}' cannot be initialized: ${(error as Error)?.message}`);
      connection.close(WS_CLOSE_POLICY_VIOLATION, 'Connection rejected');
      return;
    }
    this.connections.set(connection.getKey(), connection);
    this.log('info', identity, ServerAction.WS_SERVER_CONNECTION_OPEN,
      `OCPP 2.0.1 connection ID '${connection.guid}' has been accepted from '${identity.clientIP}'`);
  }

  private onClose(ws: Ocpp201WebSocket, code: number, reason: string): void {
    ws.closed = true;
    const connection = ws.connection;
    if (!connection) {
      return;
    }
    connection.onClosed();
    // Only remove the current connection of the Charging Station
    if (this.connections.get(connection.getKey()) === connection) {
      this.connections.delete(connection.getKey());
    }
    this.log('info', connection.identity, ServerAction.WS_SERVER_CONNECTION_CLOSE,
      `OCPP 2.0.1 connection ID '${connection.guid}' has been closed with code '${code}'${reason ? `, reason: '${reason}'` : ''}`);
  }

  private onKeepAlive(ws: Ocpp201WebSocket): void {
    const connection = ws.connection;
    if (!connection || connection.isClosed() || this.connections.get(connection.getKey()) !== connection) {
      return;
    }
    const requestHandler = connection.getRequestHandler();
    if (requestHandler instanceof Ocpp201ChargingStationService) {
      requestHandler.onKeepAlive().catch((error) => {
        this.log('warning', connection.identity, ServerAction.WS_SERVER_CONNECTION_PING,
          `Cannot update the last seen date: ${(error as Error)?.message}`);
      });
    }
  }

  private pingConnections(): void {
    for (const connection of Array.from(this.connections.values())) {
      if (connection.isClosed() || !connection.ping()) {
        this.log('warning', connection.identity, ServerAction.WS_SERVER_CONNECTION_PING,
          `OCPP 2.0.1 connection ID '${connection.guid}' cannot be pinged and is removed`);
        connection.close(WS_CLOSE_NORMAL, 'Ping failed');
        if (this.connections.get(connection.getKey()) === connection) {
          this.connections.delete(connection.getKey());
        }
      }
    }
  }

  private logConnectionRejected(url: string, message: string): void {
    Ocpp201Logger.error({
      tenantID: Constants.DEFAULT_TENANT_ID,
      action: ServerAction.WS_SERVER_CONNECTION,
      module: MODULE_NAME, method: 'onUpgrade',
      message: `Connection with URL '${url}' rejected: ${message}`,
    });
  }

  private log(level: 'info' | 'warning' | 'error', identity: Ocpp201ConnectionIdentity, action: ServerAction,
      message: string, detailedMessages?: Record<string, unknown>, logInTenant = true): void {
    const log = {
      chargingStationID: identity.chargingStationID,
      action, module: MODULE_NAME, method: 'onConnection',
      message, detailedMessages
    };
    Ocpp201Logger[level]({ ...log, tenantID: Constants.DEFAULT_TENANT_ID });
    if (logInTenant && identity.tenantID && identity.tenantID !== Constants.DEFAULT_TENANT_ID) {
      Ocpp201Logger[level]({ ...log, tenantID: identity.tenantID });
    }
  }
}
