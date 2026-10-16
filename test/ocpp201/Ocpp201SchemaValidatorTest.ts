import { Ocpp201ErrorCode, Ocpp201IncomingAction, Ocpp201OutgoingAction } from '../../src/server/ocpp201/types/Ocpp201Types';
import { describe, expect, it } from '@jest/globals';

import Ocpp201Error from '../../src/server/ocpp201/Ocpp201Error';
import Ocpp201SchemaValidator from '../../src/server/ocpp201/validator/Ocpp201SchemaValidator';

const validator = Ocpp201SchemaValidator.getInstance();

const validBootNotification = {
  chargingStation: { vendorName: 'Factory', model: 'AC22', serialNumber: '20241012000005', firmwareVersion: '1.0.0' },
  reason: 'PowerUp',
};

function expectErrorCode(fct: () => void, code: Ocpp201ErrorCode): void {
  let error: unknown;
  try {
    fct();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Ocpp201Error);
  expect((error as Ocpp201Error).code).toBe(code);
}

describe('OCPP 2.0.1 schema validator', () => {
  it('should load the request and response schemas of every action', () => {
    for (const action of [...Object.values(Ocpp201IncomingAction), ...Object.values(Ocpp201OutgoingAction)]) {
      expect(validator.hasSchema(action, 'Request')).toBe(true);
      expect(validator.hasSchema(action, 'Response')).toBe(true);
    }
  });

  it('should accept a valid BootNotification', () => {
    expect(() => validator.validateIncomingRequest(Ocpp201IncomingAction.BOOT_NOTIFICATION, validBootNotification)).not.toThrow();
  });

  it('should accept custom data', () => {
    expect(() => validator.validateIncomingRequest(Ocpp201IncomingAction.HEARTBEAT, { customData: { vendorId: 'Factory', anything: 1 } })).not.toThrow();
  });

  it('should report a missing required property as OccurrenceConstraintViolation', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.BOOT_NOTIFICATION, { reason: 'PowerUp' }),
      Ocpp201ErrorCode.OCCURRENCE_CONSTRAINT_VIOLATION);
  });

  it('should report an empty array violating minItems as OccurrenceConstraintViolation', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.METER_VALUES, { evseId: 1, meterValue: [] }),
      Ocpp201ErrorCode.OCCURRENCE_CONSTRAINT_VIOLATION);
  });

  it('should report a wrong type as TypeConstraintViolation', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.STATUS_NOTIFICATION, {
      timestamp: '2024-10-12T10:00:00Z', connectorStatus: 'Available', evseId: '1', connectorId: 1
    }), Ocpp201ErrorCode.TYPE_CONSTRAINT_VIOLATION);
  });

  it('should report an invalid enum value as PropertyConstraintViolation', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.STATUS_NOTIFICATION, {
      timestamp: '2024-10-12T10:00:00Z', connectorStatus: 'Charging', evseId: 1, connectorId: 1
    }), Ocpp201ErrorCode.PROPERTY_CONSTRAINT_VIOLATION);
  });

  it('should report a too long string as PropertyConstraintViolation', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.BOOT_NOTIFICATION, {
      ...validBootNotification, chargingStation: { ...validBootNotification.chargingStation, model: 'X'.repeat(21) }
    }), Ocpp201ErrorCode.PROPERTY_CONSTRAINT_VIOLATION);
  });

  it('should report an invalid date-time as PropertyConstraintViolation', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.STATUS_NOTIFICATION, {
      timestamp: '12/10/2024 10:00', connectorStatus: 'Available', evseId: 1, connectorId: 1
    }), Ocpp201ErrorCode.PROPERTY_CONSTRAINT_VIOLATION);
  });

  it('should report an unknown property as FormatViolation', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.BOOT_NOTIFICATION, { ...validBootNotification, unknown: true }),
      Ocpp201ErrorCode.FORMAT_VIOLATION);
  });

  it('should not coerce types', () => {
    expectErrorCode(() => validator.validateIncomingRequest(Ocpp201IncomingAction.TRANSACTION_EVENT, {
      eventType: 'Started', timestamp: '2024-10-12T10:00:00Z', triggerReason: 'Authorized', seqNo: '0', transactionInfo: { transactionId: 'T1' }
    }), Ocpp201ErrorCode.TYPE_CONSTRAINT_VIOLATION);
  });

  it('should accept every response built by the CSMS', () => {
    const responses: [Ocpp201IncomingAction, Record<string, unknown>][] = [
      [Ocpp201IncomingAction.BOOT_NOTIFICATION, { currentTime: '2024-10-12T10:00:00.000Z', interval: 60, status: 'Accepted' }],
      [Ocpp201IncomingAction.BOOT_NOTIFICATION, { currentTime: '2024-10-12T10:00:00.000Z', interval: 60, status: 'Rejected' }],
      [Ocpp201IncomingAction.HEARTBEAT, { currentTime: '2024-10-12T10:00:00.000Z' }],
      [Ocpp201IncomingAction.STATUS_NOTIFICATION, {}],
      [Ocpp201IncomingAction.AUTHORIZE, { idTokenInfo: { status: 'Accepted' } }],
      [Ocpp201IncomingAction.AUTHORIZE, { idTokenInfo: { status: 'ConcurrentTx' } }],
      [Ocpp201IncomingAction.TRANSACTION_EVENT, {}],
      [Ocpp201IncomingAction.TRANSACTION_EVENT, { idTokenInfo: { status: 'Invalid' } }],
      [Ocpp201IncomingAction.METER_VALUES, {}],
      [Ocpp201IncomingAction.FIRMWARE_STATUS_NOTIFICATION, {}],
      [Ocpp201IncomingAction.LOG_STATUS_NOTIFICATION, {}],
      [Ocpp201IncomingAction.DATA_TRANSFER, { status: 'Accepted' }],
      [Ocpp201IncomingAction.SECURITY_EVENT_NOTIFICATION, {}],
      [Ocpp201IncomingAction.NOTIFY_EVENT, {}],
      [Ocpp201IncomingAction.NOTIFY_REPORT, {}],
      [Ocpp201IncomingAction.NOTIFY_MONITORING_REPORT, {}],
      [Ocpp201IncomingAction.NOTIFY_CUSTOMER_INFORMATION, {}],
      [Ocpp201IncomingAction.NOTIFY_DISPLAY_MESSAGES, {}],
      [Ocpp201IncomingAction.NOTIFY_CHARGING_LIMIT, {}],
      [Ocpp201IncomingAction.CLEARED_CHARGING_LIMIT, {}],
      [Ocpp201IncomingAction.REPORT_CHARGING_PROFILES, {}],
      [Ocpp201IncomingAction.RESERVATION_STATUS_UPDATE, {}],
      [Ocpp201IncomingAction.PUBLISH_FIRMWARE_STATUS_NOTIFICATION, {}],
      [Ocpp201IncomingAction.NOTIFY_EV_CHARGING_NEEDS, { status: 'Rejected' }],
      [Ocpp201IncomingAction.NOTIFY_EV_CHARGING_SCHEDULE, { status: 'Rejected' }],
      [Ocpp201IncomingAction.SIGN_CERTIFICATE, { status: 'Rejected' }],
      [Ocpp201IncomingAction.GET_15118_EV_CERTIFICATE, { status: 'Failed', exiResponse: '' }],
      [Ocpp201IncomingAction.GET_CERTIFICATE_STATUS, { status: 'Failed' }],
    ];
    for (const [action, response] of responses) {
      expect(() => validator.validateOutgoingResponse(action, response)).not.toThrow();
    }
  });

  it('should reject an invalid outgoing request', () => {
    expectErrorCode(() => validator.validateOutgoingRequest(Ocpp201OutgoingAction.RESET, { type: 'Hard' }),
      Ocpp201ErrorCode.PROPERTY_CONSTRAINT_VIOLATION);
  });
});
