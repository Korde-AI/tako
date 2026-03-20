import { normalize, resolve } from 'node:path';
import type { TakoPaths } from '../core/paths.js';
import type { ExecutionContext } from '../core/execution-context.js';
import type { Project } from './types.js';

export function getProjectHome(paths: TakoPaths, projectId: string): string {
  return joinNormalized(paths.projectsDir, projectId);
}

export function defaultProjectWorkspaceRoot(paths: TakoPaths, projectId: string): string {
  return joinNormalized(getProjectHome(paths, projectId), 'workspace');
}

export function defaultProjectWorkspaceRootBySlug(workspaceRoot: string, projectSlug: string): string {
  return joinNormalized(workspaceRoot, 'projects', projectSlug);
}

export function defaultProjectArtifactsRoot(paths: TakoPaths, projectId: string): string {
  return joinNormalized(getProjectHome(paths, projectId), 'artifacts', 'shared');
}

export function defaultProjectWorktreeRoot(paths: TakoPaths, projectId: string, nodeId: string): string {
  return joinNormalized(getProjectHome(paths, projectId), 'worktrees', nodeId);
}

export function defaultProjectWorktreeRootForProject(project: Project, paths: TakoPaths, nodeId: string): string {
  return joinNormalized(resolveProjectRoot(paths, project), 'worktrees', nodeId);
}

export function projectCoordinationRoot(paths: TakoPaths, projectId: string): string {
  return joinNormalized(getProjectHome(paths, projectId), 'coordination');
}

export function projectApprovalsRoot(paths: TakoPaths, projectId: string): string {
  return joinNormalized(projectCoordinationRoot(paths, projectId), 'approvals');
}

export function projectBranchesRoot(paths: TakoPaths, projectId: string): string {
  return joinNormalized(projectCoordinationRoot(paths, projectId), 'branches');
}

export function projectBackgroundRoot(paths: TakoPaths, projectId: string): string {
  return joinNormalized(projectCoordinationRoot(paths, projectId), 'background');
}

export function resolveProjectRoot(paths: TakoPaths, project: Project): string {
  if (project.workspaceRoot) {
    return normalize(resolve(project.workspaceRoot));
  }
  return defaultProjectWorkspaceRoot(paths, project.projectId);
}

export function resolveAllowedToolRoot(
  ctx: ExecutionContext,
  fallbackWorkspaceRoot: string,
): string {
  return ctx.allowedToolRoot ?? ctx.projectRoot ?? ctx.workspaceRoot ?? fallbackWorkspaceRoot;
}

function joinNormalized(...parts: string[]): string {
  return normalize(resolve(...parts));
}
