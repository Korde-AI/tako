import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectPatchApproval } from './types.js';

export class ProjectApprovalRegistry {
  private approvals = new Map<string, ProjectPatchApproval>();
  private loaded = false;

  constructor(
    private rootDir: string,
    private projectId: string,
  ) {}

  private get approvalsFile(): string {
    return join(this.rootDir, 'approvals.json');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const rows = await this.readJsonFile<ProjectPatchApproval[]>(this.approvalsFile, []);
    this.approvals = new Map(rows.map((row) => [row.approvalId, row]));
    this.loaded = true;
  }

  list(): ProjectPatchApproval[] {
    return Array.from(this.approvals.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listPending(): ProjectPatchApproval[] {
    return this.list().filter((row) => row.status === 'pending');
  }

  get(approvalId: string): ProjectPatchApproval | null {
    return this.approvals.get(approvalId) ?? null;
  }

  findPendingByArtifact(artifactId: string): ProjectPatchApproval | null {
    return this.listPending().find((row) => row.artifactId === artifactId) ?? null;
  }

  async create(input: Omit<ProjectPatchApproval, 'approvalId' | 'projectId' | 'createdAt' | 'updatedAt' | 'status'> & { status?: ProjectPatchApproval['status'] }): Promise<ProjectPatchApproval> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const approval: ProjectPatchApproval = {
      approvalId: crypto.randomUUID(),
      projectId: this.projectId,
      artifactId: input.artifactId,
      artifactName: input.artifactName,
      targetNodeId: input.targetNodeId,
      requestedByNodeId: input.requestedByNodeId,
      requestedByPrincipalId: input.requestedByPrincipalId,
      status: input.status ?? 'pending',
      reason: input.reason,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      conflictSummary: input.conflictSummary,
      createdAt: now,
      updatedAt: now,
      reviewedByPrincipalId: input.reviewedByPrincipalId,
    };
    this.approvals.set(approval.approvalId, approval);
    await this.save();
    return approval;
  }

  async resolve(approvalId: string, status: 'approved' | 'denied', reviewedByPrincipalId?: string, reason?: string): Promise<ProjectPatchApproval> {
    await this.ensureLoaded();
    const approval = this.get(approvalId);
    if (!approval) throw new Error(`Approval not found: ${approvalId}`);
    const updated: ProjectPatchApproval = {
      ...approval,
      status,
      reviewedByPrincipalId,
      reason: reason ?? approval.reason,
      conflictSummary: status === 'denied' ? approval.conflictSummary : undefined,
      updatedAt: new Date().toISOString(),
    };
    this.approvals.set(updated.approvalId, updated);
    await this.save();
    return updated;
  }

  async markConflict(
    approvalId: string,
    summary: string,
    opts?: {
      targetBranch?: string;
      reviewedByPrincipalId?: string;
    },
  ): Promise<ProjectPatchApproval> {
    await this.ensureLoaded();
    const approval = this.get(approvalId);
    if (!approval) throw new Error(`Approval not found: ${approvalId}`);
    const updated: ProjectPatchApproval = {
      ...approval,
      status: 'conflict',
      conflictSummary: summary,
      targetBranch: opts?.targetBranch ?? approval.targetBranch,
      reviewedByPrincipalId: opts?.reviewedByPrincipalId ?? approval.reviewedByPrincipalId,
      updatedAt: new Date().toISOString(),
    };
    this.approvals.set(updated.approvalId, updated);
    await this.save();
    return updated;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.approvalsFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
