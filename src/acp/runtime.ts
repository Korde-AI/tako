/**
 * AcpxRuntime — manages acpx sessions and prompt turns.
 *
 * Modeled after OpenClaw's acpx extension runtime, adapted for Tako's
 * architecture without any plugin-sdk dependencies.
 */

import { createInterface } from 'node:readline';
import type { AcpRuntimeConfig } from './config.js';
import type { AcpRuntimeEvent } from './events.js';
import {
  parseJsonLines,
  parsePromptEventLine,
  toAcpxErrorEvent,
} from './events.js';
import {
  spawnAcpx,
  spawnAndCollect,
  waitForExit,
  resolveSpawnFailure,
  resolveAcpxCommand,
} from './process.js';
import {
  asTrimmedString,
  asOptionalString,
  buildPermissionArgs,
  isRecord,
  type AcpxHandleState,
  type AcpxJsonObject,
} from './shared.js';

// ─── Constants ───────────────────────────────────────────────────

const HANDLE_PREFIX = 'acpx:v1:';
const EXIT_CODE_PERMISSION_DENIED = 5;

// ─── Handle encoding ────────────────────────────────────────────

/** Encode session state into a portable handle string. */
export function encodeHandleState(state: AcpxHandleState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${HANDLE_PREFIX}${payload}`;
}

/** Decode a handle string back into session state. */
export function decodeHandleState(handle: string): AcpxHandleState | null {
  const trimmed = handle.trim();
  if (!trimmed.startsWith(HANDLE_PREFIX)) return null;
  const encoded = trimmed.slice(HANDLE_PREFIX.length);
  if (!encoded) return null;
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const name = asTrimmedString(parsed.name);
    const agent = asTrimmedString(parsed.agent);
    const cwd = asTrimmedString(parsed.cwd);
    const mode = asTrimmedString(parsed.mode);
    if (!name || !agent || !cwd) return null;
    if (mode !== 'persistent' && mode !== 'oneshot') return null;
    return {
      name,
      agent,
      cwd,
      mode,
      ...(asOptionalString(parsed.acpxRecordId) ? { acpxRecordId: asOptionalString(parsed.acpxRecordId) } : {}),
      ...(asOptionalString(parsed.backendSessionId) ? { backendSessionId: asOptionalString(parsed.backendSessionId) } : {}),
      ...(asOptionalString(parsed.agentSessionId) ? { agentSessionId: asOptionalString(parsed.agentSessionId) } : {}),
    };
  } catch {
    return null;
  }
}

// ─── Error ───────────────────────────────────────────────────────

export type AcpRuntimeErrorCode =
  | 'ACP_BACKEND_UNAVAILABLE'
  | 'ACP_SESSION_INIT_FAILED'
  | 'ACP_TURN_FAILED';

export class AcpRuntimeError extends Error {
  readonly code: AcpRuntimeErrorCode;
  constructor(code: AcpRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcpRuntimeError';
    this.code = code;
  }
}

// ─── Handle type ─────────────────────────────────────────────────

/** An opaque handle referencing an acpx session. */
export interface AcpRuntimeHandle {
  sessionKey: string;
  runtimeSessionName: string;
  cwd: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
}

// ─── Status type ─────────────────────────────────────────────────

export interface AcpRuntimeStatus {
  summary: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  details?: Record<string, unknown>;
}

// ─── Input types ─────────────────────────────────────────────────

export interface AcpEnsureInput {
  sessionKey: string;
  agent: string;
  cwd?: string;
  mode: 'persistent' | 'oneshot';
  resumeSessionId?: string;
}

export interface AcpTurnInput {
  handle: AcpRuntimeHandle;
  text: string;
  signal?: AbortSignal;
}

// ─── Runtime ─────────────────────────────────────────────────────

export class AcpxRuntime {
  private healthy = false;
  private resolvedCommand: string;

  constructor(private readonly config: AcpRuntimeConfig) {
    this.resolvedCommand = config.command || resolveAcpxCommand(config.cwd);
  }

  /** Whether the runtime is healthy (acpx is available). */
  isHealthy(): boolean {
    return this.healthy;
  }

  /** Probe acpx availability by running `acpx --help`. */
  async probeAvailability(): Promise<void> {
    try {
      const result = await spawnAndCollect({
        command: this.resolvedCommand,
        args: ['--help'],
        cwd: this.config.cwd,
        stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
      });
      this.healthy = result.error == null && (result.code ?? 0) === 0;
    } catch {
      this.healthy = false;
    }
  }

  /** Create or resume an acpx session. */
  async ensureSession(input: AcpEnsureInput): Promise<AcpRuntimeHandle> {
    const sessionName = asTrimmedString(input.sessionKey);
    if (!sessionName) {
      throw new AcpRuntimeError('ACP_SESSION_INIT_FAILED', 'ACP session key is required.');
    }
    const agent = asTrimmedString(input.agent);
    if (!agent) {
      throw new AcpRuntimeError('ACP_SESSION_INIT_FAILED', 'ACP agent id is required.');
    }
    const cwd = asTrimmedString(input.cwd) || this.config.cwd;
    const resumeSessionId = asTrimmedString(input.resumeSessionId);

    // Try `sessions ensure`, fall back to `sessions new`
    const ensureSubcommand = resumeSessionId
      ? ['sessions', 'new', '--name', sessionName, '--resume-session', resumeSessionId]
      : ['sessions', 'ensure', '--name', sessionName];

    const ensureArgs = this.buildVerbArgs({ agent, cwd, command: ensureSubcommand });

    let events = await this.runControlCommand({
      args: ensureArgs,
      cwd,
      fallbackCode: 'ACP_SESSION_INIT_FAILED',
    });

    let ensuredEvent = this.findSessionEvent(events);

    if (!ensuredEvent && !resumeSessionId) {
      const newArgs = this.buildVerbArgs({
        agent,
        cwd,
        command: ['sessions', 'new', '--name', sessionName],
      });
      events = await this.runControlCommand({
        args: newArgs,
        cwd,
        fallbackCode: 'ACP_SESSION_INIT_FAILED',
      });
      ensuredEvent = this.findSessionEvent(events);
    }

    if (!ensuredEvent) {
      throw new AcpRuntimeError(
        'ACP_SESSION_INIT_FAILED',
        `ACP session init failed: no session identifiers returned for ${sessionName}.`,
      );
    }

    const acpxRecordId = asOptionalString(ensuredEvent.acpxRecordId);
    const agentSessionId = asOptionalString(ensuredEvent.agentSessionId);
    const backendSessionId = asOptionalString(ensuredEvent.acpxSessionId);

    return {
      sessionKey: input.sessionKey,
      runtimeSessionName: encodeHandleState({
        name: sessionName,
        agent,
        cwd,
        mode: input.mode,
        ...(acpxRecordId ? { acpxRecordId } : {}),
        ...(backendSessionId ? { backendSessionId } : {}),
        ...(agentSessionId ? { agentSessionId } : {}),
      }),
      cwd,
      ...(acpxRecordId ? { acpxRecordId } : {}),
      ...(backendSessionId ? { backendSessionId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
    };
  }

  /** Run a prompt turn against an existing session, streaming events. */
  async *runTurn(input: AcpTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = this.resolveHandleState(input.handle);
    const args = this.buildPromptArgs({
      agent: state.agent,
      sessionName: state.name,
      cwd: state.cwd,
    });

    const cancelOnAbort = async (): Promise<void> => {
      await this.cancel({ handle: input.handle, reason: 'abort-signal' }).catch(() => {});
    };
    const onAbort = (): void => { void cancelOnAbort(); };

    if (input.signal?.aborted) {
      await cancelOnAbort();
      return;
    }
    if (input.signal) {
      input.signal.addEventListener('abort', onAbort, { once: true });
    }

    const child = spawnAcpx({
      command: this.resolvedCommand,
      args,
      cwd: state.cwd,
      stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE when child exits before stdin flush
    });
    child.stdin.end(input.text);

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    let sawDone = false;
    let sawError = false;
    const lines = createInterface({ input: child.stdout });

    try {
      for await (const line of lines) {
        const parsed = parsePromptEventLine(line);
        if (!parsed) continue;
        if (parsed.type === 'done') {
          if (sawDone) continue;
          sawDone = true;
        }
        if (parsed.type === 'error') sawError = true;
        yield parsed;
      }

      const exit = await waitForExit(child);
      if (exit.error) {
        const spawnFailure = resolveSpawnFailure(exit.error, state.cwd);
        if (spawnFailure === 'missing-command') {
          this.healthy = false;
          throw new AcpRuntimeError(
            'ACP_BACKEND_UNAVAILABLE',
            `acpx command not found: ${this.resolvedCommand}`,
            { cause: exit.error },
          );
        }
        if (spawnFailure === 'missing-cwd') {
          throw new AcpRuntimeError(
            'ACP_TURN_FAILED',
            `ACP runtime working directory does not exist: ${state.cwd}`,
            { cause: exit.error },
          );
        }
        throw new AcpRuntimeError('ACP_TURN_FAILED', exit.error.message, { cause: exit.error });
      }

      if ((exit.code ?? 0) !== 0 && !sawError) {
        yield {
          type: 'error',
          message: formatAcpxExitMessage({ stderr, exitCode: exit.code }),
        };
        return;
      }

      if (!sawDone && !sawError) {
        yield { type: 'done' };
      }
    } finally {
      lines.close();
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /** Cancel a running session turn. */
  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const args = this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ['cancel', '--session', state.name],
    });
    await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: 'ACP_TURN_FAILED',
      ignoreNoSession: true,
    });
  }

  /** Close (destroy) a session. */
  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const state = this.resolveHandleState(input.handle);
    const args = this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ['sessions', 'close', state.name],
    });
    await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: 'ACP_TURN_FAILED',
      ignoreNoSession: true,
    });
  }

  /** Get the status of a session. */
  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    const state = this.resolveHandleState(input.handle);
    const args = this.buildVerbArgs({
      agent: state.agent,
      cwd: state.cwd,
      command: ['status', '--session', state.name],
    });
    const events = await this.runControlCommand({
      args,
      cwd: state.cwd,
      fallbackCode: 'ACP_TURN_FAILED',
      ignoreNoSession: true,
      signal: input.signal,
    });

    const detail = events.find((event) => !toAcpxErrorEvent(event)) ?? events[0];
    if (!detail) {
      return { summary: 'acpx status unavailable' };
    }

    const status = asTrimmedString(detail.status) || 'unknown';
    const acpxRecordId = asOptionalString(detail.acpxRecordId);
    const acpxSessionId = asOptionalString(detail.acpxSessionId);
    const agentSessionId = asOptionalString(detail.agentSessionId);
    const pid = typeof detail.pid === 'number' && Number.isFinite(detail.pid) ? detail.pid : null;

    const summary = [
      `status=${status}`,
      acpxRecordId ? `acpxRecordId=${acpxRecordId}` : null,
      acpxSessionId ? `acpxSessionId=${acpxSessionId}` : null,
      pid != null ? `pid=${pid}` : null,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      summary,
      ...(acpxRecordId ? { acpxRecordId } : {}),
      ...(acpxSessionId ? { backendSessionId: acpxSessionId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
      details: detail,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────

  private resolveHandleState(handle: AcpRuntimeHandle): AcpxHandleState {
    const decoded = decodeHandleState(handle.runtimeSessionName);
    if (decoded) return decoded;

    const legacyName = asTrimmedString(handle.runtimeSessionName);
    if (!legacyName) {
      throw new AcpRuntimeError(
        'ACP_SESSION_INIT_FAILED',
        'Invalid acpx runtime handle: runtimeSessionName is missing.',
      );
    }

    return {
      name: legacyName,
      agent: this.config.defaultAgent,
      cwd: this.config.cwd,
      mode: 'persistent',
    };
  }

  private buildPromptArgs(params: {
    agent: string;
    sessionName: string;
    cwd: string;
  }): string[] {
    const prefix = [
      '--format', 'json',
      '--json-strict',
      '--cwd', params.cwd,
      ...buildPermissionArgs(this.config.permissionMode),
      '--non-interactive-permissions', this.config.nonInteractivePermissions,
    ];
    if (this.config.timeoutSeconds) {
      prefix.push('--timeout', String(this.config.timeoutSeconds));
    }
    return [
      ...prefix,
      params.agent,
      'prompt', '--session', params.sessionName, '--file', '-',
    ];
  }

  private buildVerbArgs(params: {
    agent: string;
    cwd: string;
    command: string[];
    prefix?: string[];
  }): string[] {
    const prefix = params.prefix ?? ['--format', 'json', '--json-strict', '--cwd', params.cwd];
    return [...prefix, params.agent, ...params.command];
  }

  private findSessionEvent(events: AcpxJsonObject[]): AcpxJsonObject | undefined {
    return events.find(
      (event) =>
        asOptionalString(event.agentSessionId) ||
        asOptionalString(event.acpxSessionId) ||
        asOptionalString(event.acpxRecordId),
    );
  }

  private async runControlCommand(params: {
    args: string[];
    cwd: string;
    fallbackCode: AcpRuntimeErrorCode;
    ignoreNoSession?: boolean;
    signal?: AbortSignal;
  }): Promise<AcpxJsonObject[]> {
    const result = await spawnAndCollect({
      command: this.resolvedCommand,
      args: params.args,
      cwd: params.cwd,
      stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
      signal: params.signal,
    });

    if (result.error) {
      const spawnFailure = resolveSpawnFailure(result.error, params.cwd);
      if (spawnFailure === 'missing-command') {
        this.healthy = false;
        throw new AcpRuntimeError(
          'ACP_BACKEND_UNAVAILABLE',
          `acpx command not found: ${this.resolvedCommand}`,
          { cause: result.error },
        );
      }
      if (spawnFailure === 'missing-cwd') {
        throw new AcpRuntimeError(
          params.fallbackCode,
          `ACP runtime working directory does not exist: ${params.cwd}`,
          { cause: result.error },
        );
      }
      throw new AcpRuntimeError(params.fallbackCode, result.error.message, { cause: result.error });
    }

    const events = parseJsonLines(result.stdout);
    const errorEvent = events.map((event) => toAcpxErrorEvent(event)).find(Boolean) ?? null;
    if (errorEvent) {
      if (params.ignoreNoSession && errorEvent.code === 'NO_SESSION') {
        return events;
      }
      throw new AcpRuntimeError(
        params.fallbackCode,
        errorEvent.code ? `${errorEvent.code}: ${errorEvent.message}` : errorEvent.message,
      );
    }

    if ((result.code ?? 0) !== 0) {
      throw new AcpRuntimeError(
        params.fallbackCode,
        formatAcpxExitMessage({ stderr: result.stderr, exitCode: result.code }),
      );
    }

    return events;
  }
}

// ─── Formatting ──────────────────────────────────────────────────

function formatAcpxExitMessage(params: {
  stderr: string;
  exitCode: number | null | undefined;
}): string {
  const stderr = params.stderr.trim();
  if (params.exitCode === EXIT_CODE_PERMISSION_DENIED) {
    return [
      stderr || 'Permission denied by ACP runtime (acpx).',
      'ACPX blocked a write/exec permission request in a non-interactive session.',
      'Configure permissionMode to one of: approve-reads, approve-all, deny-all.',
    ].join(' ');
  }
  return stderr || `acpx exited with code ${params.exitCode ?? 'unknown'}`;
}
