import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fail } from '../core/types.js';
export class GitStory {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    if (this.git(['rev-parse', '--show-toplevel']).trim() !== this.root)
      fail('invalid_story', 'Story must be its own Git repository');
  }
  git(args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
    try {
      return execFileSync('git', ['-C', this.root, ...args], {
        input,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return fail('git_error', `Git operation failed: ${args[0]}`);
    }
  }
  head(): string {
    return this.git(['rev-parse', 'HEAD']).trim();
  }
  branch(): string {
    const b = this.git(['symbolic-ref', '--quiet', 'HEAD']).trim();
    if (!b.startsWith('refs/heads/')) fail('invalid_story', 'Detached HEAD unsupported');
    return b;
  }
  resolveCommit(ref: string): string {
    if (ref.startsWith('-') || ref.includes('\0')) fail('invalid_ref', ref);
    return this.git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  }
  read(commit: string, path: string): string {
    this.path(path);
    return this.git(['show', `${commit}:${path}`]);
  }
  files(commit: string, prefix = ''): string[] {
    return this.git(['ls-tree', '-r', '--name-only', '-z', commit])
      .split('\0')
      .filter((p) => p && p.startsWith(prefix));
  }
  path(path: string): void {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(path) ||
      path.startsWith('/') ||
      path.split('/').some((s) => !s || s === '.' || s === '..' || s === '.git') ||
      path.startsWith('runtime/') ||
      path.startsWith('cache/')
    )
      fail('invalid_path', path);
  }
  clean(): void {
    if (this.git(['status', '--porcelain=v1', '--untracked-files=all']).trim())
      fail('dirty_story', 'Commit or move existing changes before running CuetScript');
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.git(['rev-parse', '--absolute-git-dir']).trim(), 'cuet.lock');
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0)
        fail('story_locked', 'Invalid lock: inspect .git/cuet.lock');
      try {
        process.kill(pid, 0);
        fail('story_locked', `Story is used by process ${pid}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        rmSync(lock);
      }
    }
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch {
      return fail('story_locked', 'Story is locked');
    }
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
  prepare(base: string, changes: Record<string, string | null>, message: string): string {
    const temporary = mkdtempSync(join(tmpdir(), 'cuet-index-'));
    const env = { GIT_INDEX_FILE: join(temporary, 'index') };
    try {
      this.git(['read-tree', base], undefined, env);
      for (const [path, content] of Object.entries(changes)) {
        this.path(path);
        // Reject symlinks in canonical files and parents; Git paths are not shell input.
        const parents = path.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'));
        for (const parent of parents)
          if (this.git(['ls-tree', base, '--', parent]).startsWith('120000'))
            fail('invalid_path', 'Symlink in output path');
        if (content === null) {
          this.git(['update-index', '--force-remove', '--', path], undefined, env);
          continue;
        }
        const blob = this.git(['hash-object', '-w', '--stdin'], content).trim();
        this.git(['update-index', '--add', '--cacheinfo', '100644', blob, path], undefined, env);
      }
      const tree = this.git(['write-tree'], undefined, env).trim();
      return this.git(['commit-tree', tree, '-p', base], message + '\n', env).trim();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  publish(base: string, commit: string, branch: string, afterPublish?: () => void): void {
    this.clean();
    if (this.branch() !== branch || this.head() !== base)
      fail('version_conflict', 'Branch changed since input');
    this.git(['update-ref', branch, commit, base]);
    afterPublish?.();
    this.sync(base, commit);
  }
  sync(base: string, commit: string): void {
    // Two-tree merge refuses overlapping local edits, unlike reset --hard.
    this.git(['read-tree', '-u', '-m', base, commit]);
  }
  fork(name: string, ref: string): string {
    this.clean();
    this.git(['check-ref-format', '--branch', name]);
    const commit = this.resolveCommit(ref);
    this.git(['switch', '-c', name, commit]);
    return commit;
  }
}
