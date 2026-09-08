import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHash } from 'node:crypto';
import { importDsh, Antigravity } from '../src/providers/antigravity.js';
import { Journal } from '../src/storage/journal.js';
import { Budget } from '../src/runtime/budget.js';
it('imports only the selected account, leaves source unchanged and replays original signed parts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cuet-agy-'));
  const source = join(dir, 'source'),
    dest = join(dir, 'private');
  mkdirSync(source);
  const master = 'test-master',
    iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(master).digest(), iv);
  const enc = Buffer.concat([cipher.update('test-refresh|test-project'), cipher.final()]);
  const store = JSON.stringify({
    version: 4,
    accounts: [
      {
        refresh: `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`,
        projectId: 'test-project',
        clientId: 'test-client',
        enabled: true,
      },
    ],
  });
  writeFileSync(join(source, 'agy-accounts.json'), store);
  writeFileSync(join(source, '.credentials.yaml'), 'refs:\n  AGY_MASTER_KEY: test-master\n');
  const secretFile = join(dir, 'client-secret');
  writeFileSync(secretFile, 'test-client-secret', { mode: 0o600 });
  importDsh(source, dest, 0, secretFile);
  expect(readFileSync(join(source, 'agy-accounts.json'), 'utf8')).toBe(store);
  const j = new Journal(join(dir, 'db')),
    b = new Budget(j, 'b', { calls: 20, tokens: 10000, seconds: 30, corrections: 2 });
  let generation = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.includes('oauth2'))
      return new Response(JSON.stringify({ access_token: 'test-access', expires_in: 3600 }));
    const body = JSON.parse(init.body as string);
    generation++;
    if (generation === 2)
      expect(body.request.contents[1].parts[0].thoughtSignature).toBe('real-signed-part');
    const parts =
      generation === 1
        ? [
            {
              functionCall: { name: 'echo', args: { text: 'a' } },
              thoughtSignature: 'real-signed-part',
            },
          ]
        : [{ text: 'a' }];
    return new Response(
      'data: ' +
        JSON.stringify({
          response: { candidates: [{ content: { parts }, finishReason: 'STOP' }] },
        }) +
        '\n\n',
    );
  });
  try {
    const opts = { model: 'gemini-3-flash', thinking: true, maxTokens: 50 };
    const tools = [
      {
        name: 'echo',
        description: '',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ];
    const first = await new Antigravity(dest, b).generate(
      [{ role: 'user', content: 'echo' }],
      tools,
      opts,
      b.signal,
    );
    j.set('reply', first.message);
    const saved = j.get<typeof first.message>('reply')!;
    const second = await new Antigravity(dest, b).generate(
      [
        { role: 'user', content: 'echo' },
        saved,
        { role: 'tool', callId: saved.calls![0]!.id, content: 'a' },
      ],
      tools,
      opts,
      b.signal,
    );
    expect(second.message.content).toBe('a');
  } finally {
    vi.unstubAllGlobals();
    j.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
