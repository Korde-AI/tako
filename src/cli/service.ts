/**
 * CLI: tako service — manage systemd user service for Tako.
 *
 * Subcommands:
 *   install    Create and enable the systemd user service
 *   uninstall  Stop, disable, and remove the service
 *   start      Start the service
 *   stop       Stop the service
 *   restart    Restart the service
 *   status     Show service status
 *   logs       Show service logs (journalctl)
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const SERVICE_NAME = 'tako.service';

function getServiceDir(): string {
  return join(homedir(), '.config', 'systemd', 'user');
}

function getServicePath(): string {
  return join(getServiceDir(), SERVICE_NAME);
}

function findBunBinary(): string | null {
  try {
    return execSync('which bun', { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

function findTakoBinary(): string {
  // Try the tako command in PATH first
  try {
    const which = execSync('which tako', { encoding: 'utf-8' }).trim();
    if (which) return which;
  } catch {
    // not found in PATH
  }

  // Prefer bun for direct TS execution (no build step needed)
  const bun = findBunBinary();
  const entryPoint = process.argv[1];
  if (bun && entryPoint) {
    return `${bun} ${entryPoint}`;
  }

  // Fallback: use the current runtime + entry point
  if (entryPoint) {
    return `${process.argv[0]} ${entryPoint}`;
  }

  return '/usr/local/bin/tako';
}

function generateUnit(): string {
  const takoBin = findTakoBinary();
  return `[Unit]
Description=Tako Agent OS
After=network.target

[Service]
Type=simple
ExecStart=${takoBin} start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=TAKO_KEEP_ALIVE=1
WorkingDirectory=${homedir()}

[Install]
WantedBy=default.target
`;
}

function systemctl(args: string): void {
  execSync(`systemctl --user ${args}`, { stdio: 'inherit' });
}

async function install(): Promise<void> {
  const dir = getServiceDir();
  const path = getServicePath();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const unit = generateUnit();
  writeFileSync(path, unit, 'utf-8');
  console.log(`[tako] Service unit written to ${path}`);

  systemctl('daemon-reload');
  systemctl(`enable ${SERVICE_NAME}`);
  console.log('[tako] Service installed and enabled');
  console.log('[tako] Run `tako service start` to start it');
}

async function uninstall(): Promise<void> {
  const path = getServicePath();

  try {
    systemctl(`stop ${SERVICE_NAME}`);
  } catch {
    // may not be running
  }

  try {
    systemctl(`disable ${SERVICE_NAME}`);
  } catch {
    // may not be enabled
  }

  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`[tako] Removed ${path}`);
  }

  systemctl('daemon-reload');
  console.log('[tako] Service uninstalled');
}

async function start(): Promise<void> {
  systemctl(`start ${SERVICE_NAME}`);
  console.log('[tako] Service started');
}

async function stop(): Promise<void> {
  systemctl(`stop ${SERVICE_NAME}`);
  console.log('[tako] Service stopped');
}

async function restart(): Promise<void> {
  systemctl(`restart ${SERVICE_NAME}`);
  console.log('[tako] Service restarted');
}

async function status(): Promise<void> {
  try {
    systemctl(`status ${SERVICE_NAME}`);
  } catch {
    // systemctl status exits non-zero when service is stopped
  }
}

async function logs(): Promise<void> {
  const child = spawn(
    'journalctl',
    ['--user', '-u', SERVICE_NAME, '-f', '--no-pager', '-n', '100'],
    { stdio: 'inherit' },
  );

  await new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      child.kill('SIGINT');
      resolve();
    });
  });
}

export async function runService(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'install':
      await install();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'start':
      await start();
      break;
    case 'stop':
      await stop();
      break;
    case 'restart':
      await restart();
      break;
    case 'status':
      await status();
      break;
    case 'logs':
    case 'log':
      await logs();
      break;
    default:
      console.log(`Usage: tako service <command>

Commands:
  install    Install systemd user service
  uninstall  Remove systemd user service
  start      Start the service
  stop       Stop the service
  restart    Restart the service
  status     Show service status
  logs       Show service logs`);
      break;
  }
}
