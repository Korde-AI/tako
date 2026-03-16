import { join, resolve } from 'node:path';
import type { TakoPaths } from '../core/paths.js';
import type { ExecutionContext } from '../core/execution-context.js';

export type MemoryScope = 'global-private' | 'project-shared' | 'project-private';

export interface ResolvedMemoryScope {
  scope: MemoryScope;
  root: string;
}

export interface VisibleMemoryScopes {
  readable: ResolvedMemoryScope[];
  writable: ResolvedMemoryScope[];
}

export function isProjectContext(ctx: ExecutionContext): boolean {
  return Boolean(ctx.projectId);
}

export function isSharedSessionContext(ctx: ExecutionContext): boolean {
  return Boolean(ctx.sharedSessionId);
}

export function getGlobalPrivateMemoryDir(workspaceRoot: string): string {
  return join(workspaceRoot, 'memory');
}

export function getProjectSharedMemoryDir(paths: TakoPaths, projectId: string): string {
  return join(paths.projectsDir, projectId, 'memory', 'shared');
}

export function getProjectPrivateMemoryDir(paths: TakoPaths, projectId: string, principalId: string): string {
  return join(paths.projectsDir, projectId, 'memory', 'private', principalId);
}

export function resolveVisibleMemoryScopes(
  paths: TakoPaths,
  workspaceRoot: string,
  ctx: ExecutionContext,
): VisibleMemoryScopes {
  const readable: ResolvedMemoryScope[] = [];
  const writable: ResolvedMemoryScope[] = [];

  const globalPrivate: ResolvedMemoryScope = {
    scope: 'global-private',
    root: getGlobalPrivateMemoryDir(workspaceRoot),
  };

  if (!ctx.projectId) {
    readable.push(globalPrivate);
    writable.push(globalPrivate);
    return { readable, writable };
  }

  readable.push({
    scope: 'project-shared',
    root: getProjectSharedMemoryDir(paths, ctx.projectId),
  });

  if (ctx.principalId) {
    const privateScope: ResolvedMemoryScope = {
      scope: 'project-private',
      root: getProjectPrivateMemoryDir(paths, ctx.projectId, ctx.principalId),
    };
    readable.push(privateScope);
    writable.push(privateScope);
  }

  writable.push({
    scope: 'project-shared',
    root: getProjectSharedMemoryDir(paths, ctx.projectId),
  });

  return { readable, writable };
}

export function getDefaultMemoryWriteScope(ctx: ExecutionContext): MemoryScope {
  return ctx.projectId ? 'project-private' : 'global-private';
}

export function resolveWritableMemoryScope(
  paths: TakoPaths,
  workspaceRoot: string,
  ctx: ExecutionContext,
  scope: MemoryScope,
): ResolvedMemoryScope | null {
  if (scope === 'global-private') {
    return {
      scope,
      root: getGlobalPrivateMemoryDir(workspaceRoot),
    };
  }
  if (!ctx.projectId) return null;
  if (scope === 'project-shared') {
    return {
      scope,
      root: getProjectSharedMemoryDir(paths, ctx.projectId),
    };
  }
  if (scope === 'project-private' && ctx.principalId) {
    return {
      scope,
      root: getProjectPrivateMemoryDir(paths, ctx.projectId, ctx.principalId),
    };
  }
  return null;
}

export function resolveScopedPath(root: string, relativePath: string): string {
  return resolve(root, relativePath);
}

