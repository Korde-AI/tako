import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type PeerTaskApprovalStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'expired';

export interface PeerTaskApproval {
  approvalId: string;
  sessionId: string;
  agentId: string;
  toolName: string;
  toolArgs: unknown;
  toolArgsHash: string;
  channelType?: string;
  channelTarget?: string;
  projectId?: string;
  projectSlug?: string;
  requesterPrincipalId?: string;
  requesterPrincipalName?: string;
  requesterAuthorId?: string;
  requesterAuthorName?: string;
  requesterIsBot?: boolean;
  ownerUserIds: string[];
  ownerPrincipalIds: string[];
  originalUserMessage: string;
  resumePrompt: string;
  status: PeerTaskApprovalStatus;
  createdAt: string;
  updatedAt: string;
  reviewedByPrincipalId?: string;
  reviewedByUserId?: string;
  decisionReason?: string;
}

interface CreatePeerTaskApprovalInput {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolArgs: unknown;
  channelType?: string;
  channelTarget?: string;
  projectId?: string;
  projectSlug?: string;
  requesterPrincipalId?: string;
  requesterPrincipalName?: string;
  requesterAuthorId?: string;
  requesterAuthorName?: string;
  requesterIsBot?: boolean;
  ownerUserIds?: string[];
  ownerPrincipalIds?: string[];
  originalUserMessage: string;
  resumePrompt: string;
}

export class PeerTaskApprovalRegistry {
  private approvals = new Map<string, PeerTaskApproval>();
  private loaded = false;

  constructor(private filePath: string) {}

  async load(): Promise<void> {
    await mkdir(this.parentDir(), { recursive: true });
    const rows = await this.readJsonFile<PeerTaskApproval[]>([]);
    this.approvals = new Map(rows.map((row) => [row.approvalId, row]));
    this.loaded = true;
  }

  list(): PeerTaskApproval[] {
    return Array.from(this.approvals.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(approvalId: string): PeerTaskApproval | null {
    return this.approvals.get(approvalId) ?? null;
  }

  async createOrReuse(input: CreatePeerTaskApprovalInput): Promise<{ approval: PeerTaskApproval; reused: boolean }> {
    await this.ensureLoaded();
    const toolArgsHash = hashToolArgs(input.toolArgs);
    const reusable = this.list().find((row) =>
      row.sessionId === input.sessionId
      && row.agentId === input.agentId
      && row.toolName === input.toolName
      && row.toolArgsHash === toolArgsHash
      && (row.status === 'pending' || row.status === 'approved'),
    );
    if (reusable) {
      return { approval: reusable, reused: true };
    }

    const now = new Date().toISOString();
    const approval: PeerTaskApproval = {
      approvalId: crypto.randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      toolArgsHash,
      channelType: input.channelType,
      channelTarget: input.channelTarget,
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      requesterPrincipalId: input.requesterPrincipalId,
      requesterPrincipalName: input.requesterPrincipalName,
      requesterAuthorId: input.requesterAuthorId,
      requesterAuthorName: input.requesterAuthorName,
      requesterIsBot: input.requesterIsBot,
      ownerUserIds: [...new Set(input.ownerUserIds ?? [])],
      ownerPrincipalIds: [...new Set(input.ownerPrincipalIds ?? [])],
      originalUserMessage: input.originalUserMessage,
      resumePrompt: input.resumePrompt,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.approvals.set(approval.approvalId, approval);
    await this.save();
    return { approval, reused: false };
  }

  async resolve(
    approvalId: string,
    status: 'approved' | 'denied' | 'expired',
    opts?: {
      reviewedByPrincipalId?: string;
      reviewedByUserId?: string;
      decisionReason?: string;
    },
  ): Promise<PeerTaskApproval> {
    await this.ensureLoaded();
    const approval = this.get(approvalId);
    if (!approval) throw new Error(`Peer approval not found: ${approvalId}`);
    const updated: PeerTaskApproval = {
      ...approval,
      status,
      reviewedByPrincipalId: opts?.reviewedByPrincipalId ?? approval.reviewedByPrincipalId,
      reviewedByUserId: opts?.reviewedByUserId ?? approval.reviewedByUserId,
      decisionReason: opts?.decisionReason ?? approval.decisionReason,
      updatedAt: new Date().toISOString(),
    };
    this.approvals.set(updated.approvalId, updated);
    await this.save();
    return updated;
  }

  async consumeApproved(
    sessionId: string,
    agentId: string,
    toolName: string,
    toolArgs: unknown,
  ): Promise<PeerTaskApproval | null> {
    await this.ensureLoaded();
    const toolArgsHash = hashToolArgs(toolArgs);
    const approval = this.list().find((row) =>
      row.sessionId === sessionId
      && row.agentId === agentId
      && row.toolName === toolName
      && row.toolArgsHash === toolArgsHash
      && row.status === 'approved',
    );
    if (!approval) return null;
    const updated: PeerTaskApproval = {
      ...approval,
      status: 'executed',
      updatedAt: new Date().toISOString(),
    };
    this.approvals.set(updated.approvalId, updated);
    await this.save();
    return updated;
  }

  async markExecuted(approvalId: string): Promise<PeerTaskApproval> {
    await this.ensureLoaded();
    const approval = this.get(approvalId);
    if (!approval) throw new Error(`Peer approval not found: ${approvalId}`);
    const updated: PeerTaskApproval = {
      ...approval,
      status: 'executed',
      updatedAt: new Date().toISOString(),
    };
    this.approvals.set(updated.approvalId, updated);
    await this.save();
    return updated;
  }

  async save(): Promise<void> {
    await mkdir(this.parentDir(), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  private parentDir(): string {
    return dirname(this.filePath);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(fallback: T): Promise<T> {
    if (!existsSync(this.filePath)) return fallback;
    return JSON.parse(await readFile(this.filePath, 'utf-8')) as T;
  }
}

export function hashToolArgs(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return '{' + entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',') + '}';
}
