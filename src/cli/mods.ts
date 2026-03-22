export async function runMod(args: string[]): Promise<void> {
  const { ModManager } = await import('../mods/mod.js');
  const mods = new ModManager();
  const sub = args[0];

  switch (sub) {
    case 'list':
    case 'ls': {
      const all = await mods.list();
      const active = await mods.getActive();
      console.log(`Active: ${active}\n`);
      if (all.length === 0) {
        console.log('No mods installed.');
        console.log('  tako mod create <name> "description"    Create a new mod');
        console.log('  tako mod install <path|git-url>         Install a mod');
      } else {
        for (const mod of all) {
          const marker = mod.isActive ? ' ← active' : '';
          console.log(`  ${mod.name} v${mod.manifest.version}${marker}`);
          if (mod.manifest.description) console.log(`    ${mod.manifest.description}`);
          if (mod.manifest.author) console.log(`    by ${mod.manifest.author}`);
        }
      }
      break;
    }
    case 'use':
    case 'switch': {
      const name = args[1];
      if (!name) {
        console.log('Usage: tako mod use <name|main>');
        process.exit(1);
      }
      const result = await mods.use(name);
      console.log(result.message);
      if (!result.success) process.exit(1);
      break;
    }
    case 'install':
    case 'add': {
      const source = args[1];
      if (!source) {
        console.log('Usage: tako mod install <path|git-url>');
        process.exit(1);
      }
      const result = source.includes('://') || source.endsWith('.git')
        ? await mods.installFromGit(source)
        : await mods.install(source);
      console.log(result.message);
      if (!result.success) process.exit(1);
      break;
    }
    case 'create':
    case 'new': {
      const name = args[1];
      const desc = args.slice(2).join(' ') || 'A Tako mod';
      if (!name) {
        console.log('Usage: tako mod create <name> [description]');
        process.exit(1);
      }
      const result = await mods.create(name, desc);
      console.log(result.message);
      break;
    }
    case 'remove':
    case 'rm': {
      const name = args[1];
      if (!name) {
        console.log('Usage: tako mod remove <name>');
        process.exit(1);
      }
      const result = await mods.remove(name);
      console.log(result.message);
      if (!result.success) process.exit(1);
      break;
    }
    case 'info': {
      const name = args[1] ?? await mods.getActive();
      const all = await mods.list();
      const mod = all.find((m) => m.name === name);
      if (!mod) {
        console.log(`Mod "${name}" not found.`);
        process.exit(1);
      }
      console.log(`${mod.manifest.name} v${mod.manifest.version}`);
      if (mod.manifest.description) console.log(`Description: ${mod.manifest.description}`);
      if (mod.manifest.author) console.log(`Author: ${mod.manifest.author}`);
      if (mod.manifest.source) console.log(`Source: ${mod.manifest.source}`);
      if (mod.manifest.tags?.length) console.log(`Tags: ${mod.manifest.tags.join(', ')}`);
      console.log(`Path: ${mod.path}`);
      console.log(`Active: ${mod.isActive}`);
      if (mod.config.provider) console.log(`Provider: ${mod.config.provider}`);
      break;
    }
    default:
      console.log('Tako Mod Hub 🐙\n');
      console.log('Usage: tako mod <command>\n');
      console.log('Commands:');
      console.log('  list                      List installed mods');
      console.log('  use <name|main>           Switch to a mod (or back to main)');
      console.log('  install <path|git-url>    Install a mod from local dir or git');
      console.log('  create <name> [desc]      Create a new empty mod');
      console.log('  remove <name>             Remove an installed mod');
      console.log('  info [name]               Show mod details');
      console.log('');
      console.log('Mods are stored at: ~/.tako/mods/');
      console.log('');
      console.log('A mod packages: identity (SOUL.md), skills, workspace templates,');
      console.log('and config overrides — everything except your API keys and bot tokens.');
      console.log('');
      console.log('⚠️  After switching mods, restart Tako and reconnect channels if needed.');
      break;
  }
}
