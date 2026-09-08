import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWebServer } from '../src/web/server.js';

it('serves authenticated story operations, atomic edits, history, branches and cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cuet-web-'));
  const app = createWebServer({
    directory: root,
    token: 'test-token',
    cli: join(process.cwd(), 'dist/cli/index.js'),
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const address = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  async function api(path: string, data?: unknown) {
    const res = await fetch(`${base}/api/${path}`, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: res.status, value: (await res.json()) as any };
  }
  async function action(action: string, extra = {}) {
    const response = await api('action', { story: 'sample', action, ...extra });
    expect(response.status).toBe(202);
    for (let i = 0; i < 200; i++) {
      const job = await api(`job?id=${response.value.id}`);
      if (job.value.status !== 'running') return job.value;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw Error('Timed out');
  }
  try {
    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(base + '/api/stories')).status).toBe(401);
    expect(
      (
        await fetch(base + '/api/stories', {
          headers: { Authorization: 'Bearer test-token', Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect((await action('init')).status).toBe('succeeded');
    const g = (...args: string[]) =>
      execFileSync('git', ['-C', join(root, 'sample'), ...args], { encoding: 'utf8' }).trim();
    g('config', 'user.name', 'Web Test');
    g('config', 'user.email', 'web@localhost');
    expect((await api('stories')).value.stories).toEqual(['sample']);
    const state = (await api('story?story=sample')).value;
    const save = {
      story: 'sample',
      path: 'lore/new.yaml',
      content: 'id: new\ntitle: 中文地点\ncontent: 地点内容\n',
      head: state.head,
    };
    const result = await api('file', save);
    expect(result.status).toBe(200);
    expect(g('status', '--porcelain')).toBe('');
    expect((await api('file?story=sample&path=lore/new.yaml')).value.content).toContain('中文地点');
    expect((await api('file', save)).value.error).toBe('version_conflict');
    expect((await api('file', { ...save, path: '../outside' })).status).toBe(400);
    expect(
      (await api('file', { ...save, path: 'config/cuet.yaml', content: 'invalid: true' })).status,
    ).toBe(400);
    expect((await api('file', { ...save, head: result.value.commit, remove: true })).status).toBe(
      200,
    );
    expect(g('ls-tree', '--name-only', 'HEAD', '--', 'lore/new.yaml')).toBe('');
    expect(g('status', '--porcelain')).toBe('');
    expect((await action('doctor')).result.config).toBe('valid');
    expect((await action('turns')).result).toEqual([]);
    expect((await action('branch', { branch: 'alternate', from: state.head })).status).toBe(
      'succeeded',
    );
    expect(
      (await api('action', { story: 'sample', action: 'switch', branch: 'main' })).status,
    ).toBe(200);
    expect(g('branch', '--show-current')).toBe('main');
    writeFileSync(join(root, 'sample', 'notebook.md'), 'local changes');
    expect((await api('file', { ...save, head: g('rev-parse', 'HEAD') })).value.error).toBe(
      'dirty_story',
    );
    symlinkSync(join(root, 'sample'), join(root, 'linked'));
    expect((await api('story?story=linked')).status).toBe(400);
  } finally {
    app.close();
    await new Promise<void>((r) => app.server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

it('keeps background jobs across page polling, rejects concurrent work and cancels safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cuet-web-job-'));
  const fake = join(root, 'fake.mjs');
  writeFileSync(
    fake,
    "process.on('SIGINT',()=>process.exit(0));setTimeout(()=>console.log('{}'),30000);",
  );
  const app = createWebServer({ directory: root, token: 'token', cli: fake });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/`;
  const post = async (path: string, data: unknown) => {
    const r = await fetch(url + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: JSON.stringify(data),
    });
    return { status: r.status, value: (await r.json()) as any };
  };
  try {
    const first = await post('action', { story: 'test', action: 'init' });
    expect(first.status).toBe(202);
    expect((await post('action', { story: 'test', action: 'init' })).value.error).toBe(
      'story_locked',
    );
    await post('cancel', { id: first.value.id });
    for (let i = 0; i < 100; i++) {
      const r = await fetch(url + 'job?id=' + first.value.id, {
        headers: { Authorization: 'Bearer token' },
      });
      const j = (await r.json()) as any;
      if (j.status === 'cancelled') return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error('Cancellation failed');
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
