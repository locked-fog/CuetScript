// Explicit live test, separate invocations persist original signed reply parts.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Antigravity } from '../dist/providers/antigravity.js';
import { Journal } from '../dist/storage/journal.js';
import { Budget } from '../dist/runtime/budget.js';
const [phase, directory, authDir] = process.argv.slice(2);
if (!['first', 'second', 'third'].includes(phase) || !directory || !authDir)
  throw Error('Usage: first|second|third evidence-directory private-auth-directory');
const journal = new Journal(join(directory, 'agy-check.db'));
const budget = new Budget(journal, 'live', {
  calls: 20,
  tokens: 20000,
  seconds: 120,
  corrections: 2,
});
const provider = new Antigravity(authDir, budget);
const tool = {
  name: 'echo',
  description: 'Echo text back to you',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};
const path = join(directory, 'agy-replay.json');
try {
  const messages =
    phase === 'first'
      ? [
          {
            role: 'user',
            content:
              'First call echo with text alpha. After receiving alpha, call echo again with text beta. After receiving beta, say alpha beta and stop. Never call both tools in the same response.',
          },
        ]
      : JSON.parse(readFileSync(path, 'utf8'));
  const result = await provider.generate(
    messages,
    [tool],
    { model: 'gemini-3-flash', thinking: true, effort: 'low', maxTokens: 2048 },
    budget.signal,
  );
  messages.push(result.message);
  if (phase === 'third') {
    if (result.message.calls?.length || !result.message.content.includes('beta'))
      throw Error('Expected final text');
  } else {
    if (result.message.calls?.length !== 1 || result.message.calls[0].name !== 'echo')
      throw Error('Expected one echo call');
    const call = result.message.calls[0],
      args = JSON.parse(call.arguments);
    if (args.text !== (phase === 'first' ? 'alpha' : 'beta'))
      throw Error('Unexpected echo argument');
    messages.push({ role: 'tool', callId: call.id, content: args.text });
  }
  writeFileSync(path, JSON.stringify(messages, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      phase,
      model: 'gemini-3-flash',
      signedPartsPersisted: !!result.message.providerData?.agy_parts,
      toolCalls: result.message.calls?.length ?? 0,
      content: result.message.content,
      usage: budget.usage(),
    }),
  );
} finally {
  journal.close();
}
