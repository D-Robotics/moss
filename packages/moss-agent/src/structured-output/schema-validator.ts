








export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean | JsonSchema;
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
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

export interface SchemaValidationError {
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface SchemaDefinitionValidationResult {
  valid: boolean;
  errors: string[];
}










/** Max schema nesting depth. Schemas are LLM-provided and purely-recursively
 *  validated; without a cap a pathologically deep schema overflows the call
 *  stack (RangeError). 64 is well beyond any realistic schema. */
export const MAX_SCHEMA_DEPTH = 64;

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = '$',
  depth = 0,
  rootSchema: JsonSchema = schema
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  if (depth === 0) {
    const definition = validateJsonSchemaDefinition(rootSchema);
    if (!definition.valid) {
      return {
        valid: false,
        errors: definition.errors.map((message) => ({ path: '$schema', message })),
      };
    }
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    addError(`schema nesting exceeds max depth (${MAX_SCHEMA_DEPTH}) — refusing to recurse further`);
    return { valid: false, errors };
  }

  function addError(msg: string, expected?: string, actual?: string): void {
    errors.push({
      path,
      message: msg,
      expected,
      actual: actual !== undefined ? String(actual).slice(0, 200) : undefined,
    });
  }

  if (schema.$ref) {
    const referenced = resolveLocalSchemaRef(rootSchema, schema.$ref);
    if (!referenced) {
      addError(`Unable to resolve schema reference: ${schema.$ref}`);
      return { valid: false, errors };
    }
    const result = validateJsonSchema(value, referenced, path, depth + 1, rootSchema);
    if (!result.valid) return result;
  }

  
  if (value === null) {
    if (schema.type && !schemaIncludesType(schema.type, value)) {
      addError(`Expected type ${describeType(schema.type)} but got null`);
      return { valid: false, errors };
    }
    return { valid: true, errors: [] };
  }

  
  if (schema.type) {
    const actualType = getJsonType(value);
    if (!schemaIncludesType(schema.type, value)) {
      addError(`Expected type ${describeType(schema.type)} but got ${actualType}`);
      return { valid: false, errors };
    }
  }

  
  if (schema.enum) {
    const match = schema.enum.some((e) => deepEqual(value, e));
    if (!match) {
      addError(`Value must be one of: ${JSON.stringify(schema.enum)}`);
      return { valid: false, errors };
    }
  }

  
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    addError(`Value must equal ${JSON.stringify(schema.const)}`);
    return { valid: false, errors };
  }

  
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          addError(`Missing required property: "${key}"`);
        }
      }
    }

    
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const result = validateJsonSchema(
            obj[key],
            propSchema,
            `${path}.${key}`,
            depth + 1,
            rootSchema
          );
          errors.push(...result.errors);
        }
      }
    }

    
    if (schema.additionalProperties === false) {
      const knownKeys = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          addError(`Unexpected property: "${key}"`);
        }
      }
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === 'object'
    ) {
      const knownKeys = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, propertyValue] of Object.entries(obj)) {
        if (knownKeys.has(key)) continue;
        const result = validateJsonSchema(
          propertyValue,
          schema.additionalProperties,
          `${path}.${key}`,
          depth + 1,
          rootSchema
        );
        errors.push(...result.errors);
      }
    }
  }

  
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      addError(`Array must have at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      addError(`Array must have at most ${schema.maxItems} items, got ${value.length}`);
    }
    if (schema.uniqueItems && hasDuplicates(value)) {
      addError('Array items must be unique');
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemSchema = Array.isArray(schema.items) ? schema.items[i] : schema.items;
        if (itemSchema) {
          const result = validateJsonSchema(
            value[i],
            itemSchema,
            `${path}[${i}]`,
            depth + 1,
            rootSchema
          );
          errors.push(...result.errors);
        }
      }
    }
  }

  
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      addError(`String must be at least ${schema.minLength} characters, got ${value.length}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      addError(`String must be at most ${schema.maxLength} characters, got ${value.length}`);
    }
    if (schema.pattern) {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          addError(`String must match pattern: ${schema.pattern}`);
        }
      } catch {
        
      }
    }
    if (schema.format) {
      const formatValid = validateFormat(value, schema.format);
      if (!formatValid) {
        addError(`String must be a valid ${schema.format}`);
      }
    }
  }

  
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      addError(`Number must be >= ${schema.minimum}, got ${value}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      addError(`Number must be <= ${schema.maximum}, got ${value}`);
    }
  }

  
  if (schema.anyOf) {
    const match = schema.anyOf.some(
      (s) => validateJsonSchema(value, s, path, depth + 1, rootSchema).valid
    );
    if (!match) {
      addError('Value must match at least one of the anyOf schemas');
    }
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (s) => validateJsonSchema(value, s, path, depth + 1, rootSchema).valid
    );
    if (matches.length !== 1) {
      addError(`Value must match exactly one of the oneOf schemas (matched ${matches.length})`);
    }
  }

  if (schema.allOf) {
    for (const s of schema.allOf) {
      const result = validateJsonSchema(value, s, path, depth + 1, rootSchema);
      errors.push(...result.errors);
    }
  }

  if (schema.not) {
    const result = validateJsonSchema(value, schema.not, path, depth + 1, rootSchema);
    if (result.valid) {
      addError('Value must not match the "not" schema');
    }
  }

  
  if (schema.if) {
    const ifResult = validateJsonSchema(value, schema.if, path, depth + 1, rootSchema);
    if (ifResult.valid && schema.then) {
      const thenResult = validateJsonSchema(value, schema.then, path, depth + 1, rootSchema);
      errors.push(...thenResult.errors);
    } else if (!ifResult.valid && schema.else) {
      const elseResult = validateJsonSchema(value, schema.else, path, depth + 1, rootSchema);
      errors.push(...elseResult.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

const SUPPORTED_SCHEMA_TYPES = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'integer',
  'string',
]);

const SUPPORTED_SCHEMA_FORMATS = new Set([
  'date-time',
  'date',
  'time',
  'email',
  'uri',
  'url',
  'ipv4',
  'ipv6',
  'uuid',
  'hostname',
]);

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$ref',
  '$defs',
  'definitions',
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'additionalProperties',
  'description',
  'title',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$schema',
  '$id',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

export function validateJsonSchemaDefinition(schema: JsonSchema): SchemaDefinitionValidationResult {
  const errors: string[] = [];
  const visited = new WeakSet<object>();

  const visit = (current: unknown, path: string, depth = 0): void => {
    if (depth > MAX_SCHEMA_DEPTH) {
      errors.push(`${path}: schema nesting exceeds max depth (${MAX_SCHEMA_DEPTH})`);
      return;
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      errors.push(`${path}: schema must be an object`);
      return;
    }
    if (visited.has(current)) return;
    visited.add(current);
    const record = current as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (!SUPPORTED_SCHEMA_KEYWORDS.has(key) && !key.startsWith('x-')) {
        errors.push(`${path}: unsupported schema keyword "${key}"`);
      }
    }

    const types = Array.isArray(record.type) ? record.type : [record.type];
    if (record.type !== undefined && (
      types.length === 0 || types.some((type) => typeof type !== 'string' || !SUPPORTED_SCHEMA_TYPES.has(type))
    )) {
      errors.push(`${path}.type: expected a supported JSON Schema type`);
    }
    if (record.$ref !== undefined) {
      if (typeof record.$ref !== 'string' || !record.$ref.startsWith('#')) {
        errors.push(`${path}.$ref: only local references beginning with # are supported`);
      } else if (!resolveLocalSchemaRef(schema, record.$ref)) {
        errors.push(`${path}.$ref: unable to resolve ${record.$ref}`);
      }
    }
    if (record.pattern !== undefined) {
      if (typeof record.pattern !== 'string') {
        errors.push(`${path}.pattern: expected a string`);
      } else {
        try {
          new RegExp(record.pattern);
        } catch {
          errors.push(`${path}.pattern: invalid regular expression`);
        }
      }
    }
    if (
      record.format !== undefined &&
      (typeof record.format !== 'string' || !SUPPORTED_SCHEMA_FORMATS.has(record.format))
    ) {
      errors.push(`${path}.format: unsupported format "${String(record.format)}"`);
    }
    if (record.required !== undefined && (
      !Array.isArray(record.required) || record.required.some((key) => typeof key !== 'string')
    )) {
      errors.push(`${path}.required: expected an array of property names`);
    }

    for (const collectionKey of ['properties', '$defs', 'definitions'] as const) {
      const collection = record[collectionKey];
      if (collection === undefined) continue;
      if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
        errors.push(`${path}.${collectionKey}: expected an object`);
        continue;
      }
      for (const [key, child] of Object.entries(collection)) {
        visit(child, `${path}.${collectionKey}.${key}`, depth + 1);
      }
    }
    if (record.items !== undefined) {
      if (Array.isArray(record.items)) {
        record.items.forEach((child, index) => visit(child, `${path}.items[${index}]`, depth + 1));
      } else {
        visit(record.items, `${path}.items`, depth + 1);
      }
    }
    if (record.additionalProperties !== undefined && typeof record.additionalProperties !== 'boolean') {
      visit(record.additionalProperties, `${path}.additionalProperties`, depth + 1);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const collection = record[key];
      if (collection === undefined) continue;
      if (!Array.isArray(collection) || collection.length === 0) {
        errors.push(`${path}.${key}: expected a non-empty schema array`);
        continue;
      }
      collection.forEach((child, index) => visit(child, `${path}.${key}[${index}]`, depth + 1));
    }
    for (const key of ['not', 'if', 'then', 'else'] as const) {
      if (record[key] !== undefined) visit(record[key], `${path}.${key}`, depth + 1);
    }
  };

  visit(schema, '$');
  return { valid: errors.length === 0, errors };
}

