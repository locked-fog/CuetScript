import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml } from '../status/documents.js';
import { objectSchema, validate } from './json.js';
import { fail, type Config } from './types.js';
const text = { type: 'string', minLength: 1 };
const integer = (min: number, max: number) => ({ type: 'integer', minimum: min, maximum: max });
const slot = objectSchema(
  {
    provider: { enum: ['deepseek', 'antigravity'] },
    model: text,
    thinking: { type: 'boolean' },
    maxTokens: integer(1, 65536),
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    effort: { enum: ['low', 'high', 'max'] },
  },
  ['model', 'thinking', 'maxTokens'],
);
export function parseConfig(value: unknown): Config {
  validate(
    objectSchema({
      schema_version: { const: 1 },
      deepseek: objectSchema({ endpoint: text, credentialEnv: text }),
      slots: objectSchema({ orchestrator: slot, writer: slot, actor: slot }),
      rag: objectSchema({
        endpoint: text,
        credentialEnv: text,
        embeddingModel: text,
        rerankerModel: text,
        dimensions: integer(64, 4096),
        chunkChars: integer(128, 8000),
        topK: integer(1, 100),
        topN: integer(1, 100),
      }),
      budget: objectSchema({
        calls: integer(1, 1000),
        tokens: integer(1, 10000000),
        seconds: integer(1, 86400),
        corrections: integer(1, 10),
      }),
      userControl: objectSchema({
        characters: { type: 'array', items: text, uniqueItems: true },
        allowMinorActions: { type: 'boolean' },
        resultDeclarations: { enum: ['attempt', 'established'] },
      }),
    }),
    value,
  );
  const c = value as Config;
  if (c.rag.topN > c.rag.topK) fail('invalid_config', 'topN must not exceed topK');
  for (const o of Object.values(c.slots))
    if (o.provider !== 'antigravity' && o.thinking && o.temperature !== undefined)
      fail('invalid_config', 'temperature is ineffective in DeepSeek thinking mode');
  for (const endpoint of [c.deepseek.endpoint, c.rag.endpoint]) {
    const u = new URL(endpoint);
    if (u.username || u.password || u.search || u.hash)
      fail('invalid_config', 'Endpoint must not contain credentials, query or fragment');
    if (
      u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
      fail('invalid_config', 'Use HTTPS except for local tests');
  }
  return c;
}
export const loadConfig = (root: string) =>
  parseConfig(parseYaml(readFileSync(resolve(root, 'config/cuet.yaml'), 'utf8')));
export function credential(name: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    fail('invalid_config', 'Credential must be an environment variable name');
  const value = process.env[name];
  if (!value) fail('missing_credential', `Set ${name} via environment or an external --env-file`);
  return value;
}
