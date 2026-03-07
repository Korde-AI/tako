/**
 * Execution tools — exec, process.
 * Kernel tools (always available).
 *
 * Now integrates ExecSafety for command validation, dangerous command
 * detection, timeout enforcement, and output size limits.
 */

import { exec as execCb, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import { ExecSafety, type ExecSafetyOptions } from './exec-safety.js';
import { ExecApprovalManager, type ApprovalConfig } from '../core/exec-approvals.js';
import type { CacheManager } from '../cache/manager.js';

const execAsync = promisify(execCb);

// ─── Shared exec safety instance ─────────────────────────────────────

let execSafety: ExecSafety | null = null;
let approvalManager: ExecApprovalManager | null = null;
let cacheManager: CacheManager | null = null;

/** Wire the cache manager into exec tools. */
export function setExecCacheManager(manager: CacheManager): void {
  cacheManager = manager;
}

/** Configure the shared ExecSafety instance. */
export function configureExecSafety(options: ExecSafetyOptions): void {
  execSafety = new ExecSafety(options);
}

/** Configure the shared ExecApprovalManager instance. */
export function configureExecApprovals(config: Partial<ApprovalConfig>): void {
  approvalManager = new ExecApprovalManager(config);
}

/** Get the shared approval manager (if configured). */
export function getApprovalManager(): ExecApprovalManager | null {
  return approvalManager;
}

/** Get or create the ExecSafety instance. */
function getExecSafety(): ExecSafety {
  if (!execSafety) {
    execSafety = new ExecSafety();
  }
  return execSafety;
}

// ─── exec ───────────────────────────────────────────────────────────

interface ExecParams {
  command: string;
  timeout?: number;
}

export const execTool: Tool = {
  name: 'exec',
  description: 'Execute a shell command and return its output. Commands are validated for safety before execution.',
  group: 'runtime',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command, timeout } = params as ExecParams;
    const safety = getExecSafety();

    // Update safety with current context
    if (ctx.workspaceRoot) safety.setWorkspaceRoot(ctx.workspaceRoot);
    if (ctx.workDir) safety.setWorkDir(ctx.workDir);

    // Check exec approvals before safety validation
    if (approvalManager) {
      const approvalReq = approvalManager.checkCommand(command, ctx.sessionId);
      if (approvalReq) {
        if (approvalReq.status === 'denied' || approvalReq.riskLevel === 'blocked') {
          return {
            output: `Command blocked: ${approvalReq.reason}`,
            success: false,
            error: approvalReq.reason,
          };
        }
        if (approvalReq.status === 'pending') {
          return {
            output: approvalManager.formatRequest(approvalReq),
            success: false,
            error: 'Awaiting user approval',
            data: { approvalRequest: approvalReq },
          };
        }
      }
    }

    // Validate the command
    const validation = safety.validate(command, timeout);

    if (!validation.allowed) {
      return {
        output: `Command blocked: ${validation.blockReason}`,
        success: false,
        error: validation.blockReason,
      };
    }

    // Include warnings in the output prefix
    let warningPrefix = '';
    if (validation.warnings.length > 0) {
      warningPrefix = validation.warnings.join('\n') + '\n---\n';
    }

    // Check tool cache for deterministic commands
    if (cacheManager) {
      const cached = cacheManager.tool.get(command, ctx.workDir);
      if (cached !== null) {
        return { output: warningPrefix + cached.output, success: cached.success };
      }
    }

    try {
      const { stdout, stderr } = await execAsync(validation.command, {
        cwd: ctx.workDir,
        timeout: validation.timeout,
        maxBuffer: validation.maxOutputSize,
      });
      const output = [stdout, stderr].filter(Boolean).join('\n');
      // Truncate output if it exceeds max size
      const truncated = output.length > validation.maxOutputSize
        ? output.slice(0, validation.maxOutputSize) + '\n[... output truncated]'
        : output;

      // Cache the result for future calls
      cacheManager?.tool.set(command, ctx.workDir, truncated, true);

      return { output: warningPrefix + truncated, success: true };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join('\n');
      return { output: warningPrefix + output, success: false, error: e.message };
    }
  },
};

// ─── process ────────────────────────────────────────────────────────

/** Active background processes tracked by the process tool. */
const activeProcesses = new Map<string, ChildProcess>();

interface ProcessParams {
  action: 'start' | 'stop' | 'list';
  command?: string;
  id?: string;
}

export const processTool: Tool = {
  name: 'process',
  description: 'Manage background processes (start, stop, list). Start commands are validated for safety.',
  group: 'runtime',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'Action to perform' },
      command: { type: 'string', description: 'Command to start (for "start" action)' },
      id: { type: 'string', description: 'Process ID (for "stop" action)' },
    },
    required: ['action'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { action, command, id } = params as ProcessParams;

    switch (action) {
      case 'start': {
        if (!command) return { output: '', success: false, error: 'command required for start' };

        // Validate the command before starting
        const safety = getExecSafety();
        const validation = safety.validate(command);
        if (!validation.allowed) {
          return {
            output: `Command blocked: ${validation.blockReason}`,
            success: false,
            error: validation.blockReason,
          };
        }

        const procId = crypto.randomUUID().slice(0, 8);
        const child = spawn('sh', ['-c', command], {
          cwd: ctx.workDir,
          stdio: 'pipe',
          detached: true,
        });
        activeProcesses.set(procId, child);
        child.on('exit', () => activeProcesses.delete(procId));

        let warningNote = '';
        if (validation.warnings.length > 0) {
          warningNote = ` (warnings: ${validation.warnings.join('; ')})`;
        }
        return { output: `Started process ${procId}: ${command}${warningNote}`, success: true };
      }
      case 'stop': {
        if (!id) return { output: '', success: false, error: 'id required for stop' };
        const proc = activeProcesses.get(id);
        if (!proc) return { output: '', success: false, error: `Process ${id} not found` };
        proc.kill();
        activeProcesses.delete(id);
        return { output: `Stopped process ${id}`, success: true };
      }
      case 'list': {
        const list = Array.from(activeProcesses.entries()).map(
          ([pid, child]) => `${pid}: pid=${child.pid}`,
        );
        return { output: list.join('\n') || '(no active processes)', success: true };
      }
      default:
        return { output: '', success: false, error: `Unknown action: ${action}` };
    }
  },
};

/** All execution tools. */
export const execTools: Tool[] = [execTool, processTool];
