/**
 * CLI subcommands for ACP session management.
 *
 * Usage:
 *   tako acp list              List ACP sessions (active + persisted)
 *   tako acp kill <id>         Terminate a session
 *   tako acp logs <id>         Show session message log
 */

import { AcpSessionManager, type AcpSession } from '../tools/acp-sessions.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type CmdResult = { ok: boolean; code: number | null; stdout: string; stderr: string };

const ACP_AGENTS = new Set(['pi', 'claude', 'codex', 'opencode', 'gemini', 'kimi']);

function detectAcpx(cwd: string): string {
  const envCmd = process.env.ACPX_CMD;
  if (envCmd && envCmd.trim().length > 0) return envCmd;

  const local = join(cwd, 'extensions', 'acpx', 'node_modules', '.bin', 'acpx');
  if (existsSync(local)) return local;

  return 'acpx';
}

function run(cmd: string, argv: string[], cwd: string, timeoutMs = 120000): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]` });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${String(err)}` });
    });
  });
}

export async function runAcp(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const cwd = process.cwd();

  switch (sub) {
    case 'list':
    case 'ls': {
      const sessions = await AcpSessionManager.loadPersistedSessions();
      if (sessions.length === 0) {
        console.log('No ACP sessions found.');
        return;
      }
      console.log('ID        Status     Backend  Label');
      console.log('─'.repeat(60));
      for (const s of sessions) {
        const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
        console.log(
          `${s.id.padEnd(10)} ${s.status.padEnd(10)} ${s.backend.padEnd(8)} ${s.label ?? '(none)'} (${elapsed}s ago)`,
        );
      }
      break;
    }

    case 'kill': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako acp kill <session-id>');
        process.exit(1);
      }
      // Can only kill live sessions — need a running manager
      console.log(`To kill a live session, use the acp_session_kill tool from within Tako.`);
      console.log(`For stale entries, they will be cleaned up on next Tako restart.`);
      break;
    }

    case 'logs': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako acp logs <session-id>');
        process.exit(1);
      }
      const sessions = await AcpSessionManager.loadPersistedSessions();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        console.error(`Session ${sessionId} not found.`);
        process.exit(1);
      }
      console.log(`Session: ${session.id} [${session.status}]`);
      console.log(`Backend: ${session.backend}`);
      console.log(`Started: ${new Date(session.startedAt).toISOString()}`);
      console.log(`Label: ${session.label ?? '(none)'}`);
      console.log('');
      for (const msg of session.messages) {
        const ts = new Date(msg.timestamp).toISOString();
        const prefix = msg.role === 'user' ? '>>> ' : '<<< ';
        console.log(`[${ts}] ${prefix}${msg.content.slice(0, 500)}`);
      }
      break;
    }

    case 'exec': {
      const agent = args[1];
      const prompt = args.slice(2).join(' ').trim();
      if (!agent || !ACP_AGENTS.has(agent)) {
        console.error('Usage: tako acp exec <pi|claude|codex|opencode|gemini|kimi> <prompt>');
        process.exit(1);
      }
      if (!prompt) {
        console.error('Usage: tako acp exec <agent> <prompt>');
        process.exit(1);
      }

      const acpx = detectAcpx(cwd);
      const res = await run(acpx, [agent, 'exec', prompt], cwd, 180000);
      if (!res.ok) {
        console.error(res.stderr || res.stdout || 'acp exec failed');
        process.exit(1);
      }
      console.log((res.stdout || '').trim());
      break;
    }

    case 'send': {
      const agent = args[1];
      const prompt = args.slice(2).join(' ').trim();
      if (!agent || !ACP_AGENTS.has(agent)) {
        console.error('Usage: tako acp send <pi|claude|codex|opencode|gemini|kimi> <prompt>');
        process.exit(1);
      }
      if (!prompt) {
        console.error('Usage: tako acp send <agent> <prompt>');
        process.exit(1);
      }

      const acpx = detectAcpx(cwd);
      const sessionName = `tako-${agent}-${Buffer.from(cwd).toString('base64url').slice(0, 10)}`;
      await run(acpx, [agent, 'sessions', 'new', '--name', sessionName], cwd, 60000);
      const res = await run(acpx, [agent, '-s', sessionName, prompt], cwd, 240000);
      if (!res.ok) {
        console.error(res.stderr || res.stdout || 'acp send failed');
        process.exit(1);
      }
      console.log((res.stdout || '').trim());
      break;
    }

    case 'help':
    case '-h':
    case '--help': {
      console.log('Usage: tako acp [list|logs|kill|exec|send]');
      console.log('  tako acp exec <agent> <prompt>   One-shot ACP execution');
      console.log('  tako acp send <agent> <prompt>   Persistent ACP session send');
      break;
    }

    default:
      console.error(`Unknown acp subcommand: ${sub}`);
      console.error('Usage: tako acp [list|kill|logs|exec|send]');
      process.exit(1);
  }
}
