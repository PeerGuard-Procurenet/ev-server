import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import OCPPUtils from '../../src/server/ocpp/utils/OCPPUtils';
import { Ocpp201ConnectionIdentity } from '../../src/server/ocpp201/Ocpp201Connection';
import Ocpp201Server from '../../src/server/ocpp201/Ocpp201Server';
import PublicGatewayServer from '../../src/server/PublicGatewayServer';
import WebSocket from 'ws';

jest.mock('../../src/utils/Logging', () => ({
  __esModule: true,
  default: {
    logDebug: jest.fn(async () => Promise.resolve('')),
    logInfo: jest.fn(async () => Promise.resolve('')),
    logWarning: jest.fn(async () => Promise.resolve('')),
    logError: jest.fn(async () => Promise.resolve('')),
    logConsoleDebug: jest.fn(),
    logConsoleError: jest.fn(),
  },
}));
jest.mock('../../src/utils/Configuration', () => ({
  __esModule: true,
  default: {
    getJsonEndpointConfig: () => ({ baseSecureUrl: 'wss://ev-server.test' }),
    getChargingStationConfig: () => ({ pingIntervalOCPPJSecs: 60 }),
  },
}));
jest.mock('../../src/server/ocpp/services/OCPPService', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/server/ocpp/utils/OCPPUtils', () => ({
  __esModule: true,
  default: { checkAndGetChargingStationConnectionData: jest.fn(), checkChargingStationConnectionData: jest.fn() },
}));
jest.mock('../../src/storage/mongodb/ChargingStationStorage', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/storage/mongodb/TransactionStorage', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/server/ocpp201/storage/Ocpp201TransactionStorage', () => ({ __esModule: true, default: {} }));

const PORT = 18011;
const TENANT_ID = '5be7fb271014d90008992f06';
const TOKEN_ID = '6a97123c5ddfdce571887e9f';
const URL = `ws://127.0.0.1:${PORT}/OCPP201/${TENANT_ID}/${TOKEN_ID}`;

interface TestClient {
  ws: WebSocket;
  frames: unknown[][];
  closed: Promise<number>;
}

async function connect(url: string, protocols: string | string[] = 'ocpp2.0.1'): Promise<TestClient> {
  const ws = new WebSocket(url, protocols);
  const frames: unknown[][] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (error) => reject(error));
  });
  return { ws, frames, closed };
}

