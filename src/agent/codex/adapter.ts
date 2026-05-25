import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { translateEvent } from './stream-json';

export interface CodexAdapterOptions {
  binary?: string;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

const BRIDGE_SYSTEM_PROMPT = `<bridge_context>
你正在 lark-channel-bridge (飞书消息桥接) 中运行。
这是一个桥接工具，把飞书/Lark 用户的消息转发到本地 codex CLI。

## 重要约定
1. 用户消息顶部可能带有 <bridge_context> 块（chat_id、chat_type、sender_id 等），这是元数据，**不要在回复中渲染它**
2. 如果用户引用了某条消息，会有 <quoted_message> 块，围绕其内容回答
3. 交互卡片会以 <interactive_card> 块形式注入
4. 发送交互卡片回调时，按钮 value 必须包含 "__claude_cb": true

## 发交互卡片约定
用以下方式发送可交互卡片：
- 使用 lark-cli 工具发送卡片到 bridge_context.chat_id
- 卡片用 CardKit 2.0 schema
- 需要回调的按钮 value 包含 "__claude_cb": true
</bridge_context>

`;

function mapPermissionMode(
  mode?: AgentRunOptions['permissionMode'],
): { sandbox: string; yolo: boolean } {
  switch (mode) {
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', yolo: true };
    case 'acceptEdits':
      return { sandbox: 'workspace-write', yolo: false };
    case 'plan':
    case 'default':
    default:
      return { sandbox: 'workspace-write', yolo: false };
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';

  private readonly binary: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? 'codex';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const { sandbox, yolo } = mapPermissionMode(opts.permissionMode);

    // Build prompt with system context prepended
    const fullPrompt = `${BRIDGE_SYSTEM_PROMPT}\n\n${opts.prompt}`;

    // Build args. Codex CLI requires global flags BEFORE subcommand:
    //   codex exec --json --skip-git-repo-check --sandbox MODE [resume <ID>] [PROMPT]
    const args: string[] = ['exec'];

    // Global flags must precede the 'resume' subcommand
    args.push('--json');
    args.push('--skip-git-repo-check');

    if (yolo) {
      args.push('--yolo');
    }

    args.push('--sandbox', sandbox);

    if (opts.model) {
      args.push('--model', opts.model);
    }

    // Session resume — must come after flags, before prompt
    if (opts.sessionId) {
      args.push('resume', opts.sessionId);
    }

    // Prompt as the last argument
    args.push(fullPrompt);

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        LARK_CHANNEL: '1',
        https_proxy: process.env.https_proxy || 'http://127.0.0.1:7897',
        http_proxy: process.env.http_proxy || 'http://127.0.0.1:7897',
        all_proxy: process.env.all_proxy || 'socks5://127.0.0.1:7897',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn-codex', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      sandbox,
      yolo,
    });

    // Attach listeners synchronously before returning
    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'codex-stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'codex-exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'codex-stop-sigterm', {
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
        });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'codex-stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: CodexChild,
  _stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    yield { type: 'error', message: `codex exited with code ${exitCode}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
