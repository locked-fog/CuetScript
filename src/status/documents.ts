import { isAlias, isScalar, isMap, parseDocument, stringify, visit } from 'yaml';
import patch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import { fail, type Json } from '../core/types.js';
import { json, objectSchema, validate } from '../core/json.js';
export function parseYaml(text: string): Json {
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: true, merge: false });
  if (doc.errors.length) fail('invalid_yaml', doc.errors.map((e) => e.message).join('; '));
  visit(doc, (_key, node) => {
    if (
      isAlias(node) ||
      (node &&
        typeof node === 'object' &&
        (('anchor' in node && node.anchor) || ('tag' in node && node.tag)))
    )
      fail('invalid_yaml', 'Aliases, anchors and tags are forbidden');
    if (isMap(node))
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<')
          fail('invalid_yaml', 'Only string keys without merge keys are allowed');
      }
  });
  return json(doc.toJS());
}
export interface StatusDocument {
  schema_version: 1;
  id: string;
  kind: string;
  status: Record<string, Json>;
}
export function statusDocument(text: string): StatusDocument {
  const result = parseYaml(text);
  validate(
    objectSchema({
      schema_version: { const: 1 },
      id: { type: 'string', minLength: 1 },
      kind: { type: 'string', minLength: 1 },
      status: { type: 'object' },
    }),
    result,
  );
  return result as unknown as StatusDocument;
}
export function pointer(doc: unknown, path: string): Json {
  if (path !== '' && !/^\/(?:[^~]|~[01])*$/.test(path)) fail('invalid_pointer', path);
  let value: unknown = doc;
  for (const token of path === ''
    ? []
    : path
        .slice(1)
        .split('/')
        .map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, token))
      fail('missing_context', path);
    value = (value as Record<string, unknown>)[token];
  }
  return json(value);
}
export function applyStatus(text: string, operations: Operation[]): string {
  const original = statusDocument(text);
  for (const op of operations) {
    if (!op.path.startsWith('/status/'))
      fail('invalid_patch', 'Only descendants of /status may be patched');
    pointerSyntax(op.path);
    if ('from' in op) {
      pointerSyntax(op.from);
      if (!op.from.startsWith('/status/')) fail('invalid_patch', 'Patch source outside status');
    }
  }
  try {
    const result = patch.applyPatch(
      structuredClone(original),
      operations,
      true,
      true,
      true,
    ).newDocument;
    const out = stringify(result);
    statusDocument(out);
    return out;
  } catch (e) {
    return fail('invalid_patch', e instanceof Error ? e.message : 'Patch failed');
  }
}
function pointerSyntax(path: string): void {
  if (!/^\/(?:[^~]|~[01])*$/.test(path)) fail('invalid_pointer', path);
  if (path.split('/').some((x) => ['__proto__', 'constructor', 'prototype'].includes(x)))
    fail('invalid_pointer', 'Unsafe path');
}
