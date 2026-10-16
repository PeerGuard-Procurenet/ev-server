import { Ocpp201ErrorCode } from './types/Ocpp201Types';

// Error that is reported to the peer in an OCPP-J CALLERROR frame
export default class Ocpp201Error extends Error {
  public readonly code: Ocpp201ErrorCode;
  public readonly details: Record<string, unknown>;

  public constructor(code: Ocpp201ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'Ocpp201Error';
    this.code = code;
    this.details = details;
  }
}
