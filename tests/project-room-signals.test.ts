import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectProjectRoomSignal } from '../src/projects/room-signals.js';

describe('detectProjectRoomSignal', () => {
  it('detects progress updates', () => {
    const signal = detectProjectRoomSignal('Progress update: finished the API integration and next step is tests.');
    assert.deepEqual(signal?.kind, 'progress');
    assert.match(signal?.summary ?? '', /finished the API integration/i);
  });

  it('detects rebuttals and blockers', () => {
    const signal = detectProjectRoomSignal('I disagree with this approach because it creates a blocker for the deploy path.');
    assert.deepEqual(signal?.kind, 'rebuttal');
    assert.match(signal?.summary ?? '', /blocker/i);
  });

  it('ignores ordinary chat', () => {
    assert.equal(detectProjectRoomSignal('hello there'), null);
  });
});
