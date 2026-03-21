import { AcpxRuntime } from '../../acp/runtime.js';
import type { AcpRuntimeConfig } from '../../acp/config.js';
import { AcpSessionManager } from '../../tools/acp-sessions.js';

export function createAcpRuntimeBundle(acpConfig: AcpRuntimeConfig) {
  const acpRuntime = new AcpxRuntime(acpConfig);
  const acpSessionManager = new AcpSessionManager(acpConfig, acpRuntime);

  return {
    acpRuntime,
    acpSessionManager,
    async probe(): Promise<boolean> {
      await acpRuntime.probeAvailability();
      return acpRuntime.isHealthy();
    },
  };
}
