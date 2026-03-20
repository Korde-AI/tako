import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseGitHubRepo } from '../src/tools/github.js';

describe('parseGitHubRepo', () => {
  it('parses GitHub URLs and slugs', () => {
    assert.deepEqual(parseGitHubRepo('https://github.com/Korde-AI/OttoOS'), {
      owner: 'Korde-AI',
      repo: 'OttoOS',
    });
    assert.deepEqual(parseGitHubRepo('Korde-AI/OttoOS'), {
      owner: 'Korde-AI',
      repo: 'OttoOS',
    });
    assert.equal(parseGitHubRepo('https://example.com/nope'), null);
  });
});
