import { OCPP201_MESSAGE_ID_MAX_LENGTH, Ocpp201ErrorCode, Ocpp201IncomingAction, Ocpp201MessageType, Ocpp201OutgoingAction, Ocpp201Payload } from './types/Ocpp201Types';

import Constants from '../../utils/Constants';
import Ocpp201Error from './Ocpp201Error';
import Ocpp201Logger from './Ocpp201Logger';
import Ocpp201SchemaValidator from './validator/Ocpp201SchemaValidator';
import { ServerAction } from '../../types/Server';
import { randomUUID } from 'crypto';

const MODULE_NAME = 'Ocpp201Connection';

// OCPP-J limits the error description to 255 characters
const ERROR_DESCRIPTION_MAX_LENGTH = 255;
// MessageId to use in a CALLERROR when the MessageId of the received message cannot be read
const UNKNOWN_MESSAGE_ID = '-1';

const INCOMING_ACTIONS = new Set<string>(Object.values(Ocpp201IncomingAction));
const OUTGOING_ACTIONS = new Set<string>(Object.values(Ocpp201OutgoingAction));

// Transport used by the connection (implemented on top of uWebSockets.js by the server)
export interface Ocpp201Socket {
  send(message: string): boolean;
  close(code: number, reason: string): void;
  ping(): boolean;
}

// Processes the requests initiated by the Charging Station
export interface Ocpp201RequestHandler {
  handleRequest(action: Ocpp201IncomingAction, payload: Ocpp201Payload): Promise<Ocpp201Payload>;
}

export interface Ocpp201ConnectionIdentity {
  tenantID: string;
  tokenID: string;
  chargingStationID: string;
  clientIP: string;
}

interface PendingRequest {
  messageID: string;
  action: Ocpp201OutgoingAction;
  resolve: (payload: Ocpp201Payload) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// One OCPP-J 2.0.1 WebSocket connection with a Charging Station
export default class Ocpp201Connection {
  public readonly guid = randomUUID();
  public readonly identity: Ocpp201ConnectionIdentity;
  public readonly connectedOn = new Date();
  private readonly socket: Ocpp201Socket;
  private readonly requestTimeoutMillis: number;
  private requestHandler: Ocpp201RequestHandler;
  private closed = false;
  // Requests from the Charging Station are processed one after the other
  private incomingQueue: Promise<void>;
  private resolveInitialization: (ready: boolean) => void;
  // Requests to the Charging Station are sent one after the other (one outstanding CALL at a time)
  private outgoingQueue: Promise<unknown> = Promise.resolve();
  private pendingRequest: PendingRequest | null = null;

  public constructor(socket: Ocpp201Socket, identity: Ocpp201ConnectionIdentity, requestTimeoutMillis = Constants.OCPP_SOCKET_TIMEOUT_MILLIS) {
    this.socket = socket;
    this.identity = identity;
    this.requestTimeoutMillis = requestTimeoutMillis;
    // Messages received before the end of the initialization are kept until then
    this.incomingQueue = new Promise<boolean>((resolve) => {
      this.resolveInitialization = resolve;
    }).then(() => { /* Ready */ });
  }

  private static isResponseMessageType(messageType: unknown): boolean {
    return messageType === Ocpp201MessageType.CALL_RESULT || messageType === Ocpp201MessageType.CALL_ERROR;
  }

  private static truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? value.substring(0, maxLength) : value;
  }

