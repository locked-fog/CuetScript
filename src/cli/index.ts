#!/usr/bin/env node
import { Command } from 'commander';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig, credential } from '../core/config.js';
import { CuetError, fail } from '../core/types.js';
import { GitStory } from '../storage/git.js';
import { Journal } from '../storage/journal.js';
import { Budget } from '../runtime/budget.js';
import { Antigravity, importDsh } from '../providers/antigravity.js';
import { DeepSeek } from '../providers/deepseek.js';
import { SiliconFlow, LoreRepository } from '../lore/repository.js';
import { StoryRuntime } from '../runtime/story.js';
const program = new Command().name('cuet').version('0.1.0-dev.1').description('本地多模型叙事系统');
program
  .option('--story <path>', '独立故事 Git 目录', '.')
  .option('--deepseek-key-file <path>', '从外部文件读取 DeepSeek 密钥')
  .option('--siliconflow-key-file <path>', '从外部文件读取 SiliconFlow 密钥')
  .option('--agy-auth-dir <path>', 'CuetScript 独立 Antigravity 凭据目录')
  .option('--quiet', '关闭 stderr 进度提示');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
function output(value: unknown) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
function context(id: string = randomUUID()) {
  const options = program.opts();
  const root = resolve(options.story as string);
  const config = loadConfig(root);
  const git = new GitStory(root);
  for (const [flag, env] of [
    ['deepseekKeyFile', config.deepseek.credentialEnv],
    ['siliconflowKeyFile', config.rag.credentialEnv],
  ] as const) {
    if (options[flag])
      process.env[env] = readFileSync(resolve(options[flag] as string), 'utf8').trim();
  }
  const journal = new Journal(join(root, 'runtime/execution.db'));
  if (!options.quiet)
    journal.onEvent = (kind, value) => {
      const data = value as Record<string, unknown>;
      if (['turn.resume', 'model', 'actor', 'lore.search'].includes(kind))
        console.error(`[cuet] ${kind} ${data.turn ?? data.model ?? data.character ?? ''}`);
    };
  const budget = new Budget(journal, `budget:${id}`, config.budget, controller.signal);
  return { root, config, git, journal, budget };
}
program
  .command('init <directory>')
  .description('创建自包含示例故事；不会覆盖现有目录')
  .action((directory: string) => {
    const root = resolve(directory);
    if (existsSync(root)) fail('existing_path', 'Destination must not exist');
    const example = fileURLToPath(new URL('../../examples/story/', import.meta.url));
    // Compiled entry lives in dist/cli, sources in src/cli: repository root is two levels up.
    const template = existsSync(example)
      ? example
      : fileURLToPath(new URL('../../../examples/story/', import.meta.url));
    mkdirSync(root, { recursive: true });
    cpSync(template, root, { recursive: true });
    // npm excludes .gitignore from packages; generate the story-local policy explicitly.
    if (!existsSync(join(root, '.gitignore')))
      writeFileSync(join(root, '.gitignore'), '/runtime/\n/cache/\n.env\n.env.*\n');
    execFileSync('git', ['-C', root, 'init', '-b', 'main'], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'add', '--', '.'], { stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=CuetScript',
        '-c',
        'user.email=cuet@localhost',
        'commit',
        '-m',
        'Initialize example story',
      ],
      { stdio: 'pipe' },
    );
    output({ story: root, next: 'Edit and commit the story, then run lore index and run.' });
  });
program
  .command('doctor')
  .description('本地环境检查，不调用模型')
  .action(() => {
    const c = context();
    try {
      output({
        node: process.version,
        supportedNode: process.versions.node.startsWith('26.'),
        git: c.git.head(),
        branch: c.git.branch(),
        deepseekCredential: !!process.env[c.config.deepseek.credentialEnv],
        siliconflowCredential: !!process.env[c.config.rag.credentialEnv],
        antigravity: {
          credentialDirectoryConfigured: !!(
            program.opts().agyAuthDir || process.env.CUET_AGY_AUTH_DIR
          ),
          maturity: 'experimental',
        },
        config: 'valid',
      });
    } finally {
      c.journal.close();
    }
  });
