import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';

const execFileAsync = promisify(execFile);

export function parseGitHubRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  const direct = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) {
    return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return {
      owner: parts[0],
      repo: parts[1].replace(/\.git$/i, ''),
    };
  } catch {
    return null;
  }
}

async function ghJson(args: string[], cwd: string): Promise<unknown> {
  const { stdout } = await execFileAsync('gh', args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

export function createGitHubTools(): Tool[] {
  const inspectRepo: Tool = {
    name: 'github_repo_inspect',
    description: 'Inspect a GitHub repository using the authenticated gh CLI. Use this for GitHub repo URLs or owner/repo names instead of generic web_fetch. Returns compact repo metadata and top-level tree.',
    group: 'git',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'GitHub repo URL or owner/repo slug',
        },
        includeReadme: {
          type: 'boolean',
          description: 'Whether to include the start of the README',
          default: false,
        },
      },
      required: ['repo'],
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { repo, includeReadme = false } = params as { repo: string; includeReadme?: boolean };
      const parsed = parseGitHubRepo(repo);
      if (!parsed) {
        return { output: '', success: false, error: 'Invalid GitHub repo URL or slug' };
      }

      const cwd = ctx.allowedToolRoot ?? ctx.workDir ?? process.cwd();
      const slug = `${parsed.owner}/${parsed.repo}`;

      try {
        const view = await ghJson([
          'repo', 'view', slug,
          '--json',
          'name,nameWithOwner,description,isPrivate,defaultBranchRef,url,owner,languages',
        ], cwd) as any;

        const branch = view.defaultBranchRef?.name ?? 'HEAD';
        const contents = await ghJson([
          'api',
          `repos/${slug}/contents?ref=${encodeURIComponent(branch)}`,
        ], cwd) as any[];

        let readmeSection: string | null = null;
        if (includeReadme) {
          const readme = await execFileAsync('gh', ['api', `repos/${slug}/readme`, '--jq', '.content'], {
            cwd,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 30_000,
          }).catch(() => null);
          if (readme?.stdout) {
            const decoded = Buffer.from(readme.stdout.trim(), 'base64').toString('utf-8');
            readmeSection = decoded.slice(0, 3000);
          }
        }

        const topLevel = (Array.isArray(contents) ? contents : [])
          .slice(0, 40)
          .map((entry) => `${entry.type === 'dir' ? 'dir' : 'file'}: ${entry.name}`)
          .join('\n');

        const languages = Array.isArray(view.languages?.nodes)
          ? view.languages.nodes.map((node: any) => node.name).join(', ')
          : '';

        const output = [
          `Repo: ${view.nameWithOwner ?? slug}`,
          `URL: ${view.url ?? `https://github.com/${slug}`}`,
          view.description ? `Description: ${view.description}` : null,
          `Private: ${view.isPrivate ? 'yes' : 'no'}`,
          `Default branch: ${branch}`,
          languages ? `Languages: ${languages}` : null,
          '',
          'Top-level tree:',
          topLevel || '(empty)',
          readmeSection ? `\nREADME (start):\n${readmeSection}` : null,
        ].filter(Boolean).join('\n');

        return { output, success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: '', success: false, error: `github_repo_inspect failed: ${msg}` };
      }
    },
  };

  return [inspectRepo];
}
