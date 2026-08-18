import { ErrorCode, MossError } from '../errors.js';
import {
  validateJsonSchemaDefinition,
  type JsonSchema,
} from '../structured-output/schema-validator.js';

/** JSON Schema subset supported by Moss plugin configuration. @beta */
export interface MossPluginJsonSchema {
  type?: string | string[];
  properties?: Record<string, MossPluginJsonSchema>;
  required?: string[];
  items?: MossPluginJsonSchema | MossPluginJsonSchema[];
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean | MossPluginJsonSchema;
  description?: string;
  title?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  anyOf?: MossPluginJsonSchema[];
  oneOf?: MossPluginJsonSchema[];
  allOf?: MossPluginJsonSchema[];
  not?: MossPluginJsonSchema;
  if?: MossPluginJsonSchema;
  then?: MossPluginJsonSchema;
  else?: MossPluginJsonSchema;
  $ref?: string;
  $defs?: Record<string, MossPluginJsonSchema>;
  definitions?: Record<string, MossPluginJsonSchema>;
}

/** Top-level plugin configuration property supported by the schema renderer/store. @beta */
export interface MossPluginConfigPropertySchema extends MossPluginJsonSchema {
  /** Values marked write-only are never returned by the browser-safe view. */
  readonly writeOnly?: boolean;
}

/** Supported JSON Schema subset for one plugin's configuration object. @beta */
export interface MossPluginConfigSchema extends MossPluginJsonSchema {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, MossPluginConfigPropertySchema>>;
}

/** Parse and validate the supported plugin configuration schema subset. @internal */
export function parseMossPluginConfigSchema(
  value: unknown,
  schemaPath: string
): MossPluginConfigSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSchema(`${schemaPath} must contain a JSON Schema object`);
  }
  const schema = value as JsonSchema;
  const definition = validateJsonSchemaDefinition(schema);
  if (!definition.valid) {
    throw invalidSchema(`${schemaPath} is invalid: ${definition.errors.join('; ')}`);
  }
  if (schema.type !== 'object') {
    throw invalidSchema(`${schemaPath} must declare type "object"`);
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const writeOnly = (property as MossPluginConfigPropertySchema).writeOnly;
    if (writeOnly !== undefined && typeof writeOnly !== 'boolean') {
      throw invalidSchema(`${schemaPath}.properties.${name}.writeOnly must be a boolean`);
    }
  }
  return schema as MossPluginConfigSchema;
}

function invalidSchema(message: string): MossError {
  return new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
}
