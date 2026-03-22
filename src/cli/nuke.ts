export async function runNuke(args: string[]): Promise<void> {
  const { homedir } = await import('node:os');
  const { rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const readline = await import('node:readline');

  const takoDir = join(homedir(), '.tako');

  console.log('');
  console.log('  ⚠️  ⚠️  ⚠️   TAKO NUKE   ⚠️  ⚠️  ⚠️');
  console.log('');
  console.log('  This will PERMANENTLY DELETE:');
  console.log('');

  const targets: { name: string; path: string; description: string }[] = [];
  const checks = [
    { name: 'Config', path: join(takoDir, 'tako.json'), description: 'tako.json (provider, channel, agent config)' },
    { name: 'Auth', path: join(takoDir, 'auth'), description: 'auth/ (API keys, OAuth tokens)' },
    { name: 'Workspace', path: join(takoDir, 'workspace'), description: 'workspace/ (SOUL.md, AGENTS.md, memory, files)' },
    { name: 'Agents', path: join(takoDir, 'agents'), description: 'agents/ (all agent configs and state)' },
    { name: 'Sessions', path: join(takoDir, 'sessions'), description: 'sessions/ (conversation history)' },
    { name: 'Mods', path: join(takoDir, 'mods'), description: 'mods/ (installed mods and their workspaces)' },
    { name: 'Cron', path: join(takoDir, 'cron'), description: 'cron/ (scheduled jobs)' },
    { name: 'PID', path: join(takoDir, 'tako.pid'), description: 'tako.pid (daemon PID file)' },
  ];

  const { existsSync } = await import('node:fs');
  for (const check of checks) {
    if (existsSync(check.path)) {
      targets.push(check);
      console.log(`    ✗  ${check.description}`);
    }
  }

  if (targets.length === 0) {
    console.log('    (nothing found — ~/.tako/ is already clean)');
    return;
  }

  console.log('');
  console.log(`  Location: ${takoDir}`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  const answer1 = await ask('  Type "nuke" to confirm: ');
  if (answer1.trim().toLowerCase() !== 'nuke') {
    console.log('  Cancelled.');
    rl.close();
    return;
  }

  const answer2 = await ask('  Are you SURE? This cannot be undone. Type "yes i am sure": ');
  if (answer2.trim().toLowerCase() !== 'yes i am sure') {
    console.log('  Cancelled.');
    rl.close();
    return;
  }

  rl.close();

  console.log('');
  console.log('  Nuking...');

  try {
    const { getDaemonStatus, removePidFile } = await import('../daemon/pid.js');
    const status = await getDaemonStatus();
    if (status.running && status.info) {
      console.log(`  Stopping daemon (PID: ${status.info.pid})...`);
      process.kill(status.info.pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 2000));
    }
    await removePidFile();
  } catch {
    // not running
  }

  for (const target of targets) {
    try {
      await rm(target.path, { recursive: true, force: true });
      console.log(`  ✓  Deleted ${target.name}`);
    } catch (err) {
      console.error(`  ✗  Failed to delete ${target.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log('');
  console.log('  🐙 Tako has been reset to factory defaults.');
  console.log('  Run `tako onboard` to set up again.');
  console.log('');
}
