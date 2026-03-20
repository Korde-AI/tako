/**
 * CLI subcommands for ACP session management.
 *
 * Usage:
 *   tako acp list              List ACP sessions (active + persisted)
 *   tako acp kill <id>         Terminate a session
 *   tako acp logs <id>         Show session message log
 *   tako acp exec <agent> <p>  One-shot ACP execution via acpx
 *   tako acp send <agent> <p>  Persistent ACP session send via acpx
 */

import { AcpSessionManager, type AcpSession } from '../tools/acp-sessions.js';
import { AcpxRuntime } from '../acp/runtime.js';
import { resolveAcpConfig, type AcpRuntimeConfig } from '../acp/config.js';
import { resolveAcpxCommand, spawnAcpx, waitForExit } from '../acp/process.js';

const ACP_AGENTS = new Set(['pi', 'claude', 'codex', 'opencode', 'gemini', 'kimi']);

/** Run a one-shot acpx command and collect output. */
async function runAcpxCommand(
  acpxCmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const child = spawnAcpx({
    command: acpxCmd,
    args,
    cwd,
    stripProviderAuthEnvVars: true,
  });
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });

  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }, timeoutMs);

  const exit = await waitForExit(child);
  clearTimeout(timer);

  return {
    ok: exit.error == null && (exit.code ?? 0) === 0,
    stdout,
    stderr,
  };
}

export async function runAcp(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const cwd = process.cwd();
  const acpxCmd = resolveAcpxCommand(cwd);

  switch (sub) {
    case 'list':
    case 'ls': {
      const sessions = await AcpSessionManager.loadPersistedSessions();
      if (sessions.length === 0) {
        console.log('No ACP sessions found.');
        return;
      }
      console.log('ID        Status     Agent    Label');
      console.log('\u2500'.repeat(60));
      for (const s of sessions) {
        const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
        console.log(
          `${s.id.padEnd(10)} ${s.status.padEnd(10)} ${(s.agent ?? 'unknown').padEnd(8)} ${s.label ?? '(none)'} (${elapsed}s ago)`,
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
      console.log(`Agent: ${session.agent ?? 'unknown'}`);
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

      // One-shot via acpx runtime
      const config = resolveAcpConfig({ defaultAgent: agent }, cwd);
      const runtime = new AcpxRuntime(config);
      await runtime.probeAvailability();

      if (!runtime.isHealthy()) {
        console.error('acpx is not available. Install it with: npm install -g acpx@0.1.16');
        process.exit(1);
      }

      const sessionName = `tako-exec-${Date.now()}`;
      const handle = await runtime.ensureSession({
        sessionKey: sessionName,
        agent,
        cwd,
        mode: 'oneshot',
      });

      for await (const event of runtime.runTurn({ handle, text: prompt })) {
        if (event.type === 'text_delta') {
          process.stdout.write(event.text);
        } else if (event.type === 'error') {
          console.error(`\n[error: ${event.message}]`);
        }
      }
      console.log('');

      await runtime.close({ handle, reason: 'exec-complete' }).catch(() => {});
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

      const config = resolveAcpConfig({ defaultAgent: agent }, cwd);
      const runtime = new AcpxRuntime(config);
      await runtime.probeAvailability();

      if (!runtime.isHealthy()) {
        console.error('acpx is not available. Install it with: npm install -g acpx@0.1.16');
        process.exit(1);
      }

      const sessionName = `tako-${agent}-${Buffer.from(cwd).toString('base64url').slice(0, 10)}`;
      const handle = await runtime.ensureSession({
        sessionKey: sessionName,
        agent,
        cwd,
        mode: 'persistent',
      });

      for await (const event of runtime.runTurn({ handle, text: prompt })) {
        if (event.type === 'text_delta') {
          process.stdout.write(event.text);
        } else if (event.type === 'error') {
          console.error(`\n[error: ${event.message}]`);
        }
      }
      console.log('');
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