  public getKey(): string {
    return `${this.identity.tenantID}~${this.identity.chargingStationID}`;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  // Must be called once the connection has been accepted
  public setRequestHandler(requestHandler: Ocpp201RequestHandler): void {
    this.requestHandler = requestHandler;
    this.resolveInitialization(true);
  }

  public getRequestHandler(): Ocpp201RequestHandler {
    return this.requestHandler;
  }

  public ping(): boolean {
    if (this.closed) {
      return false;
    }
    try {
      return this.socket.ping();
    } catch (error) {
      return false;
    }
  }

  public onMessage(message: string): void {
    if (this.closed) {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch (error) {
      this.sendCallError(UNKNOWN_MESSAGE_ID, Ocpp201ErrorCode.RPC_FRAMEWORK_ERROR, 'Message is not a valid JSON');
      this.logWarning(`Received an invalid JSON message: '${Ocpp201Connection.truncate(message, 500)}'`);
      return;
    }
    if (!Array.isArray(frame)) {
      this.sendCallError(UNKNOWN_MESSAGE_ID, Ocpp201ErrorCode.RPC_FRAMEWORK_ERROR, 'Message is not a JSON array');
      return;
    }
    const messageType = frame[0];
    const messageID = frame[1];
    if (typeof messageID !== 'string' || messageID.length === 0 || messageID.length > OCPP201_MESSAGE_ID_MAX_LENGTH) {
      // Do not answer to a response
      if (messageType === Ocpp201MessageType.CALL || !Ocpp201Connection.isResponseMessageType(messageType)) {
        this.sendCallError(UNKNOWN_MESSAGE_ID, Ocpp201ErrorCode.RPC_FRAMEWORK_ERROR, 'MessageId is invalid');
      } else {
        this.logWarning(`Received a response with an invalid MessageId: '${Ocpp201Connection.truncate(message, 500)}'`);
      }
      return;
    }
    switch (messageType) {
      case Ocpp201MessageType.CALL:
        // Process incoming requests sequentially
        this.incomingQueue = this.incomingQueue
          .then(async () => this.processCall(frame as unknown[], messageID))
          .catch((error) => {
            // Never block the next requests
            this.logError(`Unexpected error while processing a request: ${(error as Error)?.message}`, { error: (error as Error)?.stack });
          });
        break;
      case Ocpp201MessageType.CALL_RESULT:
        // Responses are processed right away as an incoming request can be waiting for them
        this.processCallResult(frame as unknown[], messageID);
        break;
      case Ocpp201MessageType.CALL_ERROR:
        this.processCallError(frame as unknown[], messageID);
        break;
      default:
        this.sendCallError(messageID, Ocpp201ErrorCode.MESSAGE_TYPE_NOT_SUPPORTED, `Message type '${String(messageType)}' is not supported`);
    }
  }

  // Send a request to the Charging Station and wait for its response
  public async sendRequest(action: Ocpp201OutgoingAction, payload: Ocpp201Payload): Promise<Ocpp201Payload> {
    // Fail fast on an invalid request (programming error)
    Ocpp201SchemaValidator.getInstance().validateOutgoingRequest(action, payload);
    const execute = async () => this.executeRequest(action, payload);
    const result = this.outgoingQueue.then(execute, execute);
    this.outgoingQueue = result.catch(() => { /* Handled by the caller */ });
    return result;
  }

  public close(code: number, reason: string): void {
    if (!this.closed) {
      try {
        this.socket.close(code, reason);
      } catch (error) {
        // Already closed
      }
      this.onClosed();
    }
  }

  // Called when the underlying WebSocket is closed
  public onClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Release messages waiting for the initialization
    this.resolveInitialization(false);
    if (this.pendingRequest) {
      clearTimeout(this.pendingRequest.timeout);
      this.pendingRequest.reject(new Error(`Connection closed before the response to '${this.pendingRequest.action}' was received`));
      this.pendingRequest = null;
    }
  }

  private async processCall(frame: unknown[], messageID: string): Promise<void> {
    if (this.closed || !this.requestHandler) {
      return;
    }
    const action = frame[2];
    const payload = frame[3];
    if (frame.length !== 4 || typeof action !== 'string') {
      this.sendCallError(messageID, Ocpp201ErrorCode.RPC_FRAMEWORK_ERROR, 'CALL must be [2, "<MessageId>", "<Action>", {<Payload>}]');
      return;
    }
    if (!INCOMING_ACTIONS.has(action)) {
      if (OUTGOING_ACTIONS.has(action)) {
        this.sendCallError(messageID, Ocpp201ErrorCode.NOT_SUPPORTED, `Action '${action}' can only be sent by the CSMS`);
      } else {
        this.sendCallError(messageID, Ocpp201ErrorCode.NOT_IMPLEMENTED, `Action '${action}' is unknown`);
      }
      return;
    }
    const incomingAction = action as Ocpp201IncomingAction;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      this.sendCallError(messageID, Ocpp201ErrorCode.FORMAT_VIOLATION, 'Payload must be a JSON object');
      return;
    }
    const validator = Ocpp201SchemaValidator.getInstance();
    let response: Ocpp201Payload;
    try {
      validator.validateIncomingRequest(incomingAction, payload as Ocpp201Payload);
      response = await this.requestHandler.handleRequest(incomingAction, payload as Ocpp201Payload);
    } catch (error) {
      if (error instanceof Ocpp201Error) {
        this.sendCallError(messageID, error.code, error.message, error.details);
        if (error.code === Ocpp201ErrorCode.INTERNAL_ERROR || error.code === Ocpp201ErrorCode.GENERIC_ERROR) {
          this.logError(`Error while processing '${action}': ${error.message}`, { payload, error: error.stack });
        } else {
          this.logWarning(`Rejected '${action}' with '${error.code}': ${error.message}`, { payload });
        }
      } else {
        this.sendCallError(messageID, Ocpp201ErrorCode.INTERNAL_ERROR, `Error while processing '${action}'`);
        this.logError(`Unexpected error while processing '${action}': ${(error as Error)?.message}`, { payload, error: (error as Error)?.stack });
      }
      return;
    }
    // Never send a response that does not comply with the specification
    try {
      validator.validateOutgoingResponse(incomingAction, response);
    } catch (error) {
      this.sendCallError(messageID, Ocpp201ErrorCode.INTERNAL_ERROR, `Error while processing '${action}'`);
      this.logError(`Invalid response built for '${action}': ${(error as Error)?.message}`, { payload, response });
      return;
    }
    this.send([Ocpp201MessageType.CALL_RESULT, messageID, response]);
  }