async function waitFor(condition: () => boolean, timeoutMillis = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMillis) {
      throw new Error('Timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('OCPP 2.0.1 server (WebSocket)', () => {
  let server: Ocpp201Server;
  const authenticated: Ocpp201ConnectionIdentity[] = [];

  beforeAll(async () => {
    server = new Ocpp201Server(
      { implementation: 'ocpp201', protocol: 'ws', host: '127.0.0.1', port: PORT, debug: false } as any,
      { pingIntervalOCPPJSecs: 60 } as any,
      {
        authenticate: async (identity) => {
          authenticated.push(identity);
          if (identity.chargingStationID === 'REJECTED') {
            throw new Error('Unknown token');
          }
          return Promise.resolve();
        },
        createRequestHandler: () => ({
          handleRequest: async (action) => Promise.resolve(action === 'Heartbeat' ? { currentTime: '2024-10-12T10:00:00.000Z' } : {}),
        }),
      });
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterAll(() => {
    server.stop();
  });

  it('should parse the connection URL', () => {
    expect(Ocpp201Server.parseConnectionURL(`/OCPP201/${TENANT_ID}/${TOKEN_ID}/20241012000005`))
      .toEqual({ tenantID: TENANT_ID, tokenID: TOKEN_ID, chargingStationID: '20241012000005' });
    expect(Ocpp201Server.parseConnectionURL(`/OCPP201/${TENANT_ID}/${TOKEN_ID}/CS%2D1/`))
      .toEqual({ tenantID: TENANT_ID, tokenID: TOKEN_ID, chargingStationID: 'CS-1' });
    expect(Ocpp201Server.parseConnectionURL(`/OCPP201/${TENANT_ID}/${TOKEN_ID}/CS-1?x=1`)).toMatchObject({ chargingStationID: 'CS-1' });
    expect(Ocpp201Server.parseConnectionURL(`/OCPP16/${TENANT_ID}/${TOKEN_ID}/CS-1`)).toBeNull();
    expect(Ocpp201Server.parseConnectionURL(`/OCPP201/${TENANT_ID}/${TOKEN_ID}`)).toBeNull();
    expect(Ocpp201Server.parseConnectionURL(`/OCPP201/${TENANT_ID}/${TOKEN_ID}/%E0%A4%A`)).toBeNull();
  });

  it('should select the OCPP 2.0.1 subprotocol', () => {
    expect(Ocpp201Server.isOcpp201SubprotocolRequested('ocpp2.0.1')).toBe(true);
    expect(Ocpp201Server.isOcpp201SubprotocolRequested('ocpp1.6, ocpp2.0.1')).toBe(true);
    expect(Ocpp201Server.isOcpp201SubprotocolRequested('ocpp1.6')).toBe(false);
    expect(Ocpp201Server.isOcpp201SubprotocolRequested('')).toBe(false);
  });

  it('should accept a Charging Station and answer its requests', async () => {
    const client = await connect(`${URL}/20241012000005`);
    expect(client.ws.protocol).toBe('ocpp2.0.1');
    client.ws.send(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
    await waitFor(() => client.frames.length === 1);
    expect(client.frames[0]).toEqual([3, 'msg-1', { currentTime: '2024-10-12T10:00:00.000Z' }]);
    expect(authenticated.find((identity) => identity.chargingStationID === '20241012000005')).toMatchObject(
      { tenantID: TENANT_ID, tokenID: TOKEN_ID });
    client.ws.close();
    await client.closed;
  });

  it('should select OCPP 2.0.1 among several offered subprotocols', async () => {
    const client = await connect(`${URL}/CS-MULTI`, ['ocpp1.6', 'ocpp2.0.1']);
    expect(client.ws.protocol).toBe('ocpp2.0.1');
    client.ws.close();
    await client.closed;
  });

  it('should refuse a connection without the OCPP 2.0.1 subprotocol', async () => {
    await expect(connect(`${URL}/CS-16`, 'ocpp1.6')).rejects.toThrow('400');
  });

  it('should refuse a connection with an invalid URL', async () => {
    await expect(connect(`ws://127.0.0.1:${PORT}/OCPP201/${TENANT_ID}`)).rejects.toThrow('404');
  });

  it('should close the connection of a Charging Station that is not allowed', async () => {
    const client = await connect(`${URL}/REJECTED`);
    await expect(client.closed).resolves.toBe(1008);
  });

  it('should close the connection with an invalid tenant', async () => {
    (OCPPUtils.checkChargingStationConnectionData as jest.Mock<any>).mockImplementationOnce(() => {
      throw new Error('The Tenant ID is invalid!');
    });
    const client = await connect(`ws://127.0.0.1:${PORT}/OCPP201/not-a-tenant/${TOKEN_ID}/CS-1`);
    await expect(client.closed).resolves.toBe(1008);
  });

  it('should send the platform commands to the connected Charging Station', async () => {
    const client = await connect(`${URL}/CS-COMMAND`);
    const chargingStation = { id: 'CS-COMMAND' } as any;
    const tenant = { id: TENANT_ID } as any;
    await waitFor(() => server.hasChargingStationConnected(tenant, chargingStation));
    client.ws.on('message', (data) => {
      const [messageType, messageID, action] = JSON.parse(data.toString());
      if (messageType === 2 && action === 'Reset') {
        client.ws.send(JSON.stringify([3, messageID, { status: 'Accepted' }]));
      }
    });
    const chargingStationClient = server.getChargingStationClient(tenant, chargingStation);
    await expect(chargingStationClient.reset({ type: 'Hard' as any })).resolves.toEqual({ status: 'Accepted' });
    expect(client.frames[0]).toEqual([2, expect.any(String), 'Reset', { type: 'Immediate' }]);
    client.ws.close();
    await client.closed;
    await waitFor(() => !server.hasChargingStationConnected(tenant, chargingStation));
    expect(server.getChargingStationClient(tenant, chargingStation)).toBeNull();
  });

  it('should replace the previous connection of a Charging Station', async () => {
    const tenant = { id: TENANT_ID } as any;
    const chargingStation = { id: 'CS-TWICE' } as any;
    const first = await connect(`${URL}/CS-TWICE`);
    await waitFor(() => server.hasChargingStationConnected(tenant, chargingStation));
    const second = await connect(`${URL}/CS-TWICE`);
    await expect(first.closed).resolves.toBe(1000);
    await waitFor(() => server.hasChargingStationConnected(tenant, chargingStation));
    second.ws.send(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
    await waitFor(() => second.frames.length === 1);
    expect(second.frames[0][0]).toBe(3);
    second.ws.close();
    await second.closed;
  });

  it('should route the OCPP 2.0.1 connections of the public gateway to the OCPP 2.0.1 server', () => {
    const gateway = new PublicGatewayServer(10000, { port: 80 } as any, { port: 8010 } as any, { port: 8000 } as any,
      null, null, null, { port: 8011 } as any) as any;
    expect(gateway.ocpp201Target).toBe('ws://127.0.0.1:8011');
    expect(gateway.isOcpp201URL(`/OCPP201/${TENANT_ID}/${TOKEN_ID}/CS-1`)).toBe(true);
    expect(gateway.isOcpp201URL(`/ocpp201/${TENANT_ID}/${TOKEN_ID}/CS-1`)).toBe(true);
    expect(gateway.isOcpp201URL(`/OCPP16/${TENANT_ID}/${TOKEN_ID}/CS-1`)).toBe(false);
    expect(gateway.isOcpp201URL(`/OCPP2010/${TENANT_ID}/${TOKEN_ID}/CS-1`)).toBe(false);
    expect(() => new PublicGatewayServer(8011, { port: 80 } as any, { port: 8010 } as any, null, null, null, null, { port: 8011 } as any))
      .toThrow('must differ');
  });
});
