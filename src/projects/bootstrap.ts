import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from './types.js';

export async function bootstrapProjectHome(projectsDir: string, project: Project): Promise<string> {
  const projectHome = join(projectsDir, project.projectId);
  await mkdir(join(projectHome, 'sessions'), { recursive: true });
  await mkdir(join(projectHome, 'memory', 'shared'), { recursive: true });
  await mkdir(join(projectHome, 'memory', 'private'), { recursive: true });
  await mkdir(join(projectHome, 'workspace'), { recursive: true });
  await mkdir(join(projectHome, 'artifacts', 'shared'), { recursive: true });
  await mkdir(join(projectHome, 'worktrees'), { recursive: true });
  await mkdir(join(projectHome, 'coordination', 'approvals'), { recursive: true });
  await mkdir(join(projectHome, 'coordination', 'branches'), { recursive: true });
  await mkdir(join(projectHome, 'coordination', 'background'), { recursive: true });
  await mkdir(join(projectHome, 'audit'), { recursive: true });
  await writeFile(join(projectHome, 'project.json'), JSON.stringify(project, null, 2) + '\n', 'utf-8');
  return projectHome;
}
