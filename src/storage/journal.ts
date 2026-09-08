import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export class Journal {
  readonly db: DatabaseSync;
  onEvent?: (kind: string, data: unknown) => void;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version as number;
    if (version > 1) {
      this.db.close();
      throw new Error('Unsupported journal schema version');
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, time TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version=1;',
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE key=?').get(key);
    return row ? (JSON.parse(row.value as string) as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO records VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  event(kind: string, data: unknown): void {
    this.db
      .prepare('INSERT INTO events(time,kind,data) VALUES (?,?,?)')
      .run(new Date().toISOString(), kind, JSON.stringify(data));
    this.onEvent?.(kind, data);
  }
  close(): void {
    this.db.close();
  }
}
