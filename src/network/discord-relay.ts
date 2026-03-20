import type { ProjectInvite } from './invites.js';

export interface DiscordRelayInviteMessage {
  kind: 'tako_project_invite_v1';
  invite: ProjectInvite;
}

export interface DiscordRelayMessage {
  authorId: string;
  content: string;
  isBot?: boolean;
  timestamp?: string;
}

export function normalizeNodeHint(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^<@!?(\d+)>$/, '$1')
    .replace(/^@/, '')
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\s+/g, ' ');
}

export function matchesNodeHint(hint: string, candidates: Array<string | undefined | null>): boolean {
  const normalizedHint = normalizeNodeHint(hint);
  if (!normalizedHint) return false;
  return candidates.some((candidate) => normalizeNodeHint(candidate) === normalizedHint);
}

export function renderProjectInviteRelay(message: DiscordRelayInviteMessage): string {
  return [
    '📨 Tako Project Invite',
    'Use the receiving agent in this channel to accept this invite.',
    '```json',
    JSON.stringify(message, null, 2),
    '```',
  ].join('\n');
}

export function parseProjectInviteRelay(content: string): DiscordRelayInviteMessage | null {
  const match = content.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as DiscordRelayInviteMessage;
    if (parsed?.kind !== 'tako_project_invite_v1' || !parsed.invite?.inviteId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function selectLatestMatchingRelayInvite(
  messages: DiscordRelayMessage[],
  predicate: (message: DiscordRelayInviteMessage) => boolean,
): DiscordRelayInviteMessage | null {
  const parsed = messages
    .map((message) => ({
      parsed: parseProjectInviteRelay(message.content),
      timestamp: message.timestamp ?? '',
    }))
    .filter((entry): entry is { parsed: DiscordRelayInviteMessage; timestamp: string } => !!entry.parsed)
    .filter((entry) => predicate(entry.parsed))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return parsed[0]?.parsed ?? null;
}
