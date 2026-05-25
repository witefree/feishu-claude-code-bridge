import type { AgentEvent } from '../types';

interface CodexItem {
  id?: string;
  type: string;
  text?: string;
  reasoning_content?: string;
  command?: string;
  status?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function?: {
      name: string;
      arguments: string;
    };
  }>;
}

interface CodexRawEvent {
  type: string;
  thread_id?: string;
  turn_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: {
    message: string;
    code?: string;
  };
  message?: string;
}

/** Translate a single Codex JSONL line into zero or more AgentEvents. */
export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  // Session init
  if (evt.type === 'thread.started' && evt.thread_id) {
    yield { type: 'system', sessionId: evt.thread_id };
    return;
  }

  // Agent message content (text / reasoning / tool calls)
  if (evt.type === 'item.completed' && evt.item) {
    const item = evt.item;

    // Agent message with text content
    if (item.type === 'agent_message') {
      if (item.reasoning_content) {
        yield { type: 'thinking', delta: item.reasoning_content };
      }
      if (typeof item.text === 'string' && item.text) {
        yield { type: 'text', delta: item.text };
      }
      // Tool calls in agent message
      if (Array.isArray(item.tool_calls)) {
        for (const tc of item.tool_calls) {
          if (tc.type === 'function' && tc.function?.name && tc.id) {
            let input: unknown = undefined;
            try {
              input = tc.function.arguments ? JSON.parse(tc.function.arguments) : undefined;
            } catch {
              input = tc.function.arguments;
            }
            yield {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            };
          }
        }
      }
      return;
    }

    // Command execution as tool-like event
    if (item.type === 'command_execution' && item.id && item.command) {
      yield {
        type: 'tool_use',
        id: item.id,
        name: 'command_execution',
        input: { command: item.command },
      };
      // Also emit result when completed
      if (item.status === 'completed') {
        yield {
          type: 'tool_result',
          id: item.id,
          output: '',
          isError: false,
        };
      }
      return;
    }

    return;
  }

  // Turn completed = usage + done
  if (evt.type === 'turn.completed') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens ?? evt.usage.cached_input_tokens,
        outputTokens: evt.usage.output_tokens,
      };
    }
    yield { type: 'done', sessionId: evt.turn_id };
    return;
  }

  // Error handling
  if (evt.type === 'error' || evt.type === 'turn.failed') {
    const msg =
      evt.error?.message || evt.message || String(raw);
    yield { type: 'error', message: msg };
    return;
  }
}
