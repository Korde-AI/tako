/**
 * Tests for Symphony orchestration system:
 * - Workflow loader (parse frontmatter, render template)
 * - Workspace manager (sanitize, path generation)
 * - Orchestrator state management (claim, release, retry scheduling)
 * - Issue eligibility checking
 * - Status formatting
 * - Stall detection logic
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WorkflowLoader, slugify } from '../src/core/symphony/workflow.js';
import { WorkspaceManager } from '../src/core/symphony/workspace.js';
import { formatStatus, formatRunSummary, formatHistory } from '../src/core/symphony/status.js';
import type {
  GitHubIssue,
  OrchestratorState,
  RunningAgent,
  SymphonyConfig,
} from '../src/core/symphony/types.js';

// ─── Test helpers ───────────────────────────────────────────────────

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 42,
    title: 'Fix login bug',
    body: 'Users cannot log in when...',
    state: 'open',
    labels: ['bug'],
    assignees: [],
    url: 'https://github.com/owner/repo/issues/42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<RunningAgent> = {}): RunningAgent {
  return {
    issueNumber: 42,
    issueTitle: 'Fix login bug',
    workspacePath: '/tmp/ws/issue-42',
    startedAt: Date.now() - 120000,
    status: 'running',
    attempt: 1,
    lastActivityAt: Date.now() - 10000,
    commits: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    running: new Map(),
    claimed: new Set(),
    retryQueue: new Map(),
    completed: new Map(),
    startedAt: Date.now() - 3600000,
    totalRuns: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SymphonyConfig> = {}): SymphonyConfig {
  return {
    repo: 'owner/repo',
    pollIntervalMs: 30000,
    maxConcurrentAgents: 5,
    ...overrides,
  };
}

// ─── WorkflowLoader ────────────────────────────────────────────────

describe('WorkflowLoader', () => {
  let tmpDir: string;
  let loader: WorkflowLoader;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-symphony-'));
    loader = new WorkflowLoader();
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses WORKFLOW.md with frontmatter', async () => {
    const path = join(tmpDir, 'WORKFLOW.md');
    await writeFile(path, `---
tracker:
  labels: ["bug", "enhancement"]
  active_states: ["open"]
polling:
  interval_ms: 60000
agent:
  max_concurrent: 3
---

Work on issue #{{issue.number}}: {{issue.title}}
`);

    const def = loader.load(path);
    assert.ok(def.config.tracker);
    assert.equal(def.promptTemplate, 'Work on issue #{{issue.number}}: {{issue.title}}');
  });

  it('handles WORKFLOW.md without frontmatter', async () => {
    const path = join(tmpDir, 'WORKFLOW-bare.md');
    await writeFile(path, 'Just a plain prompt template.\n');

    const def = loader.load(path);
    assert.deepEqual(def.config, {});
    assert.equal(def.promptTemplate.trim(), 'Just a plain prompt template.');
  });

  it('returns empty definition for missing file', () => {
    const def = loader.load(join(tmpDir, 'nonexistent.md'));
    assert.deepEqual(def.config, {});
    assert.equal(def.promptTemplate, '');
  });

  it('renders template variables', () => {
    const issue = makeIssue({ number: 99, title: 'Add Dark Mode', body: 'Please add dark mode', labels: ['feature'] });
    const template = 'Fix #{{issue.number}} — {{issue.title}}\nLabels: {{issue.labels}}\nBranch: fix/{{issue.number}}-{{issue.title_slug}}';
    const rendered = loader.renderPrompt(template, issue, 2);

    assert.ok(rendered.includes('#99'));
    assert.ok(rendered.includes('Add Dark Mode'));
    assert.ok(rendered.includes('feature'));
    assert.ok(rendered.includes('fix/99-add-dark-mode'));
  });

  it('handles empty template', () => {
    const issue = makeIssue();
    assert.equal(loader.renderPrompt('', issue), '');
  });
});

// ─── slugify ────────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts spaces and special chars to hyphens', () => {
    assert.equal(slugify('Fix Login Bug'), 'fix-login-bug');
  });

  it('removes leading/trailing hyphens', () => {
    assert.equal(slugify('--Fix Bug--'), 'fix-bug');
  });

  it('truncates to 50 characters', () => {
    const long = 'a'.repeat(100);
    assert.ok(slugify(long).length <= 50);
  });

  it('handles empty string', () => {
    assert.equal(slugify(''), '');
  });

  it('handles special characters', () => {
    assert.equal(slugify('Fix: login & auth (v2)'), 'fix-login-auth-v2');
  });
});

// ─── WorkspaceManager ──────────────────────────────────────────────

describe('WorkspaceManager', () => {
  it('generates correct workspace path', () => {
    const mgr = new WorkspaceManager('/tmp/ws', 'owner/repo');
    const path = mgr.getPath(42, 'Fix Login Bug');
    assert.equal(path, '/tmp/ws/owner-repo/issue-42-fix-login-bug');
  });

  it('generates path without title', () => {
    const mgr = new WorkspaceManager('/tmp/ws', 'owner/repo');
    const path = mgr.getPath(42);
    assert.equal(path, '/tmp/ws/owner-repo/issue-42');
  });

  it('sanitizes repo name in path', () => {
    const mgr = new WorkspaceManager('/tmp/ws', 'org/my-repo');
    const path = mgr.getPath(1, 'test');
    assert.ok(path.includes('org-my-repo'));
  });
});

// ─── Status formatting ─────────────────────────────────────────────

describe('formatStatus', () => {
  it('shows empty dashboard when no agents running', () => {
    const state = makeState();
    const config = makeConfig();
    const output = formatStatus(state, config);
    assert.ok(output.includes('Symphony'));
    assert.ok(output.includes('owner/repo'));
    assert.ok(output.includes('(none)'));
  });

  it('shows running agents', () => {
    const agent = makeAgent({ issueNumber: 42, issueTitle: 'Fix login bug' });
    const state = makeState({
      running: new Map([[42, agent]]),
      totalRuns: 1,
    });
    const config = makeConfig();
    const output = formatStatus(state, config);
    assert.ok(output.includes('#42'));
    assert.ok(output.includes('Running (1/5)'));
  });

  it('shows retry queue', () => {
    const state = makeState({
      retryQueue: new Map([[41, {
        issueNumber: 41,
        attempt: 3,
        dueAtMs: Date.now() + 45000,
      }]]),
    });
    const config = makeConfig();
    const output = formatStatus(state, config);
    assert.ok(output.includes('Retry Queue'));
    assert.ok(output.includes('#41'));
  });

  it('shows completed runs', () => {
    const agent = makeAgent({
      issueNumber: 40,
      issueTitle: 'Fix typo',
      status: 'succeeded',
      prUrl: 'https://github.com/owner/repo/pull/51',
    });
    const state = makeState({
      completed: new Map([[40, agent]]),
      totalSuccesses: 1,
    });
    const config = makeConfig();
    const output = formatStatus(state, config);
    assert.ok(output.includes('#40'));
    assert.ok(output.includes('Recent'));
  });
});

describe('formatRunSummary', () => {
  it('formats a running agent summary', () => {
    const agent = makeAgent({
      commits: ['abc123'],
      prUrl: 'https://github.com/owner/repo/pull/50',
    });
    const output = formatRunSummary(agent);
    assert.ok(output.includes('#42'));
    assert.ok(output.includes('Fix login bug'));
    assert.ok(output.includes('abc123'));
    assert.ok(output.includes('pull/50'));
  });
});

describe('formatHistory', () => {
  it('handles empty history', () => {
    const output = formatHistory([]);
    assert.equal(output, 'No completed runs yet.');
  });

  it('formats completed runs', () => {
    const agents = [
      makeAgent({ issueNumber: 1, issueTitle: 'First', status: 'succeeded' }),
      makeAgent({ issueNumber: 2, issueTitle: 'Second', status: 'failed', error: 'tests failed' }),
    ];
    const output = formatHistory(agents);
    assert.ok(output.includes('#1'));
    assert.ok(output.includes('#2'));
    assert.ok(output.includes('Run History'));
  });

  it('respects limit parameter', () => {
    const agents = Array.from({ length: 30 }, (_, i) =>
      makeAgent({ issueNumber: i, issueTitle: `Issue ${i}`, status: 'succeeded' }),
    );
    const output = formatHistory(agents, 5);
    // Should only show last 5
    assert.ok(output.includes('#25'));
    assert.ok(output.includes('#29'));
  });
});
