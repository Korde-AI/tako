import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolContext } from './tool.js';

export function getAllowedToolRoot(ctx: ToolContext): string {
  return ctx.allowedToolRoot
    ?? ctx.executionContext?.allowedToolRoot
    ?? ctx.executionContext?.projectRoot
    ?? ctx.workDir
    ?? ctx.workspaceRoot;
}

export function resolvePathWithinAllowedRoot(ctx: ToolContext, inputPath: string): {
  ok: true;
  fullPath: string;
  allowedRoot: string;
} | {
  ok: false;
  error: string;
  allowedRoot: string;
} {
  const allowedRoot = getAllowedToolRoot(ctx);
  const fullPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(allowedRoot, inputPath);
  const rel = relative(allowedRoot, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      error: `Path ${inputPath} resolves outside allowed root ${allowedRoot}`,
      allowedRoot,
    };
  }
  return { ok: true, fullPath, allowedRoot };
}

export function resolveSubdirWithinAllowedRoot(ctx: ToolContext, inputPath?: string): {
  ok: true;
  fullPath: string;
  allowedRoot: string;
} | {
  ok: false;
  error: string;
  allowedRoot: string;
} {
  return resolvePathWithinAllowedRoot(ctx, inputPath ?? '.');
}
