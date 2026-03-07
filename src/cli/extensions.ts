/**
 * CLI: tako extensions — list, inspect, and manage skill extensions.
 */

import { resolveConfig } from '../config/resolve.js';
import { SkillLoader } from '../skills/loader.js';
import { EXTENSION_DIRS, type ExtensionType } from '../skills/extensions.js';

export async function runExtensions(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      const config = await resolveConfig();
      const loader = new SkillLoader(config.skills.dirs);
      const manifests = await loader.discover();

      console.log('Skill Extensions:\n');
      console.log('  Type       Skill              Entry');
      console.log('  ─────────  ─────────────────  ──────────────────────────────');

      let found = false;
      for (const manifest of manifests) {
        const loaded = await loader.load(manifest);
        const exts = loaded.manifest.extensions;
        if (!exts) continue;

        for (const extType of EXTENSION_DIRS) {
          const ext = exts[extType];
          if (!ext) continue;
          found = true;
          const typeStr = extType.padEnd(9);
          const nameStr = manifest.name.padEnd(17);
          console.log(`  ${typeStr}  ${nameStr}  ${ext.entry}`);
        }
      }

      if (!found) {
        console.log('  (none detected)\n');
        console.log('Skills can provide extensions by including subdirectories:');
        console.log('  channel/, provider/, memory/, network/, sandbox/, auth/');
      }
      break;
    }

    case 'status': {
      console.log('Extension runtime status is only available when Tako is running.');
      console.log('Use `tako extensions list` to see available extensions.');
      break;
    }

    default:
      console.log(`Usage: tako extensions <command>

Commands:
  list       List all skill extensions (installed + available)
  status     Show runtime status of loaded extensions`);
  }
}