function schemaIncludesType(schemaType: string | string[], value: unknown): boolean {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  const actualType = getJsonType(value);
  return types.some((type) => (
    type === actualType ||
    (type === 'integer' && actualType === 'number' && Number.isInteger(value))
  ));
}

function resolveLocalSchemaRef(rootSchema: JsonSchema, ref: string): JsonSchema | undefined {
  if (ref === '#') return rootSchema;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = rootSchema;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as JsonSchema
    : undefined;
}

function describeType(t: string | string[]): string {
  return Array.isArray(t) ? t.join(' | ') : t;
}

function getJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  // Key-order-insensitive structural equality. The previous JSON.stringify
  // comparison treated {a:1,b:2} and {b:2,a:1} as unequal, so `enum`/`const`
  // checks falsely rejected valid objects whose key order differed from the
  // schema's. JSON-parsed values are acyclic (JSON.parse can't form cycles),
  // so no cycle guard is needed here.
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const ka = Object.keys(objA);
  const kb = Object.keys(objB);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

function hasDuplicates(arr: unknown[]): boolean {
  for (let index = 0; index < arr.length; index++) {
    for (let compared = index + 1; compared < arr.length; compared++) {
      if (deepEqual(arr[index], arr[compared])) return true;
    }
  }
  return false;
}

