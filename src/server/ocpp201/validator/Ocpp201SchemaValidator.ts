import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { Ocpp201ErrorCode, Ocpp201IncomingAction, Ocpp201OutgoingAction, Ocpp201Payload } from '../types/Ocpp201Types';

import Ocpp201Error from '../Ocpp201Error';
import addFormats from 'ajv-formats';
import draft06MetaSchema from 'ajv/dist/refs/json-schema-draft-06.json';
import fs from 'fs';
import global from '../../../types/GlobalType';
import path from 'path';

type SchemaKind = 'Request' | 'Response';

// Validates OCPP 2.0.1 payloads against the official OCA JSON schemas (strict: no type coercion, no property removal)
export default class Ocpp201SchemaValidator {
  private static instance: Ocpp201SchemaValidator | null = null;
  private readonly validators = new Map<string, ValidateFunction>();

  private constructor(schemasDirectory: string) {
    const ajv = new Ajv({
      strict: false, // Official schemas contain the non-standard 'javaType' and 'comment' keywords
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    ajv.addMetaSchema(draft06MetaSchema);
    addFormats(ajv, ['date-time']);
    for (const fileName of fs.readdirSync(schemasDirectory)) {
      if (!fileName.endsWith('.json')) {
        continue;
      }
      const schema = JSON.parse(fs.readFileSync(path.join(schemasDirectory, fileName), 'utf8'));
      this.validators.set(fileName.replace('.json', ''), ajv.compile(schema));
    }
  }

  public static getInstance(): Ocpp201SchemaValidator {
    if (!Ocpp201SchemaValidator.instance) {
      Ocpp201SchemaValidator.instance = new Ocpp201SchemaValidator(Ocpp201SchemaValidator.getSchemasDirectory());
    }
    return Ocpp201SchemaValidator.instance;
  }

  public static mapValidationErrorToErrorCode(error: ErrorObject): Ocpp201ErrorCode {
    switch (error.keyword) {
      case 'required':
      case 'minItems':
      case 'maxItems':
        return Ocpp201ErrorCode.OCCURRENCE_CONSTRAINT_VIOLATION;
      case 'type':
        // Payload itself is not a JSON object
        if (error.instancePath === '') {
          return Ocpp201ErrorCode.FORMAT_VIOLATION;
        }
        return Ocpp201ErrorCode.TYPE_CONSTRAINT_VIOLATION;
      case 'enum':
      case 'const':
      case 'maxLength':
      case 'minLength':
      case 'pattern':
      case 'format':
      case 'minimum':
      case 'maximum':
      case 'exclusiveMinimum':
      case 'exclusiveMaximum':
      case 'multipleOf':
        return Ocpp201ErrorCode.PROPERTY_CONSTRAINT_VIOLATION;
      default:
        // 'additionalProperties' and any other structural violation
        return Ocpp201ErrorCode.FORMAT_VIOLATION;
    }
  }

  private static getSchemasDirectory(): string {
    if (global.appRoot) {
      return `${global.appRoot}/assets/server/ocpp201/schemas`;
    }
    return path.resolve(__dirname, '../../../assets/server/ocpp201/schemas');
  }

  public hasSchema(action: string, kind: SchemaKind): boolean {
    return this.validators.has(`${action}${kind}`);
  }

  public validateIncomingRequest(action: Ocpp201IncomingAction, payload: Ocpp201Payload): void {
    this.validate(action, 'Request', payload);
  }

  public validateOutgoingResponse(action: Ocpp201IncomingAction, payload: Ocpp201Payload): void {
    this.validate(action, 'Response', payload);
  }

  public validateOutgoingRequest(action: Ocpp201OutgoingAction, payload: Ocpp201Payload): void {
    this.validate(action, 'Request', payload);
  }

  public validateIncomingResponse(action: Ocpp201OutgoingAction, payload: Ocpp201Payload): void {
    this.validate(action, 'Response', payload);
  }

  private validate(action: string, kind: SchemaKind, payload: Ocpp201Payload): void {
    const validateFunction = this.validators.get(`${action}${kind}`);
    if (!validateFunction) {
      throw new Ocpp201Error(Ocpp201ErrorCode.NOT_IMPLEMENTED, `No OCPP 2.0.1 schema found for '${action}${kind}'`);
    }
    if (!validateFunction(payload)) {
      const errors = validateFunction.errors ?? [];
      const firstError = errors[0];
      const code = firstError ? Ocpp201SchemaValidator.mapValidationErrorToErrorCode(firstError) : Ocpp201ErrorCode.FORMAT_VIOLATION;
      const description = errors.slice(0, 5).map((error) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}${error.keyword === 'additionalProperties' ? ` '${error.params?.additionalProperty as string}'` : ''}`
      ).join('; ');
      throw new Ocpp201Error(code, `${action}${kind} is invalid: ${description}`, {
        errors: errors.slice(0, 5).map((error) => ({ path: error.instancePath, keyword: error.keyword, message: error.message, params: error.params }))
      });
    }
  }
}
