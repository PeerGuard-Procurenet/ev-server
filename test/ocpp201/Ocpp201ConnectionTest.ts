import Ocpp201Connection, { Ocpp201RequestHandler, Ocpp201Socket } from '../../src/server/ocpp201/Ocpp201Connection';
import { Ocpp201IncomingAction, Ocpp201OutgoingAction, Ocpp201Payload } from '../../src/server/ocpp201/types/Ocpp201Types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import Ocpp201Error from '../../src/server/ocpp201/Ocpp201Error';

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

class FakeSocket implements Ocpp201Socket {
  public sent: unknown[][] = [];
  public closedWith: { code: number; reason: string } = null;
  public connected = true;

  public send(message: string): boolean {
    this.sent.push(JSON.parse(message));
    return this.connected;
  }

  public close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  public ping(): boolean {
    return this.connected;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const identity = { tenantID: '5be7fb271014d90008992f06', tokenID: 'token', chargingStationID: 'CS-201', clientIP: '127.0.0.1' };
const heartbeatResponse = { currentTime: '2024-10-12T10:00:00.000Z' };

describe('OCPP 2.0.1 connection (OCPP-J RPC framework)', () => {
  let socket: FakeSocket;
  let connection: Ocpp201Connection;
  let handler: { handleRequest: jest.Mock<(action: Ocpp201IncomingAction, payload: Ocpp201Payload) => Promise<Ocpp201Payload>> };

  beforeEach(() => {
    socket = new FakeSocket();
    connection = new Ocpp201Connection(socket, identity, 200);
    handler = { handleRequest: jest.fn(async () => Promise.resolve(heartbeatResponse)) };
  });

  afterEach(() => {
    connection.onClosed();
  });

  describe('Requests from the Charging Station', () => {
    beforeEach(() => {
      connection.setRequestHandler(handler as Ocpp201RequestHandler);
    });

    it('should answer a valid CALL with a CALLRESULT', async () => {
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      await flush();
      expect(handler.handleRequest).toHaveBeenCalledWith(Ocpp201IncomingAction.HEARTBEAT, {});
      expect(socket.sent).toEqual([[3, 'msg-1', heartbeatResponse]]);
    });

    it('should answer an invalid JSON with a RpcFrameworkError and MessageId -1', async () => {
      connection.onMessage('[2, "msg-1", "Heartbeat", {');
      await flush();
      expect(socket.sent[0].slice(0, 3)).toEqual([4, '-1', 'RpcFrameworkError']);
      expect(handler.handleRequest).not.toHaveBeenCalled();
    });

    it('should answer a non array message with a RpcFrameworkError', async () => {
      connection.onMessage('{"messageTypeId": 2}');
      await flush();
      expect(socket.sent[0].slice(0, 3)).toEqual([4, '-1', 'RpcFrameworkError']);
    });

    it('should answer an invalid MessageId with a RpcFrameworkError', async () => {
      connection.onMessage(JSON.stringify([2, 12, 'Heartbeat', {}]));
      connection.onMessage(JSON.stringify([2, 'x'.repeat(37), 'Heartbeat', {}]));
      connection.onMessage(JSON.stringify([2, '', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent.map((frame) => frame.slice(0, 3))).toEqual([
        [4, '-1', 'RpcFrameworkError'], [4, '-1', 'RpcFrameworkError'], [4, '-1', 'RpcFrameworkError']]);
    });

    it('should answer an unknown message type with MessageTypeNotSupported', async () => {
      connection.onMessage(JSON.stringify([5, 'msg-1', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent[0].slice(0, 3)).toEqual([4, 'msg-1', 'MessageTypeNotSupported']);
    });

    it('should answer a malformed CALL with a RpcFrameworkError', async () => {
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat']));
      connection.onMessage(JSON.stringify([2, 'msg-2', 42, {}]));
      await flush();
      expect(socket.sent.map((frame) => frame.slice(0, 3))).toEqual([[4, 'msg-1', 'RpcFrameworkError'], [4, 'msg-2', 'RpcFrameworkError']]);
    });

    it('should answer an unknown action with NotImplemented and a CSMS action with NotSupported', async () => {
      connection.onMessage(JSON.stringify([2, 'msg-1', 'StartTransaction', {}]));
      connection.onMessage(JSON.stringify([2, 'msg-2', 'Reset', { type: 'Immediate' }]));
      await flush();
      expect(socket.sent.map((frame) => frame.slice(0, 3))).toEqual([[4, 'msg-1', 'NotImplemented'], [4, 'msg-2', 'NotSupported']]);
      expect(handler.handleRequest).not.toHaveBeenCalled();
    });

    it('should answer an invalid payload with the matching error code', async () => {
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', []]));
      connection.onMessage(JSON.stringify([2, 'msg-2', 'BootNotification', { reason: 'PowerUp' }]));
      connection.onMessage(JSON.stringify([2, 'msg-3', 'StatusNotification',
        { timestamp: '2024-10-12T10:00:00Z', connectorStatus: 'Charging', evseId: 1, connectorId: 1 }]));
      await flush();
      expect(socket.sent.map((frame) => frame.slice(0, 3))).toEqual([
        [4, 'msg-1', 'FormatViolation'], [4, 'msg-2', 'OccurrenceConstraintViolation'], [4, 'msg-3', 'PropertyConstraintViolation']]);
      expect(handler.handleRequest).not.toHaveBeenCalled();
    });

    it('should limit the error description to 255 characters', async () => {
      handler.handleRequest.mockRejectedValueOnce(new Ocpp201Error('SecurityError' as never, 'x'.repeat(1000)));
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent[0][2]).toBe('SecurityError');
      expect((socket.sent[0][3] as string).length).toBe(255);
      expect(socket.sent[0][4]).toEqual({});
    });

    it('should answer an unexpected error with an InternalError', async () => {
      handler.handleRequest.mockRejectedValueOnce(new Error('Database is down'));
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent[0].slice(0, 3)).toEqual([4, 'msg-1', 'InternalError']);
    });

    it('should never send a response that does not comply with the schema', async () => {
      handler.handleRequest.mockResolvedValueOnce({ currentTime: 'not a date' });
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent[0].slice(0, 3)).toEqual([4, 'msg-1', 'InternalError']);
    });

    it('should process the requests one after the other', async () => {
      const order: string[] = [];
      let releaseFirst: () => void;
      handler.handleRequest
        .mockImplementationOnce(async () => {
          order.push('start-1');
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          order.push('end-1');
          return heartbeatResponse;
        })
        .mockImplementationOnce(async () => {
          order.push('start-2');
          return Promise.resolve(heartbeatResponse);
        });
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      connection.onMessage(JSON.stringify([2, 'msg-2', 'Heartbeat', {}]));
      await flush();
      expect(order).toEqual(['start-1']);
      releaseFirst();
      await flush();
      expect(order).toEqual(['start-1', 'end-1', 'start-2']);
      expect(socket.sent.map((frame) => frame[1])).toEqual(['msg-1', 'msg-2']);
    });

    it('should keep processing the requests after an error', async () => {
      handler.handleRequest.mockRejectedValueOnce(new Error('Failure'));
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      connection.onMessage(JSON.stringify([2, 'msg-2', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent.map((frame) => frame.slice(0, 2))).toEqual([[4, 'msg-1'], [3, 'msg-2']]);
    });

    it('should not answer once closed', async () => {
      connection.onClosed();
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent).toEqual([]);
    });
  });

  describe('Initialization', () => {
    it('should keep the requests received before the end of the initialization', async () => {
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      await flush();
      expect(socket.sent).toEqual([]);
      connection.setRequestHandler(handler as Ocpp201RequestHandler);
      await flush();
      expect(socket.sent).toEqual([[3, 'msg-1', heartbeatResponse]]);
    });

    it('should drop the requests if the connection is closed during the initialization', async () => {
      connection.onMessage(JSON.stringify([2, 'msg-1', 'Heartbeat', {}]));
      connection.close(1008, 'Rejected');
      await flush();
      expect(socket.sent).toEqual([]);
      expect(socket.closedWith).toEqual({ code: 1008, reason: 'Rejected' });
      expect(connection.isClosed()).toBe(true);
    });
  });

  describe('Requests to the Charging Station', () => {
    beforeEach(() => {
      connection.setRequestHandler(handler as Ocpp201RequestHandler);
    });

    it('should resolve with the CALLRESULT payload', async () => {
      const result = connection.sendRequest(Ocpp201OutgoingAction.RESET, { type: 'Immediate' });
      await flush();
      const [messageType, messageID, action, payload] = socket.sent[0];
      expect([messageType, action, payload]).toEqual([2, 'Reset', { type: 'Immediate' }]);
      expect((messageID as string).length).toBeLessThanOrEqual(36);
      connection.onMessage(JSON.stringify([3, messageID, { status: 'Accepted' }]));
      await expect(result).resolves.toEqual({ status: 'Accepted' });
    });

    it('should reject with the CALLERROR', async () => {
      const result = connection.sendRequest(Ocpp201OutgoingAction.RESET, { type: 'Immediate' });
      await flush();
      connection.onMessage(JSON.stringify([4, socket.sent[0][1], 'NotSupported', 'Not supported', {}]));
      await expect(result).rejects.toMatchObject({ code: 'NotSupported' });
    });

    it('should reject an invalid request without sending it', async () => {
      await expect(connection.sendRequest(Ocpp201OutgoingAction.RESET, { type: 'Hard' })).rejects.toBeInstanceOf(Ocpp201Error);
      expect(socket.sent).toEqual([]);
    });

    it('should reject after the timeout', async () => {
      const result = connection.sendRequest(Ocpp201OutgoingAction.CLEAR_CACHE, {});
      await expect(result).rejects.toThrow('Timeout');
    });

    it('should ignore a response to an unknown request', async () => {
      const result = connection.sendRequest(Ocpp201OutgoingAction.CLEAR_CACHE, {});
      await flush();
      connection.onMessage(JSON.stringify([3, 'unknown-id', { status: 'Accepted' }]));
      connection.onMessage(JSON.stringify([3, socket.sent[0][1], { status: 'Rejected' }]));
      await expect(result).resolves.toEqual({ status: 'Rejected' });
      // No CALLERROR sent for responses
      expect(socket.sent.length).toBe(1);
    });

    it('should send only one request at a time', async () => {
      const first = connection.sendRequest(Ocpp201OutgoingAction.CLEAR_CACHE, {});
      const second = connection.sendRequest(Ocpp201OutgoingAction.RESET, { type: 'OnIdle' });
      await flush();
      expect(socket.sent.length).toBe(1);
      connection.onMessage(JSON.stringify([3, socket.sent[0][1], { status: 'Accepted' }]));
      await expect(first).resolves.toEqual({ status: 'Accepted' });
      await flush();
      expect(socket.sent.length).toBe(2);
      expect(socket.sent[1][2]).toBe('Reset');
      connection.onMessage(JSON.stringify([3, socket.sent[1][1], { status: 'Scheduled' }]));
      await expect(second).resolves.toEqual({ status: 'Scheduled' });
    });

    it('should send the next request after a failure', async () => {
      const first = connection.sendRequest(Ocpp201OutgoingAction.CLEAR_CACHE, {});
      const second = connection.sendRequest(Ocpp201OutgoingAction.CLEAR_CACHE, {});
      await flush();
      connection.onMessage(JSON.stringify([4, socket.sent[0][1], 'InternalError', '', {}]));
      await expect(first).rejects.toBeInstanceOf(Ocpp201Error);
      await flush();
      connection.onMessage(JSON.stringify([3, socket.sent[1][1], { status: 'Accepted' }]));
      await expect(second).resolves.toEqual({ status: 'Accepted' });
    });

    it('should reject the pending request when the connection is closed', async () => {
      const result = connection.sendRequest(Ocpp201OutgoingAction.CLEAR_CACHE, {});
      await flush();
      connection.onClosed();
      await expect(result).rejects.toThrow('Connection closed');
      await expect(connection.sendRequest(Ocpp201OutgoingAction.CLEAR_CACHE, {})).rejects.toThrow('closed');
    });

    it('should process a response while a request of the Charging Station is being processed', async () => {
      // The handler of the incoming request waits for the response of a request sent to the Charging Station
      handler.handleRequest.mockImplementationOnce(async () => {
        await connection.sendRequest(Ocpp201OutgoingAction.REQUEST_STOP_TRANSACTION, { transactionId: 'TX-1' });
        return {};
      });
      connection.onMessage(JSON.stringify([2, 'msg-1', 'TransactionEvent', {
        eventType: 'Updated', timestamp: '2024-10-12T10:00:00Z', triggerReason: 'MeterValuePeriodic', seqNo: 1, transactionInfo: { transactionId: 'TX-1' }
      }]));
      await flush();
      expect(socket.sent[0][2]).toBe('RequestStopTransaction');
      connection.onMessage(JSON.stringify([3, socket.sent[0][1], { status: 'Accepted' }]));
      await flush();
      expect(socket.sent[1]).toEqual([3, 'msg-1', {}]);
    });
  });
});
