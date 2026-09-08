import {
  CuetError,
  fail,
  type Message,
  type ModelOptions,
  type ModelProvider,
  type ToolSpec,
} from '../core/types.js';
import { validate } from '../core/json.js';
import { Journal } from '../storage/journal.js';
import { Budget } from './budget.js';
export interface Tool extends ToolSpec {
  terminal?: boolean;
  execute: (args: any, callKey: string) => Promise<unknown>;
}
interface Checkpoint {
  messages: Message[];
  corrections: number;
  completed: boolean;
  result?: unknown;
}
export class Agent {
  constructor(
    readonly journal: Journal,
    readonly budget: Budget,
    readonly provider: ModelProvider,
  ) {}
  async run(
    id: string,
    initial: Message[],
    tools: Tool[],
    options: ModelOptions,
  ): Promise<unknown> {
    const key = `agent:${id}`;
    const state = this.journal.get<Checkpoint>(key) ?? {
      messages: initial,
      corrections: 0,
      completed: false,
    };
    const save = () => this.journal.set(key, state);
    let rejectedThisRound = false;
    const reject = () => {
      if (!rejectedThisRound) state.corrections++;
      rejectedThisRound = true;
    };
    save();
    if (state.completed) return state.result;
    while (true) {
      if (state.corrections > this.budget.limits.corrections)
        fail(
          'agent_protocol_failure',
          'Too many invalid model responses; transcript includes matching tool results',
        );
      this.budget.check();
      let latestIndex = state.messages.length - 1;
      while (latestIndex >= 0 && state.messages[latestIndex]?.role === 'tool') latestIndex--;
      const latest = state.messages[latestIndex];
      if (latest?.role === 'assistant' && latest.calls?.length) {
        const answered = new Set(state.messages.slice(latestIndex + 1).map((m) => m.callId));
        const batch = latest.calls;
        const invalidBatch =
          batch.length > 1 && batch.some((c) => tools.find((t) => t.name === c.name)?.terminal);
        for (const call of batch) {
          if (answered.has(call.id)) continue;
          const tool = tools.find((t) => t.name === call.name);
          let args: unknown;
          let validationError = '';
          try {
            if (invalidBatch || !tool)
              fail('invalid_tool', 'Unknown tool or terminal tool mixed with other calls');
            args = JSON.parse(call.arguments);
            validate(tool.parameters, args);
          } catch (e) {
            validationError = e instanceof Error ? e.message : 'Invalid arguments';
          }
          const callKey = `${id}:${latestIndex}:${call.id}`;
          const cached = this.journal.get<{ value: unknown }>(`tool:${callKey}`);
          let result: unknown;
          let success = false;
          if (cached) {
            result = cached.value;
            success = true;
          } else if (validationError) {
            result = { error: 'invalid_tool', message: validationError };
            reject();
          } else {
            try {
              result = await tool!.execute(args, callKey);
              success = true;
              this.journal.set(`tool:${callKey}`, { value: result });
            } catch (e) {
              if (
                !(e instanceof CuetError) ||
                ![
                  'invalid_input',
                  'invalid_patch',
                  'missing_context',
                  'invalid_tool',
                  'invalid_draft',
                  'invalid_path',
                  'invalid_pointer',
                ].includes(e.code)
              )
                throw e;
              result = { error: e.code, message: e.message };
              reject();
            }
          }
          state.messages.push({ role: 'tool', callId: call.id, content: JSON.stringify(result) });
          if (tool?.terminal && success) {
            state.completed = true;
            state.result = result;
          }
          save();
          if (state.completed) return state.result;
        }
      } else if (latest?.role === 'assistant') {
        reject();
        state.messages.push({
          role: 'user',
          content: `Invocation 尚未完成，请调用结束工具：${tools
            .filter((t) => t.terminal)
            .map((t) => t.name)
            .join('、')}。`,
        });
        save();
      }
      if (state.corrections > this.budget.limits.corrections)
        fail('agent_protocol_failure', 'Too many invalid model response rounds');
      rejectedThisRound = false;
      const generation = await this.provider.generate(
        state.messages,
        tools,
        options,
        this.budget.signal,
      );
      state.messages.push(generation.message);
      save();
      this.journal.event('model', {
        id,
        model: options.model,
        requestId: generation.requestId,
        usage: generation.usage,
        finish: generation.finish,
      });
    }
  }
}
