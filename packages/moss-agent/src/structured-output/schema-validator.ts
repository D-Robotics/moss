








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










export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = '$'
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  function addError(msg: string, expected?: string, actual?: string): void {
    errors.push({
      path,
      message: msg,
      expected,
      actual: actual !== undefined ? String(actual).slice(0, 200) : undefined,
    });
  }

  
  if (value === null) {
    if (schema.type && !schemaIncludesType(schema.type, 'null')) {
      addError(`Expected type ${describeType(schema.type)} but got null`);
      return { valid: false, errors };
    }
    return { valid: true, errors: [] };
  }

  
  if (schema.type) {
    const actualType = getJsonType(value);
    if (!schemaIncludesType(schema.type, actualType)) {
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
          const result = validateJsonSchema(obj[key], propSchema, `${path}.${key}`);
          errors.push(...result.errors);
        }
      }
    }

    
    if (schema.additionalProperties === false && schema.properties) {
      const knownKeys = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          addError(`Unexpected property: "${key}"`);
        }
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
      const itemSchemas = Array.isArray(schema.items) ? schema.items : [schema.items];
      for (let i = 0; i < value.length; i++) {
        const itemSchema = itemSchemas[Math.min(i, itemSchemas.length - 1)];
        if (itemSchema) {
          const result = validateJsonSchema(value[i], itemSchema, `${path}[${i}]`);
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
    const match = schema.anyOf.some((s) => validateJsonSchema(value, s).valid);
    if (!match) {
      addError('Value must match at least one of the anyOf schemas');
    }
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => validateJsonSchema(value, s).valid);
    if (matches.length !== 1) {
      addError(`Value must match exactly one of the oneOf schemas (matched ${matches.length})`);
    }
  }

  if (schema.allOf) {
    for (const s of schema.allOf) {
      const result = validateJsonSchema(value, s, path);
      errors.push(...result.errors);
    }
  }

  if (schema.not) {
    const result = validateJsonSchema(value, schema.not);
    if (result.valid) {
      addError('Value must not match the "not" schema');
    }
  }

  
  if (schema.if) {
    const ifResult = validateJsonSchema(value, schema.if);
    if (ifResult.valid && schema.then) {
      const thenResult = validateJsonSchema(value, schema.then, path);
      errors.push(...thenResult.errors);
    } else if (!ifResult.valid && schema.else) {
      const elseResult = validateJsonSchema(value, schema.else, path);
      errors.push(...elseResult.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

function schemaIncludesType(schemaType: string | string[], type: string): boolean {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  return types.includes(type);
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
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasDuplicates(arr: unknown[]): boolean {
  const seen = new Set<string>();
  for (const item of arr) {
    const key = JSON.stringify(item);
    if (seen.has(key)) return true;
    seen.add(key);
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

  if (schema.type === 'object' && schema.properties) {
    lines.push(`${prefix}{`);
    const keys = Object.keys(schema.properties);
    const required = new Set(schema.required ?? []);
    for (const key of keys) {
      const prop = schema.properties[key];
      const marker = required.has(key) ? ' (required)' : ' (optional)';
      const typeStr = Array.isArray(prop.type) ? prop.type.join(' | ') : prop.type || 'any';
      if (prop.enum) {
        lines.push(
          `${prefix}  "${key}": ${typeStr}${marker} // one of: ${JSON.stringify(prop.enum)}`
        );
      } else if (prop.description) {
        lines.push(`${prefix}  "${key}": ${typeStr}${marker} // ${prop.description}`);
      } else {
        lines.push(`${prefix}  "${key}": ${typeStr}${marker}`);
      }
    }
    lines.push(`${prefix}}`);
  } else if (schema.type === 'array' && schema.items) {
    const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    const itemType = itemSchema?.type || 'any';
    lines.push(`${prefix}Array<${typeof itemType === 'string' ? itemType : itemType.join(' | ')}>`);
  } else {
    const typeStr = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type || 'any';
    lines.push(`${prefix}${typeStr}`);
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
