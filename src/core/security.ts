/**
 * Security middleware — unified access point for all security modules.
 *
 * Initializes and provides access to:
 * - SecretScanner (output scanning)
 * - RateLimiter (request throttling)
 * - InputSanitizer (prompt injection detection)
 * - ToolValidator (argument validation)
 * - NetworkPolicy (URL/domain control)
 *
 * This module is the single integration point. Other modules import
 * from here rather than from individual security modules.
 */

import { SecretScanner, type SecretScannerConfig } from './secret-scanner.js';
import { RateLimiter } from './rate-limiter.js';
import { InputSanitizer, type SanitizerConfig } from './sanitizer.js';
import { ToolValidator, type ToolValidatorConfig } from './tool-validator.js';
import { NetworkPolicy, type NetworkPolicyConfig } from './network-policy.js';
import type { SecurityConfig } from '../config/schema.js';

// ─── Singleton instances ────────────────────────────────────────────

let secretScanner: SecretScanner | null = null;
let rateLimiter: RateLimiter | null = null;
let inputSanitizer: InputSanitizer | null = null;
let toolValidator: ToolValidator | null = null;
let networkPolicy: NetworkPolicy | null = null;

/**
 * Initialize all security modules from config.
 */
export function initSecurity(config: SecurityConfig, workspaceRoot: string): void {
  secretScanner = new SecretScanner({
    enabled: config.secretScanning.enabled,
    action: config.secretScanning.action,
  });

  rateLimiter = new RateLimiter({
    ...config.rateLimits,
  });

  inputSanitizer = new InputSanitizer({
    enabled: config.sanitizer.enabled,
    mode: config.sanitizer.mode,
  });

  toolValidator = new ToolValidator(
    { level: config.toolValidation.level },
    workspaceRoot,
  );

  networkPolicy = new NetworkPolicy({
    mode: config.network.mode,
    allowlist: config.network.allowlist,
    blocklist: config.network.blocklist,
  });
}

/** Get the secret scanner instance. */
export function getSecretScanner(): SecretScanner | null {
  return secretScanner;
}

/** Get the rate limiter instance. */
export function getRateLimiter(): RateLimiter | null {
  return rateLimiter;
}

/** Get the input sanitizer instance. */
export function getInputSanitizer(): InputSanitizer | null {
  return inputSanitizer;
}

/** Get the tool validator instance. */
export function getToolValidator(): ToolValidator | null {
  return toolValidator;
}

/** Get the network policy instance. */
export function getNetworkPolicy(): NetworkPolicy | null {
  return networkPolicy;
}

/**
 * Scan and redact secrets from outgoing text.
 * Returns the (possibly redacted) text.
 */
export function scanSecrets(text: string): string {
  if (!secretScanner) return text;
  const result = secretScanner.scan(text);
  if (result.hasSecrets && result.detections.length > 0) {
    console.warn(`[security] Detected ${result.detections.length} secret(s) in output: ${result.detections.map((d) => d.type).join(', ')}`);
  }
  return result.text;
}

/**
 * Check rate limit for a user/channel pair.
 * Returns null if allowed, or an error message if limited.
 */
export function checkRateLimit(userId: string, channelId: string): string | null {
  if (!rateLimiter) return null;
  const result = rateLimiter.check(userId, channelId);
  if (!result.allowed) {
    return `Rate limited (${result.limitType}). Try again in ${result.retryAfterSeconds}s.`;
  }
  return null;
}

/**
 * Sanitize user input for prompt injection.
 * Returns the sanitized text, or null if blocked.
 */
export function sanitizeInput(text: string): { text: string; blocked: boolean; warnings: string[] } {
  if (!inputSanitizer) return { text, blocked: false, warnings: [] };
  const result = inputSanitizer.sanitize(text);
  const warnings = result.detections.map((d) => `[${d.severity}] ${d.pattern}`);
  if (result.flagged) {
    console.warn(`[security] Input sanitizer flagged: ${warnings.join(', ')}`);
  }
  return { text: result.text, blocked: result.blocked, warnings };
}

/**
 * Check if a URL is allowed by network policy.
 * Returns null if allowed, or an error message if blocked.
 */
export function checkNetworkPolicy(url: string): string | null {
  if (!networkPolicy) return null;
  const result = networkPolicy.check(url);
  if (!result.allowed) {
    return result.reason ?? 'Blocked by network policy';
  }
  return null;
}
