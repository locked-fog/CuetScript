import { createServer, type IncomingMessage } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GitStory } from '../storage/git.js';
import { CuetError, fail } from '../core/types.js';
import { parseConfig } from '../core/config.js';
import { parseYaml, statusDocument } from '../status/documents.js';
import { parseAccess } from '../core/context.js';
import { page } from './page.js';
export interface WebOptions {
  directory: string;
  token?: string;
  deepseekKeyFile?: string;
  siliconflowKeyFile?: string;
  agyAuthDir?: string;
  cli?: string;
}
interface Job {
  id: string;
  story: string;
  action: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: string;
  result?: unknown;
  process?: ChildProcess;
  cancelling?: boolean;
}
function field(body: Record<string, unknown>, key: string, required = false): string {
  const value = body[key] ?? '';
  if (typeof value !== 'string' || value.length > 200000 || (required && !value.trim()))
    fail('invalid_input', `Invalid ${key}`);
  return value;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  req.setEncoding('utf8');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024) fail('invalid_input', 'Request too large');
  }
  const value: unknown = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('invalid_input', 'Object required');
  return value as Record<string, unknown>;
}
export function createWebServer(options: WebOptions) {
  mkdirSync(options.directory, { recursive: true });
  const directory = realpathSync(options.directory);
  const token = options.token || randomBytes(32).toString('hex');
  const jobs = new Map<string, Job>();
  const editing = new Set<string>();
  function story(name: string, existing = true) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
      fail('invalid_input', 'Story name: letters, numbers, - or _');
    const path = join(directory, name);
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path))
      fail('invalid_path', 'Story symlinks unsupported');
    if (existing) new GitStory(path);
    return path;
  }
  function idle(name: string) {
    if (
      editing.has(name) ||
      [...jobs.values()].some((j) => j.story === name && j.status === 'running')
    )
      fail('story_locked', '故事正在运行，请等待或停止当前操作。');
  }
  function publicJob(job: Job) {
    return {
      id: job.id,
      story: job.story,
      action: job.action,
      status: job.status,
      progress: job.progress,
      result: job.result,
    };
  }
  function launch(name: string, action: string, args: string[]) {
    idle(name);
    const path = story(name, action !== 'init');
    const flags = ['--story', path];
    for (const [flag, value] of [
      ['--deepseek-key-file', options.deepseekKeyFile],
      ['--siliconflow-key-file', options.siliconflowKeyFile],
      ['--agy-auth-dir', options.agyAuthDir],
    ])
      if (value) flags.push(flag!, value);
    const child = spawn(
      process.execPath,
      [
        options.cli ?? fileURLToPath(new URL('../cli/index.js', import.meta.url)),
        ...flags,
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const job: Job = {
      id: randomUUID(),
      story: name,
      action,
      status: 'running',
      progress: '',
      process: child,
    };
    jobs.set(job.id, job);
    // Completed jobs are only a UI cache. Durable turns remain in the story journal.
    if (jobs.size > 100)
      for (const [id, old] of jobs)
        if (old.status !== 'running') {
          jobs.delete(id);
          break;
        }
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    let output = '';
    child.stdout!.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.length > 8 * 1024 * 1024) {
        job.progress = '输出超过网页限制，请查看本地记录。';
        child.kill('SIGTERM');
      }
    });
    child.stderr!.on('data', (data: Buffer) => {
      job.progress = (job.progress + data.toString()).slice(-16000);
    });
    child.on('error', () => {
      job.status = 'failed';
      job.result = { error: '无法启动运行程序' };
    });
    child.on('close', (code) => {
      job.status = job.cancelling ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
      try {
        job.result = JSON.parse(output);
      } catch {
        job.result = { message: output || '操作已停止，可从记录恢复。' };
      }
      delete job.process;
    });
    return publicJob(job);
  }
  function editable(path: string) {
    return (
      path === 'config/cuet.yaml' ||
      path === 'metadata/access.json' ||
      path === 'notebook.md' ||
      /^(status|lore)\/[a-zA-Z0-9_/-]+\.ya?ml$/.test(path)
    );
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        send({ message: '请输入启动服务时显示的访问口令。' }, 401);
        return;
      }
      // Auth is a custom header; cross-origin pages cannot submit authenticated requests.
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`
      ) {
        send({ message: 'Cross-origin request rejected' }, 403);
        return;
      }
      if (url.pathname === '/api/stories' && req.method === 'GET') {
        send({
          stories: readdirSync(directory, { withFileTypes: true })
            .filter(
              (e) =>
                e.isDirectory() &&
                /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(e.name) &&
                existsSync(join(directory, e.name, '.git')),
            )
            .map((e) => e.name),
          jobs: [...jobs.values()].map(publicJob),
          credentials: {
            deepseek: !!(options.deepseekKeyFile || process.env.DEEPSEEK_API_KEY),
            siliconflow: !!(options.siliconflowKeyFile || process.env.SILICONFLOW_API_KEY),
            antigravity: !!options.agyAuthDir,
          },
        });
        return;
      }
      if (url.pathname === '/api/job' && req.method === 'GET') {
        const job = jobs.get(url.searchParams.get('id') ?? '');
        if (!job) fail('invalid_input', 'Unknown job');
        send(publicJob(job));
        return;
      }
      if (url.pathname === '/api/story' && req.method === 'GET') {
        const git = new GitStory(story(url.searchParams.get('story') ?? ''));
        const head = git.head();
        send({
          head,
          branch: git.branch().replace('refs/heads/', ''),
          dirty: !!git.git(['status', '--porcelain']).trim(),
          branches: git
            .git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
            .trim()
            .split('\n'),
          files: git
            .files(head)
            .filter((p) => editable(p) || p.startsWith('prose/') || p.startsWith('metadata/ooc/')),
          commits: git.git(['log', '-30', '--format=%h %s']),
        });
        return;
      }
      if (url.pathname === '/api/file' && req.method === 'GET') {
        const git = new GitStory(story(url.searchParams.get('story') ?? ''));
        const path = url.searchParams.get('path') ?? '';
        if (!editable(path) && !path.startsWith('prose/') && !path.startsWith('metadata/ooc/'))
          fail('invalid_path', 'File unavailable');
        const head = git.head();
        send({ path, head, content: git.read(head, path), editable: editable(path) });
        return;
      }
      if (req.method !== 'POST') {
        send({ message: 'Not found' }, 404);
        return;
      }
      const data = await body(req);
      if (url.pathname === '/api/cancel') {
        const job = jobs.get(field(data, 'id', true));
        if (!job) fail('invalid_input', 'Unknown job');
        if (job.process && job.status === 'running') {
          job.cancelling = true;
          job.process.kill('SIGINT');
          const timer = setTimeout(() => job.process?.kill('SIGTERM'), 10000);
          timer.unref();
        }
        send(publicJob(job));
        return;
      }
      const name = field(data, 'story', true);
      if (url.pathname === '/api/file') {
        idle(name);
        const git = new GitStory(story(name)),
          path = field(data, 'path', true),
          content = field(data, 'content');
        git.path(path);
        if (!editable(path)) fail('invalid_path', 'Only story settings can be edited');
        if (data.remove && !/^(status|lore)\//.test(path))
          fail('invalid_input', 'Only Lore and Status files can be removed');
        if (!data.remove) {
          if (path === 'config/cuet.yaml') parseConfig(parseYaml(content));
          else if (path === 'metadata/access.json') parseAccess(content);
          else if (path.startsWith('status/')) statusDocument(content);
          else if (path.startsWith('lore/')) {
            const v = parseYaml(content) as Record<string, unknown>;
            if (!v || !['id', 'title', 'content'].every((k) => typeof v[k] === 'string' && v[k]))
              fail('invalid_input', 'Lore requires id, title, content');
          }
        }
        editing.add(name);
        try {
          send(
            await git.locked(async () => {
              git.clean();
              const base = git.head();
              if (base !== field(data, 'head', true))
                fail('version_conflict', '版本已变化，请重新加载后编辑。');
              const next = git.prepare(
                base,
                { [path]: data.remove ? null : content },
                `Web: ${data.remove ? 'remove' : 'edit'} ${path}`,
              );
              git.publish(base, next, git.branch());
              return { commit: next };
            }),
          );
        } finally {
          editing.delete(name);
        }
        return;
      }
      if (url.pathname !== '/api/action') {
        send({ message: 'Not found' }, 404);
        return;
      }
      const action = field(data, 'action', true);
      let args: string[];
      switch (action) {
        case 'init':
          args = ['init', story(name, false)];
          break;
        case 'doctor':
        case 'turns':
          args = [action];
          break;
        case 'run':
          args = ['run'];
          for (const [key, flag] of [
            ['roleplay', '--roleplay'],
            ['direction', '--direction'],
            ['authorNote', '--author-note'],
            ['ooc', '--ooc'],
          ]) {
            const v = field(data, key!);
            if (v) args.push(flag!, v);
          }
          break;
        case 'index':
          args = ['lore', 'index'];
          break;
        case 'search':
          args = ['lore', 'search', field(data, 'query', true)];
          break;
        case 'resume':
          args = ['resume', field(data, 'turn', true)];
          if (data.additionalSeconds)
            args.push('--additional-seconds', field(data, 'additionalSeconds'));
          if (data.retryProtocol === true) args.push('--retry-protocol');
          break;
        case 'regenerate':
          args = ['regenerate', field(data, 'turn', true), '--branch', field(data, 'branch', true)];
          break;
        case 'branch':
          args = ['branch', field(data, 'branch', true), '--from', field(data, 'from', true)];
          break;
        case 'switch': {
          idle(name);
          const git = new GitStory(story(name));
          const branch = field(data, 'branch', true);
          editing.add(name);
          try {
            send(
              await git.locked(async () => {
                git.clean();
                git.git(['check-ref-format', '--branch', branch]);
                git.git(['switch', '--', branch]);
                return { branch };
              }),
            );
          } finally {
            editing.delete(name);
          }
          return;
        }
        case 'models':
          args = ['provider', 'models', 'antigravity'];
          break;
        case 'check': {
          const provider = field(data, 'provider', true);
          if (!['deepseek', 'antigravity'].includes(provider))
            fail('invalid_input', 'Unknown provider');
          args = ['provider', 'check', provider];
          if (data.model) args.push('--model', field(data, 'model'));
          break;
        }
        default:
          return fail('invalid_input', 'Unknown action');
      }
      send(launch(name, action, args), 202);
    } catch (error) {
      send(
        {
          error: error instanceof CuetError ? error.code : 'request_failed',
          message:
            error instanceof CuetError ? error.message : '操作失败，请检查输入及本地故事配置。',
        },
        400,
      );
    }
  });
  return {
    server,
    token,
    close: () => {
      for (const job of jobs.values()) job.process?.kill('SIGINT');
      server.close();
    },
  };
}
