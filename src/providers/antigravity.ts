/** Wire and credential format reference: dsh-agy e0de9aa, MIT; see third-party/. */
import { createHash, createDecipheriv, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  fail,
  type Generation,
  type Json,
  type Message,
  type ModelOptions,
  type ModelProvider,
  type ToolSpec,
} from '../core/types.js';
import { Budget } from '../runtime/budget.js';
import { sse } from './sse.js';
const ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
interface Account {
  refresh: string;
  projectId: string;
  clientId?: string;
  enabled?: boolean;
  proxy?: string;
}
export function importDsh(
  source: string,
  destination: string,
  index: number,
  clientSecretFile?: string,
): void {
  const src = resolve(source),
    dest = resolve(destination);
  if (src === dest || dest.startsWith(src + '/'))
    fail('invalid_input', 'Use a separate private CuetScript directory');
  if (existsSync(dest)) fail('existing_path', 'Import destination already exists');
  const store = JSON.parse(readFileSync(join(src, 'agy-accounts.json'), 'utf8'));
  const credentials = parse(readFileSync(join(src, '.credentials.yaml'), 'utf8'));
  const master = credentials?.AGY_MASTER_KEY ?? credentials?.refs?.AGY_MASTER_KEY;
  const account = store.accounts?.[index] as Account | undefined;
  if (!account || account.enabled === false || typeof master !== 'string')
    fail('invalid_input', 'No enabled account or encryption key');
  if (account.proxy)
    fail(
      'provider_unavailable',
      'Per-account proxies must be explicitly configured; this adapter will not bypass them',
    );
  if (!account.refresh.startsWith('enc:v1:'))
    fail('invalid_input', 'Only encrypted dsh-agy stores are imported');
  const clientSecret = clientSecretFile ? readFileSync(clientSecretFile, 'utf8').trim() : undefined;
  if (clientSecretFile && !clientSecret)
    fail('missing_credential', 'Empty OAuth client secret file');
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (clientSecret)
    writeFileSync(join(dest, 'oauth-client-secret'), clientSecret, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(dest, 'master'), master, { mode: 0o600, flag: 'wx' });
  writeFileSync(
    join(dest, 'account.json'),
    JSON.stringify({
      refresh: account.refresh,
      projectId: account.projectId,
      clientId: account.clientId,
      schema_version: 1,
    }),
    { mode: 0o600, flag: 'wx' },
  );
}
function privateRead(path: string): string {
  if ((statSync(path).mode & 0o077) !== 0)
    fail('invalid_input', 'Antigravity credentials must be readable only by their owner');
  return readFileSync(path, 'utf8');
}
export class Antigravity implements ModelProvider {
  private access = '';
  private expires = 0;
  private account: Account;
  private scope: string;
  constructor(
    readonly authDir: string,
    readonly budget: Budget,
    readonly endpoint = ENDPOINT,
  ) {
    this.account = JSON.parse(privateRead(join(authDir, 'account.json')));
    this.scope = createHash('sha256')
      .update(privateRead(join(authDir, 'master')) + this.account.projectId)
      .digest('hex');
  }
  private async token(): Promise<string> {
    if (Date.now() < this.expires) return this.access;
    const master = privateRead(join(this.authDir, 'master'));
    const key = createHash('sha256').update(master).digest();
    const [, , iv, tag, data] = this.account.refresh.split(':');
    if (!iv || !tag || !data) fail('invalid_input', 'Invalid encrypted credential');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const packed = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const [refresh] = packed.split('|');
    const clientId = process.env.AGY_CLIENT_ID ?? this.account.clientId;
    const secretFile = join(this.authDir, 'oauth-client-secret');
    const clientSecret =
      process.env.AGY_CLIENT_SECRET ??
      (existsSync(secretFile) ? privateRead(secretFile).trim() : undefined);
    if (!clientId || !clientSecret)
      fail(
        'missing_credential',
        'OAuth client configuration required: imported clientId / AGY_CLIENT_ID and private oauth-client-secret / AGY_CLIENT_SECRET',
      );
    this.budget.charge();
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh!,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: this.budget.signal,
    });
    if (!r.ok) {
      await r.body?.cancel();
      fail(
        'provider_unavailable',
        `Antigravity token refresh HTTP ${r.status}; reauthenticate the isolated account`,
      );
    }
    const value = (await r.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    if (!value.access_token) fail('provider_unavailable', 'Missing OAuth access token');
    this.access = value.access_token;
    this.expires = Date.now() + Math.max(0, value.expires_in - 60) * 1000;
    if (value.refresh_token && value.refresh_token !== refresh) {
      const nextPacked = [value.refresh_token, ...packed.split('|').slice(1)].join('|');
      const nextIv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nextIv);
      const encrypted = Buffer.concat([cipher.update(nextPacked), cipher.final()]);
      this.account.refresh = `enc:v1:${nextIv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
      const temporary = join(this.authDir, `account.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(this.account), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, join(this.authDir, 'account.json'));
    }
    return this.access;
  }
  async models(): Promise<string[]> {
    const r = await this.post('/v1internal:fetchAvailableModels', {
      project: this.account.projectId,
    });
    const body = (await r.json()) as { models?: Record<string, unknown> };
    if (!body.models) fail('provider_unavailable', 'Model catalog missing');
    return Object.keys(body.models).filter((id) => id.toLowerCase().includes('gemini'));
  }
  private async post(path: string, payload: unknown): Promise<Response> {
    const token = await this.token();
    this.budget.charge();
    const r = await fetch(this.endpoint + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.18.3 linux/x64',
        'X-Goog-Api-Client': 'gl-node/26.8.1',
        'Client-Metadata': '{"ideType":"ANTIGRAVITY"}',
      },
      body: JSON.stringify(payload),
      signal: this.budget.signal,
    });
    if (!r.ok) {
      await r.body?.cancel();
      fail('provider_unavailable', `Antigravity HTTP ${r.status}`);
    }
    return r;
  }
  async generate(
    messages: Message[],
    tools: ToolSpec[],
    options: ModelOptions,
    _signal: AbortSignal,
  ): Promise<Generation> {
    if (!options.model.toLowerCase().includes('gemini'))
      fail('provider_unavailable', 'Antigravity adapter currently supports Gemini only');
    const names = new Map(messages.flatMap((m) => m.calls ?? []).map((c) => [c.id, c.name]));
    const contents: { role: string; parts: unknown[] }[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant' && m.providerData?.agy_parts) {
        if (m.providerData.scope !== this.scope || m.providerData.model !== options.model)
          fail('provider_unavailable', 'Provider replay scope changed; rebuild context from Canon');
        contents.push({ role: 'model', parts: m.providerData.agy_parts as Json[] });
        continue;
      }
      if (m.calls?.length)
        fail(
          'provider_unavailable',
          'Missing original Antigravity reply parts; do not synthesize signatures',
        );
      if (m.role === 'tool') {
        const name = names.get(m.callId!);
        if (!name) fail('invalid_tool', 'Tool result has no matching call');
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response: { result: m.content } } }],
        });
      } else
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        });
    }
    const allowed = new Set([
      'type',
      'properties',
      'required',
      'description',
      'items',
      'enum',
      'nullable',
    ]);
    const convert = (schema: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema)) {
        if (
          (key === 'additionalProperties' && value === false) ||
          [
            'minLength',
            'maxLength',
            'minimum',
            'maximum',
            'minItems',
            'maxItems',
            'uniqueItems',
          ].includes(key)
        )
          continue; // Always enforced locally, not claimed upstream.
        if (!allowed.has(key))
          fail('provider_unavailable', `Unsupported Antigravity schema keyword: ${key}`);
        if (key === 'properties')
          out[key] = Object.fromEntries(
            Object.entries(value as Record<string, Record<string, unknown>>).map(([k, v]) => [
              k,
              convert(v),
            ]),
          );
        else if (key === 'items') out[key] = convert(value as Record<string, unknown>);
        else if (key === 'type' && Array.isArray(value)) {
          const types = value.filter((x) => x !== 'null');
          if (types.length !== 1) fail('provider_unavailable', 'Unsupported schema type union');
          out.type = types[0];
          if (value.includes('null')) out.nullable = true;
        } else out[key] = value;
      }
      return out;
    };
    const response = await this.post('/v1internal:streamGenerateContent?alt=sse', {
      project: this.account.projectId,
      requestId: randomUUID(),
      model: options.model,
      userAgent: 'antigravity',
      requestType: 'agent',
      request: {
        contents,
        systemInstruction: {
          parts: [
            {
              text:
                messages
                  .filter((m) => m.role === 'system')
                  .map((m) => m.content)
                  .join('\n') || 'Help the user.',
            },
          ],
        },
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: convert(t.parameters),
                  })),
                },
              ],
              toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
            }
          : {}),
        generationConfig: {
          maxOutputTokens: options.maxTokens,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.thinking
            ? {
                thinkingConfig: {
                  thinkingLevel: options.effort === 'max' ? 'high' : (options.effort ?? 'low'),
                  includeThoughts: true,
                },
              }
            : {}),
        },
      },
    });
    if (!response.body) fail('provider_unavailable', 'Empty Antigravity stream');
    let content = '',
      finish = '';
    let usage: Generation['usage'] = null;
    const parts: Json[] = [];
    const calls: import('../core/types.js').ToolCall[] = [];
    for await (const data of sse(response.body)) {
      if (data === '[DONE]') break;
      const frame = JSON.parse(data);
      const body = frame.response ?? frame;
      const candidate = body.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        parts.push(part);
        if (typeof part.text === 'string' && !part.thought) content += part.text;
        if (part.functionCall)
          calls.push({
            id: part.functionCall.id ?? randomUUID(),
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          });
      }
      if (candidate?.finishReason) finish = candidate.finishReason;
      if (body.usageMetadata)
        usage = {
          input: body.usageMetadata.promptTokenCount ?? 0,
          output:
            (body.usageMetadata.candidatesTokenCount ?? 0) +
            (body.usageMetadata.thoughtsTokenCount ?? 0),
        };
    }
    this.budget.tokens(usage ? usage.input + usage.output : null);
    if (finish !== 'STOP')
      fail('provider_unavailable', `Incomplete Antigravity response: ${finish || 'no finish'}`);
    return {
      message: {
        role: 'assistant',
        content,
        ...(calls.length ? { calls } : {}),
        providerData: {
          provider: 'antigravity',
          agy_parts: parts,
          model: options.model,
          scope: this.scope,
        },
      },
      usage,
      requestId: null,
      finish: calls.length ? 'tool_calls' : 'stop',
    };
  }
}
