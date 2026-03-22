import { resolveConfig } from '../config/resolve.js';
import { Doctor } from '../doctor/doctor.js';
import { checkConfig } from '../doctor/checks/config.js';
import { checkProviders } from '../doctor/checks/providers.js';
import { checkChannels } from '../doctor/checks/channels.js';
import { checkMemory } from '../doctor/checks/memory.js';
import { checkSessions } from '../doctor/checks/sessions.js';
import { checkPermissions } from '../doctor/checks/permissions.js';
import { checkBrowser } from '../doctor/checks/browser.js';

export async function runDoctor(args: string[]): Promise<void> {
  const config = await resolveConfig();
  const doctor = new Doctor();

  doctor.addCheck(checkConfig);
  doctor.addCheck(checkProviders);
  doctor.addCheck(checkChannels);
  doctor.addCheck(checkMemory);
  doctor.addCheck(checkSessions);
  doctor.addCheck(checkPermissions);
  doctor.addCheck(checkBrowser);

  console.log('Tako Doctor — running health checks...\n');
  const results = await doctor.run(config, {
    autoRepair: args.includes('--yes') || args.includes('-y'),
    deep: args.includes('--deep'),
  });
  doctor.printResults(results);

  const hasErrors = results.some((r) => r.status === 'error');
  process.exit(hasErrors ? 1 : 0);
}
