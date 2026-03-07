/**
 * Tests for progress tracking and session init protocol.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProgressTracker, type ProgressEntry, type ProgressFile } from '../src/core/progress.js';
import { buildSessionInitPrompt, buildSessionInitContext } from '../src/core/session-init.js';

function makeEntry(overrides?: Partial<ProgressEntry>): ProgressEntry {
  return {
    sessionId: 'test-session-001',
    timestamp: '2026-03-07T12:00:00Z',
    featuresWorkedOn: ['feature-a'],
    filesChanged: ['src/foo.ts'],
    decisionsMade: ['use JSON format'],
    blockers: [],
    nextSteps: ['add tests'],
    commits: ['abc1234'],
    compactionCount: 0,
    ...overrides,
  };
}

// ─── ProgressTracker ─────────────────────────────────────────────────

describe('ProgressTracker', () => {
  let tmpDir: string;
  let tracker: ProgressTracker;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-progress-test-'));
    tracker = new ProgressTracker(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('read() returns null when file does not exist', async () => {
    const emptyTracker = new ProgressTracker(join(tmpDir, 'nonexistent'));
    const result = await emptyTracker.read();
    assert.equal(result, null);
  });

  it('append() creates file if missing', async () => {
    const entry = makeEntry();
    await tracker.append(entry, 'test-project');

    const raw = await readFile(join(tmpDir, 'tako-progress.json'), 'utf-8');
    const file = JSON.parse(raw) as ProgressFile;
    assert.equal(file.version, 1);
    assert.equal(file.projectName, 'test-project');
    assert.equal(file.entries.length, 1);
    assert.equal(file.entries[0].sessionId, 'test-session-001');
  });

  it('append() adds to existing entries', async () => {
    const entry2 = makeEntry({ sessionId: 'test-session-002' });
    await tracker.append(entry2);

    const file = await tracker.read();
    assert.ok(file);
    assert.equal(file.entries.length, 2);
    assert.equal(file.entries[1].sessionId, 'test-session-002');
  });

  it('append() limits to 20 entries', async () => {
    // Create a fresh tracker in a new dir for this test
    const limitDir = await mkdtemp(join(tmpdir(), 'tako-progress-limit-'));
    const limitTracker = new ProgressTracker(limitDir);

    // Add 25 entries
    for (let i = 0; i < 25; i++) {
      await limitTracker.append(
        makeEntry({ sessionId: `session-${String(i).padStart(3, '0')}` }),
      );
    }

    const file = await limitTracker.read();
    assert.ok(file);
    assert.equal(file.entries.length, 20);
    // The first entry should be session-005 (after dropping oldest 5 through rolling window)
    // Actually: each append past 20 keeps last 19 + adds 1 = 20
    // Entry 20: keeps 1..19, adds 20 → [1..20]  → still 20
    // Entry 21: keeps 2..20, adds 21 → [2..21]  → 20
    // ...
    // Entry 24: keeps 5..23, adds 24 → [5..24] → 20
    assert.equal(file.entries[file.entries.length - 1].sessionId, 'session-024');

    await rm(limitDir, { recursive: true });
  });

  it('getRecent() returns correct count', async () => {
    const recent = await tracker.getRecent(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].sessionId, 'test-session-002');
  });

  it('getRecent() returns empty array when no file', async () => {
    const emptyTracker = new ProgressTracker(join(tmpDir, 'nonexistent'));
    const recent = await emptyTracker.getRecent(5);
    assert.deepEqual(recent, []);
  });

  it('getSummaryForContext() formats correctly', async () => {
    const summary = await tracker.getSummaryForContext(2);
    assert.ok(summary);
    assert.ok(summary.includes('## Recent Progress'));
    assert.ok(summary.includes('**Worked on:**'));
    assert.ok(summary.includes('feature-a'));
    assert.ok(summary.includes('**Files changed:**'));
    assert.ok(summary.includes('src/foo.ts'));
    assert.ok(summary.includes('**Decisions:**'));
    assert.ok(summary.includes('**Next steps:**'));
    assert.ok(summary.includes('**Commits:**'));
  });

  it('getSummaryForContext() returns null when no entries', async () => {
    const emptyTracker = new ProgressTracker(join(tmpDir, 'nonexistent'));
    const summary = await emptyTracker.getSummaryForContext();
    assert.equal(summary, null);
  });
});

// ─── Session Init Protocol ───────────────────────────────────────────

describe('buildSessionInitPrompt', () => {
  it('produces a structured init prompt', () => {
    const prompt = buildSessionInitPrompt();
    assert.ok(prompt.includes('## Session Init Protocol'));
    assert.ok(prompt.includes('tako-progress.json'));
    assert.ok(prompt.includes('git log'));
    assert.ok(prompt.includes('Pick ONE task'));
    assert.ok(prompt.includes('### Work Rules'));
    assert.ok(prompt.includes('### Do NOT'));
  });

  it('includes custom instructions when provided', () => {
    const prompt = buildSessionInitPrompt({ customInstructions: 'Always run lint first.' });
    assert.ok(prompt.includes('### Additional Instructions'));
    assert.ok(prompt.includes('Always run lint first.'));
  });
});

describe('buildSessionInitContext', () => {
  it('includes both init prompt and progress summary', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'tako-init-test-'));
    const tracker = new ProgressTracker(tmpDir);

    await tracker.append(makeEntry({ featuresWorkedOn: ['auth-system'] }), 'test');

    const context = await buildSessionInitContext(tracker);
    assert.ok(context.includes('## Session Init Protocol'));
    assert.ok(context.includes('## Recent Progress'));
    assert.ok(context.includes('auth-system'));

    await rm(tmpDir, { recursive: true });
  });

  it('works without progress entries', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'tako-init-empty-'));
    const tracker = new ProgressTracker(tmpDir);

    const context = await buildSessionInitContext(tracker);
    assert.ok(context.includes('## Session Init Protocol'));
    assert.ok(!context.includes('## Recent Progress'));

    await rm(tmpDir, { recursive: true });
  });
});
