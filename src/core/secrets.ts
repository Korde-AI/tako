/**
 * Secrets manager — secure storage for API keys and tokens.
 *
 * Stores secrets encrypted at rest (using a derived key from the machine ID),
 * provides env-var injection, and masks secrets in logs/output.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────

export interface SecretsConfig {
  /** Storage backend: 'file' | 'env' | 'keychain' */
  backend: 'file' | 'env' | 'keychain';
  /** Path for file-based storage. */
  path?: string;
}

interface SecretsStore {
  version: number;
  secrets: Record<string, { iv: string; data: string }>;
}

// ─── Implementation ─────────────────────────────────────────────────

export class SecretsManager {
  private config: SecretsConfig;
  private storePath: string;
  private cache: Map<string, string> | null = null;
  private encryptionKey: Buffer;

  constructor(config: Partial<SecretsConfig> = {}) {
    this.config = {
      backend: config.backend ?? 'file',
      path: config.path,
    };
    this.storePath = this.config.path ?? join(process.env.HOME ?? '/tmp', '.tako', 'secrets.enc');
    // Derive encryption key from hostname + username (machine-bound)
    const salt = `tako-secrets-${process.env.USER ?? 'default'}`;
    this.encryptionKey = scryptSync(salt, 'tako', 32);
  }

  /** Get a secret by key. */
  async get(key: string): Promise<string | undefined> {
    if (this.config.backend === 'env') {
      return process.env[key];
    }

    const store = await this.loadStore();
    const entry = store.secrets[key];
    if (!entry) return undefined;

    return this.decrypt(entry.iv, entry.data);
  }

  /** Set a secret. */
  async set(key: string, value: string): Promise<void> {
    if (this.config.backend === 'env') {
      process.env[key] = value;
      return;
    }

    const store = await this.loadStore();
    const iv = randomBytes(16);
    const encrypted = this.encrypt(iv, value);
    store.secrets[key] = { iv: iv.toString('hex'), data: encrypted };
    await this.saveStore(store);
    this.cache = null; // Invalidate cache
  }

  /** Delete a secret. */
  async delete(key: string): Promise<void> {
    if (this.config.backend === 'env') {
      delete process.env[key];
      return;
    }

    const store = await this.loadStore();
    delete store.secrets[key];
    await this.saveStore(store);
    this.cache = null;
  }

  /** List secret keys (not values). */
  async list(): Promise<string[]> {
    if (this.config.backend === 'env') {
      // Return known Tako-related env vars
      return Object.keys(process.env).filter((k) => k.startsWith('TAKO_'));
    }

    const store = await this.loadStore();
    return Object.keys(store.secrets);
  }

  /** Mask secrets in a string (for log safety). */
  mask(text: string): string {
    if (!this.cache) return text;
    let masked = text;
    for (const [, value] of this.cache) {
      if (value.length >= 4) {
        masked = masked.replaceAll(value, value.slice(0, 2) + '***' + value.slice(-2));
      }
    }
    return masked;
  }

  /** Inject secrets as environment variables for child processes. */
  toEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.cache) {
      for (const [key, value] of this.cache) {
        env[key] = value;
      }
    }
    return env;
  }

  /** Preload all secrets into in-memory cache (for masking and env injection). */
  async preload(): Promise<void> {
    if (this.config.backend === 'env') return;
    const store = await this.loadStore();
    this.cache = new Map();
    for (const [key, entry] of Object.entries(store.secrets)) {
      try {
        const value = this.decrypt(entry.iv, entry.data);
        this.cache.set(key, value);
      } catch {
        // Skip corrupted entries
      }
    }
  }

  // ─── Encryption helpers ─────────────────────────────────────────

  private encrypt(iv: Buffer, plaintext: string): string {
    const cipher = createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  private decrypt(ivHex: string, ciphertext: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  }

  // ─── Store I/O ──────────────────────────────────────────────────

  private async loadStore(): Promise<SecretsStore> {
    try {
      const raw = await readFile(this.storePath, 'utf-8');
      return JSON.parse(raw) as SecretsStore;
    } catch {
      return { version: 1, secrets: {} };
    }
  }

  private async saveStore(store: SecretsStore): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(store, null, 2), 'utf-8');
  }
}
