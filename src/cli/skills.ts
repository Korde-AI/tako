import { resolveConfig } from '../config/resolve.js';
import { SkillLoader } from '../skills/loader.js';

export async function runSkills(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'list') {
    await skillsList();
  } else if (subcommand === 'install') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills install <name>');
      console.error('  Example: tako skills install vercel-labs/agent-skills@find-skills');
      process.exit(1);
    }
    await skillsInstall(name);
  } else if (subcommand === 'info') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills info <name>');
      process.exit(1);
    }
    await skillsInfo(name);
  } else if (subcommand === 'check') {
    await skillsCheck();
  } else if (subcommand === 'audit') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills audit <name>');
      process.exit(1);
    }
    await skillsAudit(name);
  } else if (subcommand === 'search') {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.error('Usage: tako skills search <query>');
      process.exit(1);
    }
    const { SkillMarketplace } = await import('../skills/marketplace.js');
    const marketplace = new SkillMarketplace();
    const results = await marketplace.search(query);
    if (results.length === 0) {
      console.log('No skills found matching your query.');
      return;
    }
    console.log(`Found ${results.length} skill(s):\n`);
    for (const r of results) {
      console.log(`  ${r.fullName} (${r.stars} stars)`);
      console.log(`    ${r.description || '(no description)'}`);
      console.log(`    Install: tako skills install ${r.fullName}`);
      console.log();
    }
  } else if (subcommand === 'update') {
    const name = args[1];
    const { SkillMarketplace } = await import('../skills/marketplace.js');
    const marketplace = new SkillMarketplace();
    const updated = await marketplace.update(name);
    console.log(`Updated ${updated.length} skill(s):`);
    for (const s of updated) {
      console.log(`  ${s.name} → ${s.version ?? 'latest'}`);
    }
  } else if (subcommand === 'remove' || subcommand === 'rm') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills remove <name>');
      process.exit(1);
    }
    const { SkillMarketplace } = await import('../skills/marketplace.js');
    const marketplace = new SkillMarketplace();
    const removed = await marketplace.remove(name);
    if (removed) {
      console.log(`Removed skill: ${name}`);
    } else {
      console.error(`Skill not found: ${name}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown skills subcommand: ${subcommand}`);
    console.error('Available: list, install, search, update, remove, info, check, audit');
    process.exit(1);
  }
}

async function skillsList(): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();

  if (manifests.length === 0) {
    console.log('No skills installed.');
    console.log('\nInstall skills with: tako skills install <name>');
    console.log('Browse available skills at: https://skills.sh/');
    return;
  }

  console.log(`Discovered ${manifests.length} skill(s):\n`);
  for (const m of manifests) {
    const triggers = m.triggers
      ? m.triggers.map((t) => t.type === 'keyword' ? t.value : t.type).join(', ')
      : 'always';
    console.log(`  ${m.name} (v${m.version})`);
    console.log(`    ${m.description.slice(0, 80)}${m.description.length > 80 ? '...' : ''}`);
    console.log(`    Triggers: ${triggers}`);
    console.log(`    Path: ${m.rootDir}`);
    console.log();
  }
}

async function skillsInstall(nameOrRef: string): Promise<void> {
  const { execSync } = await import('node:child_process');
  console.log(`Installing skill: ${nameOrRef}...`);
  try {
    execSync(`npx skills add ${nameOrRef} -y`, { stdio: 'inherit', cwd: process.cwd() });
    console.log('\nSkill installed. Run `tako skills list` to verify.');
  } catch {
    console.error('\nFailed to install skill. Make sure `npx skills` is available.');
    console.error('You can also manually create a skill directory in ./skills/ with a SKILL.md file.');
    process.exit(1);
  }
}

async function skillsInfo(name: string): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();
  const manifest = manifests.find((m) => m.name === name);

  if (!manifest) {
    console.error(`Skill not found: ${name}`);
    console.error(`Available skills: ${manifests.map((m) => m.name).join(', ') || 'none'}`);
    process.exit(1);
  }

  const loaded = await loader.load(manifest);

  console.log(`Skill: ${manifest.name}`);
  console.log(`Version: ${manifest.version}`);
  if (manifest.author) console.log(`Author: ${manifest.author}`);
  console.log(`Description: ${manifest.description}`);
  console.log(`Path: ${manifest.rootDir}`);
  console.log(`SKILL.md: ${manifest.skillPath}`);

  if (manifest.triggers && manifest.triggers.length > 0) {
    console.log(`\nTriggers:`);
    for (const t of manifest.triggers) {
      console.log(`  - ${t.type}${t.value ? `: ${t.value}` : ''}`);
    }
  }

  if (loaded.tools.length > 0) {
    console.log(`\nTools (${loaded.tools.length}):`);
    for (const t of loaded.tools) {
      console.log(`  - ${t.name}: ${t.description}`);
    }
  }

  const preview = loaded.instructions.slice(0, 500);
  console.log(`\nInstructions (${loaded.instructions.length} chars):`);
  console.log(preview + (loaded.instructions.length > 500 ? '\n  ...' : ''));
}

async function skillsCheck(): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();

  if (manifests.length === 0) {
    console.log('No skills discovered.');
    return;
  }

  console.log(`Checking ${manifests.length} skill(s):\n`);
  let ready = 0;
  let failed = 0;

  for (const m of manifests) {
    try {
      const loaded = await loader.load(m);
      console.log(`  ✓ ${m.name} (v${m.version}) — ${loaded.tools.length} tool(s)`);
      ready++;
    } catch (err) {
      console.log(`  ✗ ${m.name} (v${m.version}) — ${err instanceof Error ? err.message : 'load failed'}`);
      failed++;
    }
  }

  console.log(`\n${ready} ready, ${failed} failed`);
}

async function skillsAudit(name: string): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();
  const manifest = manifests.find((m) => m.name === name);

  if (!manifest) {
    console.error(`Skill not found: ${name}`);
    console.error(`Available skills: ${manifests.map((m) => m.name).join(', ') || 'none'}`);
    process.exit(1);
  }

  const loaded = await loader.load(manifest);

  console.log(`Security Audit: ${manifest.name} (v${manifest.version})\n`);
  console.log(`Author: ${manifest.author ?? 'unknown'}`);
  console.log(`Path: ${manifest.rootDir}`);

  console.log(`\nTools (${loaded.tools.length}):`);
  for (const t of loaded.tools) {
    const params = t.parameters ? Object.keys(t.parameters.properties ?? {}).join(', ') : 'none';
    console.log(`  ${t.name}: ${t.description}`);
    console.log(`    Parameters: ${params}`);
  }

  if (manifest.triggers && manifest.triggers.length > 0) {
    console.log(`\nTriggers (${manifest.triggers.length}):`);
    for (const t of manifest.triggers) {
      console.log(`  - ${t.type}${t.value ? `: ${t.value}` : ''}`);
    }
  } else {
    console.log('\nTriggers: always active (no triggers defined)');
  }

  console.log(`\nInstruction size: ${loaded.instructions.length} chars`);

  const warnings: string[] = [];
  if (!manifest.author) warnings.push('No author specified');
  if (!manifest.triggers || manifest.triggers.length === 0) warnings.push('Always active (no trigger gating)');
  if (loaded.instructions.length > 10000) warnings.push(`Large instructions (${loaded.instructions.length} chars may impact context)`);
  if (loaded.tools.length > 5) warnings.push(`Many tools (${loaded.tools.length}) — consider splitting`);

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of warnings) {
      console.log(`  ⚠ ${w}`);
    }
  } else {
    console.log('\nNo warnings.');
  }
}
