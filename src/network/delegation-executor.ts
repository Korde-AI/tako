import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DelegationRequest, DelegationResult } from './delegation.js';
import type { ExecutionContext } from '../core/execution-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class DelegationExecutor {
  async execute(request: DelegationRequest, ctx: ExecutionContext): Promise<DelegationResult> {
    try {
      let summary = '';
      switch (request.capabilityId) {
        case 'summarize_workspace':
          summary = await this.summarizeWorkspace(ctx);
          break;
        case 'inspect_logs':
          summary = await this.inspectLogs(ctx);
          break;
        case 'review_patch':
          summary = this.reviewPatch(request);
          break;
        case 'run_tests':
          summary = await this.runTests(ctx);
          break;
        default:
          return this.result(request, 'denied', `Unsupported capability: ${request.capabilityId}`, undefined, `unsupported capability ${request.capabilityId}`);
      }
      return this.result(request, 'ok', summary);
    } catch (err) {
      return this.result(
        request,
        'failed',
        `Delegation ${request.capabilityId} failed`,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async summarizeWorkspace(ctx: ExecutionContext): Promise<string> {
    const root = ctx.projectRoot ?? ctx.allowedToolRoot ?? ctx.workspaceRoot;
    if (!root) return 'No project root available.';
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries.slice(0, 12).map((entry) => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`);
    return `Workspace ${root} has ${entries.length} top-level entries. Sample: ${names.join(', ') || 'empty'}`;
  }

  private async inspectLogs(ctx: ExecutionContext): Promise<string> {
    const root = ctx.home;
    const auditPath = join(root, 'audit', 'audit.jsonl');
    try {
      const raw = await readFile(auditPath, 'utf-8');
      const lines = raw.trim().split('\n').slice(-5);
      return lines.length > 0 ? `Recent audit lines: ${lines.join(' | ')}` : 'No audit log entries.';
    } catch {
      return 'No audit log found.';
    }
  }

  private reviewPatch(request: DelegationRequest): string {
    const prompt = request.input.prompt?.trim();
    if (!prompt) return 'No patch or prompt supplied for review.';
    const excerpt = prompt.length > 600 ? `${prompt.slice(0, 600)}...` : prompt;
    return `Remote review received. Input excerpt: ${excerpt}`;
  }

  private async runTests(ctx: ExecutionContext): Promise<string> {
    const root = ctx.projectRoot ?? ctx.allowedToolRoot ?? ctx.workspaceRoot;
    if (!root) return 'No project root available for tests.';
    try {
      const { stdout, stderr } = await execFileAsync('npm', ['test', '--', '--runInBand'], { cwd: root, timeout: 120000 });
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      return output ? output.slice(0, 1200) : 'Tests completed without output.';
    } catch (err) {
      const output = err && typeof err === 'object' && 'stdout' in err
        ? `${String((err as any).stdout ?? '')}\n${String((err as any).stderr ?? '')}`.trim()
        : '';
      if (output) return output.slice(0, 1200);
      throw err;
    }
  }

  private result(
    request: DelegationRequest,
    status: DelegationResult['status'],
    summary: string,
    artifacts?: DelegationResult['artifacts'],
    error?: string,
  ): DelegationResult {
    return {
      requestId: request.requestId,
      projectId: request.projectId,
      fromNodeId: request.fromNodeId,
      toNodeId: request.toNodeId,
      status,
      summary,
      artifacts,
      error,
      createdAt: new Date().toISOString(),
    };
  }
}
