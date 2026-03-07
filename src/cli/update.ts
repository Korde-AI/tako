/**
 * CLI: tako update — check for and install updates.
 */

import { execSync } from 'node:child_process';

const VERSION = '0.0.1';

export async function runUpdate(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'check';

  switch (subcommand) {
    case 'check': {
      console.log(`Current version: ${VERSION}`);
      try {
        const latest = execSync('npm view tako version 2>/dev/null', { encoding: 'utf-8' }).trim();
        if (latest && latest !== VERSION) {
          console.log(`Latest version:  ${latest}`);
          console.log('\nUpdate available! Run: tako update install');
        } else if (latest) {
          console.log('You are on the latest version.');
        } else {
          console.log('Could not check for updates (package not published).');
        }
      } catch {
        console.log('Could not check for updates. Ensure npm is available.');
      }
      break;
    }

    case 'install': {
      console.log(`Current version: ${VERSION}`);
      console.log('Updating Tako...\n');
      try {
        execSync('npm update -g tako', { stdio: 'inherit' });
        console.log('\nUpdate complete. Restart Tako to use the new version.');
      } catch {
        console.error('\nUpdate failed. Try manually: npm update -g tako');
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown update subcommand: ${subcommand}`);
      console.error('Available: check, install');
      process.exit(1);
  }
}