function validateFormat(value: string, format: string): boolean {
  switch (format) {
    case 'date-time':
      return !isNaN(Date.parse(value));
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
    case 'time':
      return /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value);
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri':
    case 'url':
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case 'ipv4':
      return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
    case 'ipv6':
      return /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    case 'hostname':
      return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
        value
      );
    default:
      return true; 
  }
}






export function generateSchemaDescription(schema: JsonSchema, indent = 0): string {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  if (schema.description) {
    lines.push(`${prefix}// ${schema.description}`);
  }

  // Handle oneOf / anyOf / allOf
  if (schema.oneOf) {
    lines.push(`${prefix}One of:`);
    for (let i = 0; i < schema.oneOf.length; i++) {
      const oneOfSchema = schema.oneOf[i];
      lines.push(`${prefix}  Option ${i + 1}:`);
      lines.push(generateSchemaDescription(oneOfSchema, indent + 2));
    }
    return lines.join('\n');
  }

  if (schema.anyOf) {
    lines.push(`${prefix}Any of:`);
    for (let i = 0; i < schema.anyOf.length; i++) {
      const anyOfSchema = schema.anyOf[i];
      lines.push(`${prefix}  Option ${i + 1}:`);
      lines.push(generateSchemaDescription(anyOfSchema, indent + 2));
    }
    return lines.join('\n');
  }

  // Handle object type
  if (schema.type === 'object' && schema.properties) {
    lines.push(`${prefix}{`);
    const keys = Object.keys(schema.properties);
    const required = new Set(schema.required ?? []);
    for (const key of keys) {
      const prop = schema.properties[key];
      const marker = required.has(key) ? ' (required)' : ' (optional)';
      const typeStr = Array.isArray(prop.type) ? prop.type.join(' | ') : prop.type || 'any';
      const constraints: string[] = [];
      if (prop.minLength !== undefined) constraints.push(`minLength: ${prop.minLength}`);
      if (prop.maxLength !== undefined) constraints.push(`maxLength: ${prop.maxLength}`);
      if (prop.pattern) constraints.push(`pattern: ${prop.pattern}`);
      if (prop.minimum !== undefined) constraints.push(`min: ${prop.minimum}`);
      if (prop.maximum !== undefined) constraints.push(`max: ${prop.maximum}`);
      if (prop.minItems !== undefined) constraints.push(`minItems: ${prop.minItems}`);
      if (prop.maxItems !== undefined) constraints.push(`maxItems: ${prop.maxItems}`);
      if (prop.uniqueItems) constraints.push('unique items');

      const constraintStr = constraints.length > 0 ? ` [${constraints.join(', ')}]` : '';

      if (prop.enum) {
        const enumVals = prop.enum.map((v) => JSON.stringify(v)).join(', ');
        lines.push(
          `${prefix}  "${key}": ${typeStr}${marker}${constraintStr} // one of: [${enumVals}]`
        );
      } else if (prop.description) {
        lines.push(`${prefix}  "${key}": ${typeStr}${marker}${constraintStr} // ${prop.description}`);
      } else {
        lines.push(`${prefix}  "${key}": ${typeStr}${marker}${constraintStr}`);
      }
    }
    lines.push(`${prefix}}`);
  } else if (schema.type === 'array' && schema.items) {
    // Handle array with detailed item info
    const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    const itemType = itemSchema?.type || 'any';
    const itemTypeStr = typeof itemType === 'string' ? itemType : itemType.join(' | ');

    const constraints: string[] = [];
    if (schema.minItems !== undefined) constraints.push(`min: ${schema.minItems}`);
    if (schema.maxItems !== undefined) constraints.push(`max: ${schema.maxItems}`);
    if (schema.uniqueItems) constraints.push('unique');
    const constraintStr = constraints.length > 0 ? ` [${constraints.join(', ')}]` : '';

    if (schema.description) {
      lines.push(`${prefix}Array<${itemTypeStr}>${constraintStr}`);
    } else {
      lines.push(`${prefix}Array<${itemTypeStr}>${constraintStr}`);
    }

    // If array items are objects, expand their structure
    if (itemSchema?.type === 'object' && itemSchema.properties) {
      lines.push(`${prefix}  where each item is:`);
      lines.push(generateSchemaDescription(itemSchema, indent + 2));
    }
  } else {
    // Handle primitive types
    const typeStr = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type || 'any';
    const constraints: string[] = [];
    if (schema.minLength !== undefined) constraints.push(`minLength: ${schema.minLength}`);
    if (schema.maxLength !== undefined) constraints.push(`maxLength: ${schema.maxLength}`);
    if (schema.pattern) constraints.push(`pattern: ${schema.pattern}`);
    if (schema.minimum !== undefined) constraints.push(`min: ${schema.minimum}`);
    if (schema.maximum !== undefined) constraints.push(`max: ${schema.maximum}`);
    const constraintStr = constraints.length > 0 ? ` [${constraints.join(', ')}]` : '';

    if (schema.enum) {
      const enumVals = schema.enum.map((v) => JSON.stringify(v)).join(', ');
      lines.push(`${prefix}${typeStr}${constraintStr} — one of: [${enumVals}]`);
    } else {
      lines.push(`${prefix}${typeStr}${constraintStr}`);
    }
  }

  return lines.join('\n');
}






export function mergeSchemas(schemas: JsonSchema[]): JsonSchema {
  if (schemas.length === 0) return { type: 'object' };
  if (schemas.length === 1) return schemas[0];

  const merged: JsonSchema = {
    type: 'object',
    properties: {},
    required: [],
  };

  for (const schema of schemas) {
    if (schema.properties) {
      Object.assign(merged.properties!, schema.properties);
    }
    if (schema.required) {
      for (const key of schema.required) {
        if (!merged.required!.includes(key)) {
          merged.required!.push(key);
        }
      }
    }
  }

  return merged;
}
