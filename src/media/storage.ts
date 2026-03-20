/**
 * Media persistence — store inbound media attachments locally.
 *
 * When a message has attachments, downloads and saves them to:
 *   ~/.tako/media/inbound/<uuid>.<ext>
 *
 * Returns a local file path so the agent can access media offline.
 */

import { join, extname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Attachment } from '../channels/channel.js';
import { getRuntimePaths } from '../core/paths.js';

// ─── Paths ──────────────────────────────────────────────────────────

function getInboundDir(): string {
  return join(getRuntimePaths().mediaDir, 'inbound');
}

// ─── Init ───────────────────────────────────────────────────────────

/**
 * Ensure the media inbound directory exists.
 * Call on startup.
 */
export async function initMediaStorage(): Promise<void> {
  await mkdir(getInboundDir(), { recursive: true });
}

// ─── Save ───────────────────────────────────────────────────────────

/**
 * Determine file extension from attachment metadata.
 */
function getExtension(attachment: Attachment): string {
  if (attachment.filename) {
    const ext = extname(attachment.filename);
    if (ext) return ext;
  }
  if (attachment.mimeType) {
    const map: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'audio/mpeg': '.mp3',
      'audio/ogg': '.ogg',
      'video/mp4': '.mp4',
      'application/pdf': '.pdf',
    };
    return map[attachment.mimeType] ?? '.bin';
  }
  return '.bin';
}

/**
 * Download and persist a single attachment.
 * Returns the local file path.
 */
export async function saveAttachment(attachment: Attachment): Promise<string> {
  const id = crypto.randomUUID();
  const ext = getExtension(attachment);
  const filename = `${id}${ext}`;
  const filePath = join(getInboundDir(), filename);

  let data: Buffer;

  if (attachment.data) {
    data = attachment.data;
  } else if (attachment.url) {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
    }
    data = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error('Attachment has neither data nor URL');
  }

  await writeFile(filePath, data);
  console.log(`[media] Saved ${attachment.type} attachment: ${filePath} (${data.length} bytes)`);
  return filePath;
}

/**
 * Save all attachments from a message and return updated attachments
 * with local file paths set as URLs.
 */
export async function persistAttachments(attachments: Attachment[]): Promise<Attachment[]> {
  const result: Attachment[] = [];
  for (const att of attachments) {
    try {
      const localPath = await saveAttachment(att);
      result.push({
        ...att,
        url: localPath,
      });
    } catch (err) {
      console.error('[media] Failed to save attachment:', err instanceof Error ? err.message : err);
      result.push(att); // pass through original on failure
    }
  }
  return result;
}