  private processCallResult(frame: unknown[], messageID: string): void {
    const payload = frame[2];
    const pendingRequest = this.getPendingRequest(messageID, frame);
    if (!pendingRequest) {
      return;
    }
    if (frame.length !== 3 || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      pendingRequest.reject(new Ocpp201Error(Ocpp201ErrorCode.FORMAT_VIOLATION, `Invalid response received for '${pendingRequest.action}'`));
      return;
    }
    try {
      Ocpp201SchemaValidator.getInstance().validateIncomingResponse(pendingRequest.action, payload as Ocpp201Payload);
    } catch (error) {
      // Keep the response: the caller handles unexpected values
      this.logWarning(`Response to '${pendingRequest.action}' does not comply with OCPP 2.0.1: ${(error as Error).message}`, { payload });
    }
    pendingRequest.resolve(payload as Ocpp201Payload);
  }

  private processCallError(frame: unknown[], messageID: string): void {
    const pendingRequest = this.getPendingRequest(messageID, frame);
    if (!pendingRequest) {
      return;
    }
    const errorCode = typeof frame[2] === 'string' ? frame[2] : Ocpp201ErrorCode.GENERIC_ERROR;
    const errorDescription = typeof frame[3] === 'string' ? frame[3] : '';
    const errorDetails = (typeof frame[4] === 'object' && frame[4] !== null) ? frame[4] as Record<string, unknown> : {};
    pendingRequest.reject(new Ocpp201Error(errorCode as Ocpp201ErrorCode,
      `Charging Station replied to '${pendingRequest.action}' with error '${errorCode}'${errorDescription ? `: ${errorDescription}` : ''}`, errorDetails));
  }

  // Returns the pending request matching the response and removes it, or null if the response is unexpected
  private getPendingRequest(messageID: string, frame: unknown[]): PendingRequest | null {
    const pendingRequest = this.pendingRequest;
    if (!pendingRequest || pendingRequest.messageID !== messageID) {
      this.logWarning(`Received a response to an unknown request with MessageId '${messageID}', it will be ignored`, { frame });
      return null;
    }
    clearTimeout(pendingRequest.timeout);
    this.pendingRequest = null;
    return pendingRequest;
  }

  private async executeRequest(action: Ocpp201OutgoingAction, payload: Ocpp201Payload): Promise<Ocpp201Payload> {
    if (this.closed) {
      throw new Error(`Cannot send '${action}': connection is closed`);
    }
    return new Promise<Ocpp201Payload>((resolve, reject) => {
      const messageID = randomUUID();
      this.pendingRequest = {
        messageID, action, resolve, reject,
        timeout: setTimeout(() => {
          if (this.pendingRequest?.messageID === messageID) {
            this.pendingRequest = null;
            reject(new Error(`Timeout after ${this.requestTimeoutMillis / 1000} secs waiting for the response to '${action}'`));
          }
        }, this.requestTimeoutMillis),
      };
      if (!this.send([Ocpp201MessageType.CALL, messageID, action, payload])) {
        clearTimeout(this.pendingRequest.timeout);
        this.pendingRequest = null;
        reject(new Error(`Cannot send '${action}' to the Charging Station`));
      }
    });
  }

  private sendCallError(messageID: string, errorCode: Ocpp201ErrorCode, errorDescription: string, errorDetails: Record<string, unknown> = {}): void {
    this.send([Ocpp201MessageType.CALL_ERROR, messageID, errorCode,
      Ocpp201Connection.truncate(errorDescription, ERROR_DESCRIPTION_MAX_LENGTH), errorDetails ?? {}]);
  }

  private send(frame: unknown[]): boolean {
    if (this.closed) {
      return false;
    }
    try {
      return this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.logError(`Cannot send message: ${(error as Error)?.message}`, { frame });
      return false;
    }
  }

  private logWarning(message: string, detailedMessages?: Record<string, unknown>): void {
    Ocpp201Logger.warning({
      tenantID: this.identity.tenantID,
      chargingStationID: this.identity.chargingStationID,
      action: ServerAction.WS_SERVER_MESSAGE,
      module: MODULE_NAME, method: 'onMessage',
      message, detailedMessages
    });
  }

  private logError(message: string, detailedMessages?: Record<string, unknown>): void {
    Ocpp201Logger.error({
      tenantID: this.identity.tenantID,
      chargingStationID: this.identity.chargingStationID,
      action: ServerAction.WS_SERVER_MESSAGE,
      module: MODULE_NAME, method: 'onMessage',
      message, detailedMessages
    });
  }
}
