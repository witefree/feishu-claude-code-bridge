export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './types';
export { ClaudeAdapter } from './claude/adapter';
export { CodexAdapter } from './codex/adapter';

import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import type { AgentAdapter } from './types';

export type AgentType = 'claude' | 'codex';

/**
 * Create an AgentAdapter instance by type.
 * Defaults to 'claude' if the type is unrecognized.
 */
export function createAgent(type: AgentType = 'claude'): AgentAdapter {
  switch (type) {
    case 'codex':
      return new CodexAdapter();
    case 'claude':
    default:
      return new ClaudeAdapter();
  }
}
