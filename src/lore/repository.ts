import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Config, fail } from '../core/types.js';
import { hash, objectSchema, validate } from '../core/json.js';
import { parseYaml } from '../status/documents.js';
import { GitStory } from '../storage/git.js';
import { Budget, request } from '../runtime/budget.js';
interface Chunk {
  entry: string;
  path: string;
  title: string;
  text: string;
  start: number;
  end: number;
  hash: string;
  id: string;
}
export interface LoreHit extends Chunk {
  score: number;
  recallScore: number;
  commit: string;
}
export class SiliconFlow {
  constructor(
    readonly config: Config['rag'],
    readonly key: string,
    readonly budget: Budget,
  ) {}
  async embed(input: string[]): Promise<number[][]> {
    if (!this.key)
      fail('missing_credential', 'SiliconFlow credential is required for RAG requests');
    const r = await request(
      `${this.config.endpoint.replace(/\/$/, '')}/embeddings`,
      this.key,
      {
        model: this.config.embeddingModel,
        input,
        dimensions: this.config.dimensions,
        encoding_format: 'float',
      },
      this.budget,
    );
    const body = (await r.json()) as {
      data?: { index: number; embedding: number[] }[];
      usage?: { total_tokens: number };
    };
    this.budget.tokens(Number.isFinite(body.usage?.total_tokens) ? body.usage!.total_tokens : null);
    if (!Array.isArray(body.data) || body.data.length !== input.length)
      fail('rag_unavailable', 'Embedding response count mismatch');
    const out: number[][] = new Array(input.length);
    const seen = new Set<number>();
    for (const item of body.data) {
      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= input.length ||
        seen.has(item.index)
      )
        fail('rag_unavailable', 'Embedding index mismatch');
      if (
        !Array.isArray(item.embedding) ||
        item.embedding.length !== this.config.dimensions ||
        item.embedding.some((x) => !Number.isFinite(x))
      )
        fail('rag_unavailable', 'Invalid embedding vector');
      const norm = Math.hypot(...item.embedding);
      if (!(norm > 0)) fail('rag_unavailable', 'Zero embedding vector');
      out[item.index] = item.embedding.map((x) => x / norm);
      seen.add(item.index);
    }
    return out;
  }
  async rerank(
    query: string,
    documents: string[],
  ): Promise<{ index: number; relevance_score: number }[]> {
    if (!documents.length) return [];
    if (!this.key)
      fail('missing_credential', 'SiliconFlow credential is required for RAG requests');
    const r = await request(
      `${this.config.endpoint.replace(/\/$/, '')}/rerank`,
      this.key,
      {
        model: this.config.rerankerModel,
        query,
        documents,
        top_n: Math.min(documents.length, this.config.topN),
        return_documents: false,
      },
      this.budget,
    );
    const body = (await r.json()) as {
      results?: { index: number; relevance_score: number }[];
      usage?: { total_tokens: number };
      tokens?: { input_tokens: number; output_tokens: number };
    };
    this.budget.tokens(
      body.usage?.total_tokens ??
        (body.tokens ? body.tokens.input_tokens + body.tokens.output_tokens : null),
    );
    if (!Array.isArray(body.results)) fail('rag_unavailable', 'Missing rerank results');
    const seen = new Set<number>();
    for (const r of body.results) {
      if (
        !Number.isInteger(r.index) ||
        r.index < 0 ||
        r.index >= documents.length ||
        seen.has(r.index) ||
        !Number.isFinite(r.relevance_score)
      )
        fail('rag_unavailable', 'Invalid rerank index or score');
      seen.add(r.index);
    }
    return body.results;
  }
}
export class LoreRepository {
  readonly db: DatabaseSync;
  constructor(
    readonly story: GitStory,
    file: string,
    readonly remote: SiliconFlow,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS chunks (generation TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(generation,id));',
    );
  }
  source(commit: string): { generation: string; chunks: Chunk[] } {
    const c = this.remote.config;
    const chunks: Chunk[] = [];
    const ids = new Set<string>();
    for (const path of this.story.files(commit, 'lore/')) {
      if (!/\.ya?ml$/.test(path))
        fail('invalid_lore', 'Lore entries must be YAML documents containing id, title, content');
      const raw = this.story.read(commit, path);
      const value = parseYaml(raw);
      validate(
        objectSchema({
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
        }),
        value,
      );
      const entry = value as { id: string; title: string; content: string };
      if (ids.has(entry.id)) fail('invalid_lore', 'Duplicate Lore entry id');
      ids.add(entry.id);
      let start = 0;
      while (start < entry.content.length) {
        let end = Math.min(start + c.chunkChars, entry.content.length);
        if (end < entry.content.length) {
          const paragraph = entry.content.lastIndexOf('\n\n', end);
          if (paragraph > start + c.chunkChars / 2) end = paragraph + 2;
          const code = entry.content.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff) end--;
        }
        const text = entry.content.slice(start, end);
        chunks.push({
          entry: entry.id,
          path,
          title: entry.title,
          text,
          start,
          end,
          hash: hash(raw),
          id: hash(`${path}:${start}:${end}:${hash(raw)}`),
        });
        start = end;
      }
    }
    return { generation: hash(JSON.stringify({ chunks, config: c, strategy: 1 })), chunks };
  }
  async index(commit: string): Promise<{ generation: string; chunks: number; reused: boolean }> {
    const { generation, chunks } = this.source(commit);
    if (this.db.prepare('SELECT id FROM generations WHERE id=?').get(generation))
      return { generation, chunks: chunks.length, reused: true };
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 8)
      vectors.push(
        ...(await this.remote.embed(chunks.slice(i, i + 8).map((c) => `${c.title}\n\n${c.text}`))),
      );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO chunks VALUES (?,?,?,?)');
      for (const [i, chunk] of chunks.entries()) {
        const v = vectors[i]!;
        const b = Buffer.alloc(v.length * 8);
        v.forEach((x, n) => b.writeDoubleLE(x, n * 8));
        insert.run(generation, chunk.id, JSON.stringify(chunk), b);
      }
      this.db.prepare('INSERT OR IGNORE INTO generations VALUES (?)').run(generation);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { generation, chunks: chunks.length, reused: false };
  }
  async search(commit: string, query: string): Promise<LoreHit[]> {
    if (!query.trim()) fail('invalid_input', 'Query cannot be empty');
    const { generation, chunks } = this.source(commit);
    if (!chunks.length) return [];
    if (!this.db.prepare('SELECT id FROM generations WHERE id=?').get(generation))
      fail('index_not_ready', 'Run cuet lore index for this source revision');
    const [vector] = await this.remote.embed([query]);
    const rows = this.db
      .prepare('SELECT data,vector FROM chunks WHERE generation=?')
      .all(generation);
    const candidates = rows
      .map((row) => {
        const b = Buffer.from(row.vector as Uint8Array);
        let score = 0;
        if (b.length !== vector!.length * 8) fail('index_not_ready', 'Corrupt index dimension');
        for (let i = 0; i < vector!.length; i++) score += vector![i]! * b.readDoubleLE(i * 8);
        return { ...(JSON.parse(row.data as string) as Chunk), recallScore: score };
      })
      .sort((a, b) => b.recallScore - a.recallScore || a.id.localeCompare(b.id))
      .slice(0, this.remote.config.topK);
    const reranked = await this.remote.rerank(
      query,
      candidates.map((c) => `${c.title}\n\n${c.text}`),
    );
    const hits = reranked.map((r) => ({
      ...candidates[r.index]!,
      score: r.relevance_score,
      commit,
    }));
    this.remote.budget.journal.event('lore.search', {
      query,
      commit,
      generation,
      recall: candidates.map((c) => ({ id: c.id, score: c.recallScore })),
      hits,
    });
    return hits;
  }
  close(): void {
    this.db.close();
  }
}
