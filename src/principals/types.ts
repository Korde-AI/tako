export type PrincipalType = 'human' | 'local-agent' | 'remote-agent' | 'system';
export type PrincipalAuthorityLevel = 'owner' | 'admin' | 'member' | 'guest';
export type PrincipalPlatform = 'discord' | 'telegram' | 'cli' | 'web' | 'system';

export interface Principal {
  principalId: string;
  type: PrincipalType;
  displayName: string;
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  authorityLevel?: PrincipalAuthorityLevel;
  metadata?: Record<string, unknown>;
}

export interface PrincipalPlatformMapping {
  principalId: string;
  platform: PrincipalPlatform;
  platformUserId: string;
  username?: string;
  displayName?: string;
  linkedAt: string;
  lastSeenAt?: string;
}
