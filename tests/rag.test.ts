import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/core/config.js';
import { Journal } from '../src/storage/journal.js';
import { GitStory } from '../src/storage/git.js';
import { Budget } from '../src/runtime/budget.js';
import { SiliconFlow, LoreRepository } from '../src/lore/repository.js';
it('indexes via HTTP, reranks, persists, invalidates changed source and isolates branches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cuet-rag-'));
  cpSync('examples/story', root, { recursive: true });
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  g('init', '-b', 'main');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@localhost');
  g('add', '.');
  g('commit', '-m', 'init');
  const config = loadConfig(root);
  config.rag.dimensions = 64;
  let embeds = 0,
    reranks = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/embeddings') {
      embeds++;
      const data = body.input.map((s: string, index: number) => ({
        index,
        embedding: Array.from({ length: 64 }, (_, i) =>
          i === 0 ? 1 : i === 1 ? (s.includes('凭证') ? 1 : 0) : 0,
        ),
      }));
      res.end(JSON.stringify({ data: data.reverse(), usage: { total_tokens: 3 } }));
    } else {
      reranks++;
      expect(body.model).toBe(config.rag.rerankerModel);
      const index = body.documents.findIndex((s: string) => s.includes('填写登记册'));
      res.end(
        JSON.stringify({ results: [{ index: index < 0 ? 0 : index, relevance_score: 0.95 }] }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  config.rag.endpoint = `http://127.0.0.1:${address.port}`;
  const journal = new Journal(join(root, 'runtime/db'));
  const git = new GitStory(root);
  const budget = new Budget(journal, 'b', config.budget);
  let repo = new LoreRepository(
    git,
    join(root, 'cache/db'),
    new SiliconFlow(config.rag, 'test', budget),
  );
  try {
    const base = git.head();
    await repo.index(base);
    const before = embeds;
    await repo.index(base);
    expect(embeds).toBe(before);
    const hits = await repo.search(base, '没有凭证怎么办');
    expect(hits[0]?.entry).toBe('white-tower-access');
    expect(reranks).toBe(1);
    repo.close();
    repo = new LoreRepository(
      git,
      join(root, 'cache/db'),
      new SiliconFlow(config.rag, 'test', budget),
    );
    expect((await repo.search(base, '凭证'))[0]?.commit).toBe(base);
    writeFileSync(
      join(root, 'lore/tower.yaml'),
      'id: white-tower-access\ntitle: 新制度\ncontent: 停止接待\n',
    );
    g('add', 'lore/tower.yaml');
    g('commit', '-m', 'update');
    await expect(repo.search(git.head(), '凭证')).rejects.toThrow('cuet lore index');
    await repo.index(git.head());
    expect((await repo.search(base, '凭证'))[0]?.text).toContain('填写登记册');
    g('rm', 'lore/tower.yaml');
    g('commit', '-m', 'delete');
    await expect(repo.search(git.head(), '凭证')).rejects.toThrow('cuet lore index');
    await repo.index(git.head());
    expect(
      (await repo.search(git.head(), '凭证')).every((h) => h.entry !== 'white-tower-access'),
    ).toBe(true);
  } finally {
    repo.close();
    journal.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
