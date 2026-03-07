/**
 * Doctor — kernel health checker and repair tool.
 *
 * Runs a series of health checks and optionally auto-repairs issues.
 *
 * Usage:
 *   tako doctor          # Interactive health check
 *   tako doctor --yes    # Auto-accept repairs
 *   tako doctor --deep   # Full system scan
 */

import type { TakoConfig } from '../config/schema.js';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  repairable: boolean;
}

export type HealthCheck = (config: TakoConfig) => Promise<CheckResult>;

export interface DoctorOpts {
  /** Auto-accept repairs */
  autoRepair: boolean;
  /** Run deep/comprehensive checks */
  deep: boolean;
}

export class Doctor {
  private checks: HealthCheck[] = [];

  /** Register a health check. */
  addCheck(check: HealthCheck): void {
    this.checks.push(check);
  }

  /** Run all health checks. */
  async run(config: TakoConfig, opts?: Partial<DoctorOpts>): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    for (const check of this.checks) {
      try {
        const result = await check(config);
        results.push(result);
      } catch (err) {
        results.push({
          name: 'unknown',
          status: 'error',
          message: `Check threw: ${err}`,
          repairable: false,
        });
      }
    }

    return results;
  }

  /** Print results to stdout. */
  printResults(results: CheckResult[]): void {
    const icons: Record<CheckStatus, string> = {
      ok: '[OK]',
      warn: '[WARN]',
      error: '[ERR]',
    };

    for (const r of results) {
      console.log(`  ${icons[r.status]} ${r.name}: ${r.message}`);
    }

    const errors = results.filter((r) => r.status === 'error');
    const warns = results.filter((r) => r.status === 'warn');
    console.log(
      `\n  ${results.length} checks, ${errors.length} errors, ${warns.length} warnings`,
    );
  }
}
