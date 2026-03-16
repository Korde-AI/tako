import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectArtifact } from './types.js';
import { ProjectArtifactRegistry } from './artifacts.js';

export interface ProjectArtifactEnvelope {
  artifact: ProjectArtifact;
  contentBase64: string;
}

export async function exportArtifactEnvelope(
  registry: ProjectArtifactRegistry,
  artifactId: string,
): Promise<ProjectArtifactEnvelope> {
  const artifact = registry.get(artifactId);
  if (!artifact) {
    throw new Error(`Artifact not found: ${artifactId}`);
  }
  const contentBase64 = await readFile(registry.resolvePath(artifact), 'base64');
  return { artifact, contentBase64 };
}

export async function importArtifactEnvelope(
  registry: ProjectArtifactRegistry,
  envelope: ProjectArtifactEnvelope,
): Promise<ProjectArtifact> {
  return registry.importShared({
    artifact: envelope.artifact,
    contentBase64: envelope.contentBase64,
  });
}

export async function writeArtifactEnvelopeToPath(
  destinationPath: string,
  envelope: ProjectArtifactEnvelope,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, JSON.stringify(envelope, null, 2) + '\n', 'utf-8');
}
