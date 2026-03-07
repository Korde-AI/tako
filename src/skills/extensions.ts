/**
 * Skill extensions — unified subsystem plugin system.
 *
 * Skills can extend Tako by providing implementations of core subsystem
 * interfaces. Each extension type has a convention:
 * - A subdirectory in the skill root (channel/, provider/, memory/, etc.)
 * - An index.ts/js module with a factory function (createChannel, createProvider, etc.)
 * - Configuration via tako.json skillExtensions section
 */

import type { Channel } from '../channels/channel.js';
import type { Provider } from '../providers/provider.js';
import type { MemoryStore } from '../memory/store.js';

// ─── Extension entry ─────────────────────────────────────────────────

/** Metadata about a detected extension within a skill. */
export interface SkillExtensionEntry {
  /** Path to the extension directory */
  dir: string;
  /** Module entry point (absolute path to index.ts/js or <type>.ts/js) */
  entry: string;
  /** Whether this extension is loaded and active */
  loaded?: boolean;
}

/** All extension types a skill can provide. */
export interface SkillExtensions {
  channel?: SkillExtensionEntry;
  provider?: SkillExtensionEntry;
  memory?: SkillExtensionEntry;
  network?: SkillExtensionEntry;
  sandbox?: SkillExtensionEntry;
  auth?: SkillExtensionEntry;
}

// ─── Extension type identifiers ──────────────────────────────────────

/** Extension type identifiers */
export type ExtensionType = 'channel' | 'provider' | 'memory' | 'network' | 'sandbox' | 'auth';

/** All recognized extension subdirectories */
export const EXTENSION_DIRS: ExtensionType[] = [
  'channel', 'provider', 'memory', 'network', 'sandbox', 'auth',
];

// ─── Factory signatures ──────────────────────────────────────────────

/** Factory function signatures for each extension type */
export interface ExtensionFactories {
  channel: (config: Record<string, unknown>) => Channel;
  provider: (config: Record<string, unknown>) => Provider;
  memory: (config: Record<string, unknown>) => MemoryStore;
  network: (config: Record<string, unknown>) => NetworkAdapter;
  sandbox: (config: Record<string, unknown>) => SandboxProvider;
  auth: (config: Record<string, unknown>) => AuthProvider;
}

// ─── Extension interfaces ────────────────────────────────────────────

/** Network adapter interface — for tunnel/exposure skills. */
export interface NetworkAdapter {
  id: string;
  /** Start the tunnel/proxy */
  connect(opts: { port: number; hostname?: string }): Promise<{ url: string }>;
  /** Stop the tunnel/proxy */
  disconnect(): Promise<void>;
  /** Get current status */
  status(): Promise<{ connected: boolean; url?: string }>;
}

/** Sandbox provider interface — for code execution skills. */
export interface SandboxProvider {
  id: string;
  /** Create an isolated execution environment */
  create(opts: { image?: string; timeout?: number }): Promise<string>;
  /** Execute a command in the sandbox */
  exec(sandboxId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Destroy the sandbox */
  destroy(sandboxId: string): Promise<void>;
}

/** Auth provider interface — for authentication skills. */
export interface AuthProvider {
  id: string;
  /** Authenticate a user/request */
  authenticate(credentials: Record<string, unknown>): Promise<{
    valid: boolean;
    userId?: string;
    metadata?: Record<string, unknown>;
  }>;
  /** Check if a token/session is still valid */
  validate(token: string): Promise<boolean>;
}
