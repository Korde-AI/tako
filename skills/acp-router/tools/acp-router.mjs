import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STORE_DIR = join(homedir(), '.tako', 'acp');
const STORE_FILE = join(STORE_DIR, 'router-sessions.json');

const AGENT_ALIASES = new Set(['pi', 'claude', 'codex', 'opencode', 'gemini', 'kimi']);

function detectAcpx() {
  const envCmd = process.env.ACPX_CMD;
  if (envCmd) return envCmd;

  const local = join(process.cwd(), 'extensions', 'acpx', 'node_modules', '.bin', 'acpx');
  if (existsSync(local)) return local;

  return 'acpx';
}

async function loadStore() {
  try {
    const raw = await readFile(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveStore(store) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function shlex(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let esc = false;

  for (const ch of input) {
    if (esc) {
      current += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function run(cmd, args, cwd, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';

    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { err += String(d); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, code: -1, stdout: out, stderr: `${err}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: out, stderr: `${err}\n${e.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

function sessionKey(ctx, agent) {
  return `${ctx.sessionId}:${agent}`;
}

function defaultSessionName(ctx, agent) {
  const sid = String(ctx.sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  return `tako-${agent}-${sid}`;
}

function helpText() {
  return [
    'ACP Router',
    '',
    'Usage:',
    '  /acp <agent> <prompt>         Send prompt to persistent ACP session',
    '  /acp exec <agent> <prompt>    One-shot ACP execution',
    '  /acp list                      List ACP bindings for this Tako instance',
    '  /acp reset <agent>             Close + forget bound ACP session',
    '  /acp help                      Show this help',
    '',
    'Agents: pi, claude, codex, opencode, gemini, kimi',
  ].join('\n');
}

const acpRouterTool = {
  name: 'acp_router',
  description: 'Route ACP harness commands to acpx (persistent or one-shot).',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Raw /acp command args' },
    },
    required: ['input'],
  },
  async execute(params, ctx) {
    const input = String(params?.input || '').trim();
    if (!input || input === 'help') {
      return { success: true, output: helpText() };
    }

    const acpx = detectAcpx();
    const cwd = ctx.workDir || process.cwd();
    const store = await loadStore();
    const tokens = shlex(input);

    const versionCheck = await run(acpx, ['--version'], cwd, 15000);
    if (!versionCheck.ok) {
      return {
        success: false,
        error: [
          `acpx is not available (${acpx}).`,
          'Install it with: npm i -g acpx',
          'Or set ACPX_CMD to a valid binary path.',
        ].join(' '),
      };
    }

    const first = (tokens[0] || '').toLowerCase();

    if (first === 'list') {
      const entries = Object.entries(store);
      if (entries.length === 0) return { success: true, output: 'No ACP session bindings yet.' };
      const lines = entries.map(([k, v]) => `${k} -> ${v.agent}:${v.sessionName}`);
      return { success: true, output: `ACP bindings:\n${lines.join('\n')}` };
    }

    if (first === 'reset') {
      const agent = (tokens[1] || '').toLowerCase();
      if (!AGENT_ALIASES.has(agent)) {
        return { success: false, error: `Invalid agent "${agent}". Use: pi|claude|codex|opencode|gemini|kimi` };
      }
      const key = sessionKey(ctx, agent);
      const bound = store[key];
      if (!bound?.sessionName) {
        return { success: true, output: `No bound session for ${agent} in this chat session.` };
      }
      const closeRes = await run(acpx, [agent, 'sessions', 'close', bound.sessionName], cwd, 120000);
      delete store[key];
      await saveStore(store);
      if (closeRes.ok) return { success: true, output: `Closed ACP session ${bound.sessionName} (${agent}).` };
      return { success: true, output: `Unbound ${bound.sessionName} (${agent}).\n(close returned non-zero: ${closeRes.stderr || closeRes.stdout || 'unknown'})` };
    }

    if (first === 'exec') {
      const agent = (tokens[1] || '').toLowerCase();
      const prompt = tokens.slice(2).join(' ').trim();
      if (!AGENT_ALIASES.has(agent)) {
        return { success: false, error: `Invalid agent "${agent}". Use: pi|claude|codex|opencode|gemini|kimi` };
      }
      if (!prompt) return { success: false, error: 'Missing prompt. Usage: /acp exec <agent> <prompt>' };

      const res = await run(acpx, [agent, 'exec', prompt], cwd);
      if (!res.ok) {
        return { success: false, error: `acpx exec failed: ${(res.stderr || res.stdout || 'unknown error').trim()}` };
      }
      const text = (res.stdout || '').trim();
      const fallback = (res.stderr || '').trim();
      return { success: true, output: text || fallback || '(acpx returned no text output)' };
    }

    // Default mode: /acp <agent> <prompt>
    const agent = first;
    const prompt = tokens.slice(1).join(' ').trim();

    if (!AGENT_ALIASES.has(agent)) {
      return { success: false, error: `Invalid subcommand/agent "${agent}". Try /acp help` };
    }
    if (!prompt) {
      return { success: false, error: 'Missing prompt. Usage: /acp <agent> <prompt>' };
    }

    const key = sessionKey(ctx, agent);
    const existing = store[key];
    const sessionName = existing?.sessionName || defaultSessionName(ctx, agent);

    // Ensure session exists (best-effort create)
    await run(acpx, [agent, 'sessions', 'new', '--name', sessionName], cwd, 120000);

    const sendRes = await run(acpx, [agent, '-s', sessionName, prompt], cwd);
    if (!sendRes.ok) {
      return { success: false, error: `acpx session send failed: ${(sendRes.stderr || sendRes.stdout || 'unknown error').trim()}` };
    }

    store[key] = { agent, sessionName, updatedAt: Date.now() };
    await saveStore(store);

    const text = (sendRes.stdout || '').trim();
    const fallback = (sendRes.stderr || '').trim();
    return {
      success: true,
      output: text || fallback || `(acpx returned no text output for ${agent}:${sessionName})`,
      data: { agent, sessionName },
    };
  },
};

export const tools = [acpRouterTool];
export default tools;
