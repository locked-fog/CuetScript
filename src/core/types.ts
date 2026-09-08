export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export class CuetError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = 'CuetError';
  }
}
export function fail(code: string, message: string): never {
  throw new CuetError(code, message);
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  calls?: ToolCall[];
  callId?: string;
  providerData?: Record<string, Json>;
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelOptions {
  provider?: 'deepseek' | 'antigravity';
  model: string;
  thinking: boolean;
  maxTokens: number;
  temperature?: number;
  effort?: 'low' | 'high' | 'max';
}
export interface Generation {
  message: Message;
  usage: { input: number; output: number } | null;
  requestId: string | null;
  finish: string;
}
export interface ModelProvider {
  generate(
    messages: Message[],
    tools: ToolSpec[],
    options: ModelOptions,
    signal: AbortSignal,
  ): Promise<Generation>;
}
export interface Input {
  roleplay: string;
  direction: string;
  authorNote: string;
  ooc: string;
}
export interface Config {
  schema_version: 1;
  deepseek: { endpoint: string; credentialEnv: string };
  slots: { orchestrator: ModelOptions; writer: ModelOptions; actor: ModelOptions };
  rag: {
    endpoint: string;
    credentialEnv: string;
    embeddingModel: string;
    rerankerModel: string;
    dimensions: number;
    chunkChars: number;
    topK: number;
    topN: number;
  };
  budget: { calls: number; tokens: number; seconds: number; corrections: number };
  userControl: {
    characters: string[];
    allowMinorActions: boolean;
    resultDeclarations: 'attempt' | 'established';
  };
}
