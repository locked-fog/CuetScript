import {
  fail,
  type Message,
  type ModelOptions,
  type ToolSpec,
  type ModelProvider,
  type Generation,
  type ToolCall,
} from '../core/types.js';
import { json } from '../core/json.js';
import { request, Budget } from '../runtime/budget.js';
import { sse } from './sse.js';
export class DeepSeek implements ModelProvider {
  constructor(
    readonly endpoint: string,
    readonly key: string,
    readonly budget: Budget,
  ) {}
  async generate(
    messages: Message[],
    tools: ToolSpec[],
    options: ModelOptions,
    _signal: AbortSignal,
  ): Promise<Generation> {
    if (!this.key) fail('missing_credential', 'DeepSeek credential is required for model calls');
    if (options.thinking && options.temperature !== undefined)
      fail('invalid_config', 'Thinking and temperature cannot be combined');
    const wire = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.calls?.length
        ? {
            tool_calls: m.calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
      ...(m.callId ? { tool_call_id: m.callId } : {}),
      ...(m.role === 'assistant' && m.providerData?.reasoning_content !== undefined
        ? { reasoning_content: m.providerData.reasoning_content }
        : {}),
    }));
    const response = await request(
      `${this.endpoint.replace(/\/$/, '')}/chat/completions`,
      this.key,
      {
        model: options.model,
        messages: wire,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens,
        thinking: { type: options.thinking ? 'enabled' : 'disabled' },
        ...(options.effort ? { reasoning_effort: options.effort } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
      },
      this.budget,
    );
    if (!response.body) fail('provider_error', 'Empty response body');
    let content = '',
      reasoning = '',
      finish = '',
      requestId: string | null = response.headers.get('x-request-id');
    let usage: Generation['usage'] = null;
    const calls = new Map<number, ToolCall>();
    let ended = false;
    for await (const data of sse(response.body)) {
      if (data === '[DONE]') {
        ended = true;
        break;
      }
      const frame = JSON.parse(data);
      if (frame.error) fail('provider_error', 'Provider sent a streaming error');
      if (typeof frame.id === 'string') requestId = frame.id;
      if (frame.usage) {
        const a = frame.usage.prompt_tokens,
          b = frame.usage.completion_tokens;
        if (Number.isFinite(a) && a >= 0 && Number.isFinite(b) && b >= 0)
          usage = { input: a, output: b };
      }
      for (const choice of frame.choices ?? []) {
        if (choice.index !== 0) fail('provider_error', 'Only a single completion is supported');
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta ?? {};
        if (typeof d.content === 'string') content += d.content;
        if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
        for (const c of d.tool_calls ?? []) {
          if (!Number.isInteger(c.index) || c.index < 0)
            fail('provider_error', 'Invalid tool index');
          const old = calls.get(c.index) ?? { id: '', name: '', arguments: '' };
          old.id += c.id ?? '';
          old.name += c.function?.name ?? '';
          old.arguments += c.function?.arguments ?? '';
          calls.set(c.index, old);
        }
      }
    }
    this.budget.tokens(usage ? usage.input + usage.output : null);
    if (!ended || !['stop', 'tool_calls'].includes(finish))
      fail('provider_error', `Incomplete completion (${finish || 'no finish'})`);
    const all = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (all.some((c) => !c.id || !c.name) || new Set(all.map((c) => c.id)).size !== all.length)
      fail('provider_error', 'Invalid tool identity');
    if (all.length && finish !== 'tool_calls')
      fail('provider_error', 'Tool calls without matching finish');
    const message: Message = {
      role: 'assistant',
      content,
      providerData: { reasoning_content: reasoning, model: options.model, provider: 'deepseek' },
    };
    if (all.length) message.calls = all;
    json(message.providerData);
    return { message, finish, usage, requestId };
  }
}
