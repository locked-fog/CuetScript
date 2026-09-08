import { it, expect } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitStory } from '../src/storage/git.js';
import { Journal } from '../src/storage/journal.js';
import { Budget } from '../src/runtime/budget.js';
import { StoryRuntime } from '../src/runtime/story.js';
import { loadConfig } from '../src/core/config.js';
import { hash } from '../src/core/json.js';
import type { ModelProvider, Message } from '../src/core/types.js';
import type { LoreRepository } from '../src/lore/repository.js';
it('runs nested actors, enforces candidate review, patches Canon and resumes without model calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cuet-story-'));
  cpSync('examples/story', root, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('init', '-b', 'main');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@localhost');
  g('add', '.');
  g('commit', '-m', 'init');
  const git = new GitStory(root),
    j = new Journal(join(root, 'runtime/db')),
    config = loadConfig(root),
    budget = new Budget(j, 'b', config.budget);
  const prose = '林灯脱下外套，放在椅子上，问：“您来查什么资料？”';
  let count = 0,
    actors = 0;
  const provider: ModelProvider = {
    generate: async (messages, tools) => {
      count++;
      const call = (name: string, args: unknown): Message => ({
        role: 'assistant',
        content: '',
        calls: [{ id: String(count), name, arguments: JSON.stringify(args) }],
      });
      let message: Message;
      if (!tools.length) {
        actors++;
        const actorInput = JSON.parse(messages[1]!.content);
        expect(actorInput.status.length).toBeGreaterThan(0);
        expect(actorInput.draft).toBeUndefined();
        message = { role: 'assistant', content: prose };
      } else if (tools.some((t) => t.name === 'runActor')) {
        message = messages.some((m) => m.role === 'tool' && m.content.includes('林灯脱下'))
          ? call('submit', { content: prose })
          : call('runActor', {
              character: 'character.keeper',
              draft: '',
              scene: '接待室',
              progress: '尚未脱外套',
              suggestion: '脱外套后提问，不替旅人回答',
            });
      } else if (!messages.some((m) => m.role === 'tool' && m.content.includes('submitted')))
        message = call('runWriter', {
          instruction: '写作',
          references: [{ path: 'status/characters/keeper.yaml', pointer: '' }],
          lore: [],
        });
      else if (!messages.some((m) => m.role === 'tool' && m.content.includes('逐文档')))
        message = call('reviewCandidate', { draftHash: hash(prose) });
      else
        message = call('accept', {
          draftHash: hash(prose),
          changes: [
            {
              path: 'status/characters/keeper.yaml',
              patch: [
                { op: 'test', path: '/status/clothing/jacket', value: 'worn' },
                { op: 'replace', path: '/status/clothing/jacket', value: 'removed' },
              ],
              evidence: '林灯脱下外套',
            },
          ],
          unchanged: [
            { path: 'status/characters/traveler.yaml', reason: '没有新动作' },
            { path: 'status/scene/current.yaml', reason: '测试未改变场景字段' },
          ],
          notebook: null,
          review: '完成',
        });
      return {
        message,
        usage: null,
        requestId: null,
        finish: message.calls ? 'tool_calls' : 'stop',
      };
    },
  };
  const lore = { index: async () => ({}), search: async () => [] } as unknown as LoreRepository;
  try {
    const runtime = new StoryRuntime(git, j, budget, provider, lore, config);
    const result = (await runtime.start({
      roleplay: '请问',
      direction: '',
      authorNote: '',
      ooc: '',
    })) as { turn: string; commit: string };
    expect(actors).toBe(1);
    expect(git.read(result.commit, 'status/characters/keeper.yaml')).toContain('removed');
    git.clean();
    const before = count;
    await runtime.resume(result.turn);
    expect(count).toBe(before);
    const alternative = (await runtime.regenerate(result.turn, 'alternative')) as {
      turn: string;
      commit: string;
    };
    expect(git.branch()).toBe('refs/heads/alternative');
    expect(git.files(alternative.commit).filter((p) => p.startsWith('user-input/'))).toHaveLength(
      1,
    );
    expect(git.files(alternative.commit)).not.toContain(`prose/${result.turn}.md`);
    expect(alternative.turn).not.toBe(result.turn);
  } finally {
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});