const lore = program.command('lore').description('完整语义检索');
for (const command of ['index', 'search <query>'])
  lore.command(command).action(async (query: string) => {
    const c = context();
    let repo: LoreRepository | undefined;
    try {
      repo = new LoreRepository(
        c.git,
        join(c.root, 'cache/lore.db'),
        new SiliconFlow(c.config.rag, credential(c.config.rag.credentialEnv), c.budget),
      );
      output(
        command === 'index'
          ? await repo.index(c.git.head())
          : await repo.search(c.git.head(), query),
      );
    } finally {
      repo?.close();
      c.journal.close();
    }
  });
const providers = program.command('provider');
providers.command('models <name>').action(async (name: string) => {
  const c = context();
  try {
    if (name !== 'antigravity' || !program.opts().agyAuthDir)
      fail('invalid_input', 'Specify antigravity and --agy-auth-dir');
    output(await new Antigravity(program.opts().agyAuthDir, c.budget).models());
  } finally {
    c.journal.close();
  }
});
program
  .command('auth')
  .command('import-dsh <source> <destination>')
  .option('--index <n>', 'Account index', '0')
  .option('--client-secret-file <path>', '将外部 OAuth 客户端配置写入新的私有目录')
  .action(
    (source: string, destination: string, opts: { index: string; clientSecretFile?: string }) => {
      const index = Number(opts.index);
      if (!Number.isInteger(index) || index < 0) fail('invalid_input', 'Invalid index');
      importDsh(source, destination, index, opts.clientSecretFile);
      output({ imported: true, sourceUnchanged: true });
    },
  );
providers
  .command('check <name>')
  .option('--model <id>', 'Model for Antigravity check')
  .description('执行真实 Provider 文本及工具往返验证')
  .action(async (name: string, opts: { model?: string }) => {
    const c = context();
    try {
      if (!['deepseek', 'antigravity'].includes(name))
        fail('provider_unavailable', 'Unknown provider');
      if (name === 'antigravity' && (!opts.model || !program.opts().agyAuthDir))
        fail('invalid_input', 'Specify --model and --agy-auth-dir');
      let provider: import('../core/types.js').ModelProvider =
        name === 'deepseek'
          ? new DeepSeek(
              c.config.deepseek.endpoint,
              credential(c.config.deepseek.credentialEnv),
              c.budget,
            )
          : new Antigravity(program.opts().agyAuthDir, c.budget);
      const modelOptions =
        name === 'deepseek'
          ? c.config.slots.orchestrator
          : { model: opts.model!, thinking: true, effort: 'low' as const, maxTokens: 2048 };
      const messages: import('../core/types.js').Message[] = [
        {
          role: 'user',
          content: '必须调用 echo 工具，参数 text 为 cuet-check。得到结果后回复结果。',
        },
      ];
      const tool = {
        name: 'echo',
        description: 'Return text',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      };
      const first = await provider.generate(messages, [tool], modelOptions, c.budget.signal);
      if (!first.message.calls?.length) fail('provider_error', 'Model did not call echo');
      c.journal.set('provider-check:replay', first.message);
      if (name === 'antigravity') provider = new Antigravity(program.opts().agyAuthDir, c.budget);
      messages.push(c.journal.get<import('../core/types.js').Message>('provider-check:replay')!);
      for (const call of first.message.calls) {
        if (call.name !== 'echo') fail('provider_error', 'Unexpected tool');
        messages.push({ role: 'tool', callId: call.id, content: call.arguments });
      }
      const next = await provider.generate(messages, [tool], modelOptions, c.budget.signal);
      if (next.message.calls?.length || !next.message.content)
        fail('provider_error', 'Tool roundtrip did not finish');
      output({
        provider: name,
        model: modelOptions.model,
        toolRoundtrip: true,
        content: next.message.content,
        usage: c.budget.usage(),
      });
    } finally {
      c.journal.close();
    }
  });
