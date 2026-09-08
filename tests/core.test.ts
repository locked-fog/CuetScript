import { actorReferences } from '../src/core/context.js';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseYaml, applyStatus, pointer } from '../src/status/documents.js';
import { GitStory } from '../src/storage/git.js';
import { Journal } from '../src/storage/journal.js';
import { Budget } from '../src/runtime/budget.js';
import { Agent } from '../src/runtime/agent.js';
import type { ModelProvider, Message, Generation } from '../src/core/types.js';
const dirs: string[] = [];
function temp() {
  const d = mkdtempSync(join(tmpdir(), 'cuet-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function story() {
  const d = temp();
  cpSync('examples/story', d, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@localhost');
  git('add', '.');
  git('commit', '-m', 'init');
  return new GitStory(d);
}
describe('Status grammar and patch correctness', () => {
  it.each([
    'a: &x hi\nb: *x',
    'a: 1\na: 2',
    'a: !!str hello',
    '? [a,b]\n: value',
    'a: .nan',
    'a: { <<: hi }',
    '__proto__: {}',
  ])('rejects unsupported YAML %s', (text) => expect(() => parseYaml(text)).toThrow());
  it('preserves YAML 1.2 strings and JSON Pointer escaping', () => {
    expect(parseYaml('a: yes\nb: 2026-09-08')).toEqual({ a: 'yes', b: '2026-09-08' });
    expect(pointer({ 'a/b': { '~': 3 } }, '/a~1b/~0')).toBe(3);
  });
  it('validates preconditions and protects envelope', () => {
    const text = 'schema_version: 1\nid: character.a\nkind: character\nstatus:\n  coat: worn\n';
    const result = applyStatus(text, [
      { op: 'test', path: '/status/coat', value: 'worn' },
      { op: 'replace', path: '/status/coat', value: 'removed' },
    ]);
    expect(parseYaml(result)).toMatchObject({ status: { coat: 'removed' } });
    expect(() =>
      applyStatus(result, [{ op: 'test', path: '/status/coat', value: 'worn' }]),
    ).toThrow();
    expect(() => applyStatus(text, [{ op: 'replace', path: '/id', value: 'b' }])).toThrow();
  });
});
describe('Git publication boundary', () => {
  it('isolates candidate and recovers after ref publish without changing unrelated files', () => {
    const g = story(),
      base = g.head();
    const before = readFileSync(join(g.root, 'notebook.md'), 'utf8');
    const next = g.prepare(base, { 'notebook.md': 'changed\n', 'prose/t.md': 'hello\n' }, 'result');
    expect(g.head()).toBe(base);
    expect(readFileSync(join(g.root, 'notebook.md'), 'utf8')).toBe(before);
    expect(() =>
      g.publish(base, next, g.branch(), () => {
        throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(g.head()).toBe(next);
    g.sync(base, next);
    g.clean();
    expect(g.read(next, 'prose/t.md')).toBe('hello\n');
  });
  it('rejects dirty worktrees and stale bases', () => {
    const g = story(),
      base = g.head(),
      next = g.prepare(base, { 'notebook.md': 'new' }, 'result');
    writeFileSync(join(g.root, 'keep.txt'), 'user content');
    expect(() => g.publish(base, next, g.branch())).toThrow('Commit or move');
    expect(readFileSync(join(g.root, 'keep.txt'), 'utf8')).toBe('user content');
  });
  it('does not write symlinks or traverse paths', () => {
    const g = story();
    expect(() => g.prepare(g.head(), { '../bad': 'x' }, 'bad')).toThrow();
  });
});
describe('durable agent replay', () => {
  it('reuses a persisted tool result after process-level journal reopen', async () => {
    const d = temp(),
      file = join(d, 'runtime/db');
    let j = new Journal(file);
    let n = 0;
    const generation = (message: Message): Generation => ({
      message,
      finish: 'tool_calls',
      usage: null,
      requestId: null,
    });
    const provider: ModelProvider = {
      generate: async () => {
        n++;
        if (n === 1)
          return generation({
            role: 'assistant',
            content: '',
            calls: [{ id: 'x', name: 'read', arguments: '{}' }],
            providerData: { reasoning_content: 'opaque' },
          });
        throw new Error('crash');
      },
    };
    const limits = { calls: 20, tokens: 10000, seconds: 60, corrections: 2 };
    let b = new Budget(j, 'budget', limits);
    let executions = 0;
    const tools = [
      {
        name: 'read',
        description: '',
        parameters: { type: 'object' },
        execute: async () => {
          executions++;
          return 'done';
        },
      },
      {
        name: 'submit',
        description: '',
        parameters: { type: 'object' },
        terminal: true,
        execute: async () => ({ content: 'ok' }),
      },
    ];
    await expect(
      new Agent(j, b, provider).run('i', [{ role: 'user', content: 'go' }], tools, {
        model: 'm',
        thinking: true,
        maxTokens: 100,
      }),
    ).rejects.toThrow('crash');
    j.close();
    j = new Journal(file);
    b = new Budget(j, 'budget', limits);
    const resumed: ModelProvider = {
      generate: async (messages) => {
        expect(messages.some((m) => m.callId === 'x' && m.content === '"done"')).toBe(true);
        expect(messages.find((m) => m.role === 'assistant')?.providerData?.reasoning_content).toBe(
          'opaque',
        );
        return generation({
          role: 'assistant',
          content: '',
          calls: [{ id: 's', name: 'submit', arguments: '{}' }],
        });
      },
    };
    const result = await new Agent(j, b, resumed).run('i', [], tools, {
      model: 'm',
      thinking: true,
      maxTokens: 100,
    });
    expect(result).toEqual({ content: 'ok' });
    expect(executions).toBe(1);
    j.close();
  });
});
it('persists time budgets across process restarts', () => {
  const d = temp();
  const j = new Journal(join(d, 'db'));
  const limits = { calls: 10, tokens: 100, seconds: 30, corrections: 2 };
  const b = new Budget(j, 'turn', limits);
  b.check();
  j.set('deadline:turn', Date.now() - 1);
  expect(() => new Budget(j, 'turn', limits).check()).toThrow('Persisted Turn deadline');
  j.close();
});
it('refuses a lock held by another invocation', async () => {
  const g = story();
  await g.locked(async () => {
    await expect(g.locked(async () => true)).rejects.toThrow('Story is used');
  });
});
it('records results for every rejected terminal batch before exhausting corrections', async () => {
  const j = new Journal(join(temp(), 'db'));
  const limits = { calls: 10, tokens: 100, seconds: 30, corrections: 1 };
  const b = new Budget(j, 'b', limits);
  let calls = 0,
    sideEffects = 0;
  const p: ModelProvider = {
    generate: async () => ({
      message: {
        role: 'assistant',
        content: '',
        calls: [
          { id: `a${calls++}`, name: 'submit', arguments: '{}' },
          { id: `b${calls}`, name: 'read', arguments: '{}' },
        ],
      },
      usage: null,
      requestId: null,
      finish: 'tool_calls',
    }),
  };
  const tools = [
    {
      name: 'submit',
      description: '',
      parameters: { type: 'object' },
      terminal: true,
      execute: async () => {
        sideEffects++;
        return 'x';
      },
    },
    {
      name: 'read',
      description: '',
      parameters: { type: 'object' },
      execute: async () => {
        sideEffects++;
        return 'x';
      },
    },
  ];
  await expect(
    new Agent(j, b, p).run('bad', [], tools, { model: 'm', thinking: false, maxTokens: 1 }),
  ).rejects.toThrow('Too many');
  const cp = j.get<{ messages: Message[] }>('agent:bad')!;
  expect(cp.messages.filter((m) => m.role === 'tool')).toHaveLength(4);
  expect(sideEffects).toBe(0);
  j.close();
});

it('intersects whole-document references with narrow character grants without leaking sibling secrets', () => {
  const refs = actorReferences(
    [
      { path: 'status/world.yaml', pointer: '' },
      { path: 'status/other.yaml', pointer: '/status' },
    ],
    [
      { path: 'status/world.yaml', pointer: '/status/public', audience: ['public'] },
      { path: 'status/world.yaml', pointer: '/status/secret', audience: ['character.other'] },
    ],
    'character.keeper',
  );
  expect(refs).toEqual([{ path: 'status/world.yaml', pointer: '/status/public' }]);
  const data = { status: { public: 'daylight', secret: 'hidden key' } };
  expect(refs.map((r) => pointer(data, r.pointer))).toEqual(['daylight']);
});

it('honors cancellation before starting a request without erasing prior records', () => {
  const j = new Journal(join(temp(), 'db'));
  j.set('tool:done', { value: 'saved' });
  const controller = new AbortController();
  controller.abort();
  const b = new Budget(
    j,
    'b',
    { calls: 10, tokens: 100, seconds: 30, corrections: 2 },
    controller.signal,
  );
  expect(() => b.charge()).toThrow('cancellation');
  expect(j.get('tool:done')).toEqual({ value: 'saved' });
  j.close();
});
