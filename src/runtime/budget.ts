import { setTimeout } from 'node:timers/promises';
import { CuetError, type Config } from '../core/types.js';
import { Journal } from '../storage/journal.js';
interface Usage {
  calls: number;
  tokens: number;
  unknownUsage: number;
}
export class Budget {
  readonly signal: AbortSignal;
  constructor(
    readonly journal: Journal,
    public key: string,
    readonly limits: Config['budget'],
    signal?: AbortSignal,
  ) {
    this.signal = AbortSignal.any([
      AbortSignal.timeout(limits.seconds * 1000),
      ...(signal ? [signal] : []),
    ]);
  }
  check(): void {
    if (this.signal.aborted)
      throw new CuetError(
        this.signal.reason?.name === 'TimeoutError' ? 'budget_exceeded' : 'cancelled',
        'Execution deadline or cancellation reached',
      );
    const deadlineKey = `deadline:${this.key}`;
    let deadline = this.journal.get<number>(deadlineKey);
    if (deadline === undefined) {
      deadline = Date.now() + this.limits.seconds * 1000;
      this.journal.set(deadlineKey, deadline);
    }
    if (Date.now() >= deadline)
      throw new CuetError(
        'budget_exceeded',
        'Persisted Turn deadline reached; explicitly extend it to resume',
      );
    const u = this.usage();
    if (u.calls >= this.limits.calls || u.tokens >= this.limits.tokens)
      throw new CuetError('budget_exceeded', 'Call or token budget exhausted; progress saved');
  }
  usage(): Usage {
    return this.journal.get<Usage>(this.key) ?? { calls: 0, tokens: 0, unknownUsage: 0 };
  }
  charge(): void {
    this.check();
    const u = this.usage();
    u.calls++;
    this.journal.set(this.key, u);
  }
  tokens(value: number | null): void {
    const u = this.usage();
    if (value === null) u.unknownUsage++;
    else u.tokens += value;
    this.journal.set(this.key, u);
  }
}
export async function request(
  endpoint: string,
  key: string,
  payload: unknown,
  budget: Budget,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    budget.charge();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: budget.signal,
      });
    } catch {
      if (budget.signal.aborted) budget.check();
      if (attempt === 2) throw new CuetError('provider_error', 'Transport failed', true);
      await setTimeout(250 * 2 ** attempt, undefined, { signal: budget.signal });
      continue;
    }
    if (response.ok) return response;
    const retry = response.status === 429 || response.status >= 500;
    const after = response.headers.get('retry-after');
    await response.body?.cancel();
    if (!retry || attempt === 2)
      throw new CuetError('provider_error', `Provider HTTP ${response.status}`, retry);
    const seconds = after ? Number(after) : NaN;
    const delay = Number.isFinite(seconds)
      ? Math.min(30000, Math.max(0, seconds * 1000))
      : 250 * 2 ** attempt;
    await setTimeout(delay, undefined, { signal: budget.signal });
  }
  throw new CuetError('provider_error', 'Retry exhausted');
}