async function run(
  id: string | undefined,
  options?: { roleplay: string; direction: string; authorNote: string; ooc: string },
  branch?: string,
) {
  const c = context(id);
  let repo: LoreRepository | undefined;
  try {
    repo = new LoreRepository(
      c.git,
      join(c.root, 'cache/lore.db'),
      new SiliconFlow(c.config.rag, process.env[c.config.rag.credentialEnv] ?? '', c.budget),
    );
    const deepseek = new DeepSeek(
      c.config.deepseek.endpoint,
      process.env[c.config.deepseek.credentialEnv] ?? '',
      c.budget,
    );
    let agy: Antigravity | undefined;
    const router: import('../core/types.js').ModelProvider = {
      generate: (messages, tools, options, signal) => {
        if (options.provider !== 'antigravity')
          return deepseek.generate(messages, tools, options, signal);
        const directory = program.opts().agyAuthDir ?? process.env.CUET_AGY_AUTH_DIR;
        if (!directory) fail('missing_credential', 'Specify --agy-auth-dir or CUET_AGY_AUTH_DIR');
        agy ??= new Antigravity(directory, c.budget);
        return agy.generate(messages, tools, options, signal);
      },
    };
    const runtime = new StoryRuntime(c.git, c.journal, c.budget, router, repo, c.config);
    output(
      id
        ? branch
          ? await runtime.regenerate(id, branch)
          : await runtime.resume(id)
        : await runtime.start(options!),
    );
  } finally {
    repo?.close();
    c.journal.close();
  }
}
program
  .command('run')
  .option('--roleplay <text>', '角色行动或台词', '')
  .option('--direction <text>', '剧情方向', '')
  .option('--author-note <text>', '文风及篇幅要求', '')
  .option('--ooc <text>', '系统交流', '')
  .action(async (options) => {
    if (!Object.values(options).some(Boolean))
      fail('invalid_input', 'Provide at least one input field');
    await run(undefined, options);
  });
program
  .command('resume <turn>')
  .option('--additional-seconds <n>', '显式延长已耗尽的 Turn 时间预算')
  .option('--retry-protocol', '修复配置或程序后重置协议纠正计数')
  .action(async (id: string, opts: { additionalSeconds?: string; retryProtocol?: boolean }) => {
    if (opts.additionalSeconds || opts.retryProtocol) {
      const c = context(id);
      try {
        await c.git.locked(async () => {
          if (!c.journal.get(`turn:${id}`)) fail('invalid_input', 'Unknown Turn');
          if (opts.additionalSeconds) {
            const n = Number(opts.additionalSeconds);
            if (!Number.isInteger(n) || n < 1 || n > 86400)
              fail('invalid_input', 'Additional seconds must be 1..86400');
            c.journal.set(
              `deadline:budget:${id}`,
              Math.max(Date.now(), c.journal.get<number>(`deadline:budget:${id}`) ?? 0) + n * 1000,
            );
          }
          if (opts.retryProtocol)
            for (const row of c.journal.db
              .prepare('SELECT key,value FROM records WHERE key LIKE ?')
              .all(`agent:${id}:%`)) {
              const state = JSON.parse(row.value as string);
              state.corrections = 0;
              c.journal.set(row.key as string, state);
            }
          c.journal.event('resume.override', {
            turn: id,
            additionalSeconds: opts.additionalSeconds ?? null,
            retryProtocol: !!opts.retryProtocol,
          });
        });
      } finally {
        c.journal.close();
      }
    }
    await run(id);
  });
program
  .command('regenerate <turn>')
  .requiredOption('--branch <name>', '新的独立故事分支')
  .action(async (id: string, opts: { branch: string }) => run(id, undefined, opts.branch));
program
  .command('turns')
  .description('列出本地执行记录')
  .action(() => {
    const c = context();
    try {
      output(
        c.journal.db
          .prepare("SELECT value FROM records WHERE key LIKE 'turn:%'")
          .all()
          .map((r) => JSON.parse(r.value as string)),
      );
    } finally {
      c.journal.close();
    }
  });
program
  .command('branch <name>')
  .requiredOption('--from <commit>', '历史 Commit')
  .action(async (name: string, opts: { from: string }) => {
    const c = context();
    try {
      output(
        await c.git.locked(async () => ({ branch: name, commit: c.git.fork(name, opts.from) })),
      );
    } finally {
      c.journal.close();
    }
  });
try {
  if (!process.versions.node.startsWith('26.'))
    fail('unsupported_node', 'CuetScript currently requires Node.js 26');
  await program.parseAsync();
} catch (e) {
  output({
    error: e instanceof CuetError ? e.code : 'runtime_error',
    message:
      e instanceof CuetError
        ? e.message
        : 'Operation failed; inspect local configuration and execution records.',
  });
  process.exitCode = 1;
}
