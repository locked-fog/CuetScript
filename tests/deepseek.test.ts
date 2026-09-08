import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeepSeek } from '../src/providers/deepseek.js';
import { Journal } from '../src/storage/journal.js';
import { Budget } from '../src/runtime/budget.js';
import { sse } from '../src/providers/sse.js';
it('parses arbitrarily split SSE tool arguments and replays reasoning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cuet-stream-'));
  const j = new Journal(join(dir, 'db'));
  const budget = new Budget(j, 'b', { calls: 10, tokens: 1000, seconds: 20, corrections: 2 });
  let n = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const p = JSON.parse(body);
    n++;
    if (n === 2) expect(p.messages[0].reasoning_content).toBe('reason');
    res.setHeader('Content-Type', 'text/event-stream');
    const frames =
      n === 1
        ? [
            { choices: [{ index: 0, delta: { reasoning_content: 'reason' } }] },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'abc', function: { name: 'echo', arguments: '{"text":' } },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"中文"}' } }] },
                },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 1, completion_tokens: 2 },
            },
          ]
        : [{ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }];
    const text =
      frames.map((f) => 'data: ' + JSON.stringify(f) + '\r\n\r\n').join('') +
      'data: [DONE]\r\n\r\n';
    const bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i += 3) res.write(bytes.subarray(i, i + 3));
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = new DeepSeek(`http://127.0.0.1:${port}`, 'test', budget);
    const opts = { model: 'm', thinking: true, maxTokens: 20 };
    const tools = [{ name: 'echo', description: '', parameters: { type: 'object' } }];
    const first = await provider.generate([], tools, opts, budget.signal);
    expect(first.message.calls?.[0]?.arguments).toBe('{"text":"中文"}');
    const second = await provider.generate(
      [first.message, { role: 'tool', callId: 'abc', content: 'ok' }],
      tools,
      opts,
      budget.signal,
    );
    expect(second.message.content).toBe('done');
  } finally {
    j.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
it('rejects truncated event frames', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {}'));
      c.close();
    },
  });
  await expect(async () => {
    for await (const _ of sse(body)) {
    }
  }).rejects.toThrow('Truncated');
});
