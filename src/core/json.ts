import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { fail, type Json } from './types.js';
export const hash = (data: string) => createHash('sha256').update(data).digest('hex');
export const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false });
export function validate(schema: object, value: unknown): void {
  const check = ajv.compile(schema);
  if (!check(value)) fail('invalid_input', JSON.stringify(check.errors));
}
export function json(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k))
        fail('invalid_input', 'Unsafe mapping key');
      json(v);
    }
    return value as Json;
  }
  return fail('invalid_input', 'Expected JSON-compatible data');
}
export const objectSchema = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required, additionalProperties: false });
export const stringSchema = { type: 'string' };
export const nonempty = { type: 'string', minLength: 1 };
