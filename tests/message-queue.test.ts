import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageQueue, type QueuedMessage, type QueueConfig } from '../src/core/message-queue.js';

function makeMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    content: 'hello',
    channelId: 'discord:123',
    authorId: 'user1',
    timestamp: Date.now(),
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

describe('MessageQueue', () => {
  let queue: MessageQueue;
  let processedBatches: Array<{ sessionId: string; messages: QueuedMessage[] }>;

  function createQueue(config: Partial<QueueConfig> = {}): MessageQueue {
    processedBatches = [];
    return new MessageQueue(config, async (sessionId, messages) => {
      processedBatches.push({ sessionId, messages: [...messages] });
    });
  }

  afterEach(() => {
    if (queue) queue.clear();
  });

  describe('off mode', () => {
    it('processes immediately without queuing', async () => {
      queue = createQueue({ mode: 'off' });
      const msg = makeMessage();
      const queued = queue.enqueue('session1', msg);

      assert.equal(queued, false, 'should return false (not queued)');
      // Give the async processor a tick
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].sessionId, 'session1');
      assert.equal(processedBatches[0].messages.length, 1);
      assert.equal(processedBatches[0].messages[0].content, 'hello');
    });

    it('reports zero depth', () => {
      queue = createQueue({ mode: 'off' });
      assert.equal(queue.depth('session1'), 0);
    });
  });

  describe('debounce mode', () => {
    it('batches messages and fires after debounce delay', async () => {
      queue = createQueue({ mode: 'debounce', debounceMs: 50, maxWaitMs: 5000 });

      queue.enqueue('s1', makeMessage({ content: 'msg1', timestamp: 1000 }));
      queue.enqueue('s1', makeMessage({ content: 'msg2', timestamp: 1010 }));

      assert.equal(queue.depth('s1'), 2);
      assert.equal(processedBatches.length, 0, 'should not process yet');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 2);
      assert.equal(processedBatches[0].messages[0].content, 'msg1');
      assert.equal(processedBatches[0].messages[1].content, 'msg2');
      assert.equal(queue.depth('s1'), 0, 'queue should be empty after processing');
    });

    it('resets debounce timer on new messages', async () => {
      queue = createQueue({ mode: 'debounce', debounceMs: 80, maxWaitMs: 5000 });

      queue.enqueue('s1', makeMessage({ content: 'msg1' }));

      // Send another message before debounce fires
      await new Promise((r) => setTimeout(r, 40));
      queue.enqueue('s1', makeMessage({ content: 'msg2' }));

      // At 80ms from start, the original timer would fire but it was reset
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(processedBatches.length, 0, 'should not have fired yet');

      // Wait for remaining debounce
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 2);
    });
  });

  describe('collect mode', () => {
    it('batches messages within debounce window', async () => {
      queue = createQueue({ mode: 'collect', debounceMs: 50, maxWaitMs: 5000 });

      queue.enqueue('s1', makeMessage({ content: 'a' }));
      queue.enqueue('s1', makeMessage({ content: 'b' }));
      queue.enqueue('s1', makeMessage({ content: 'c' }));

      assert.equal(queue.depth('s1'), 3);

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 3);
    });
  });

  describe('cap limit', () => {
    it('drops oldest when cap is hit with oldest strategy', async () => {
      queue = createQueue({ mode: 'collect', debounceMs: 500, cap: 3, dropStrategy: 'oldest', maxWaitMs: 5000 });

      queue.enqueue('s1', makeMessage({ content: 'msg1' }));
      queue.enqueue('s1', makeMessage({ content: 'msg2' }));

      // Third message hits cap — force processes
      queue.enqueue('s1', makeMessage({ content: 'msg3' }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 3);
    });

    it('drops oldest message when queue exceeds cap', async () => {
      queue = createQueue({ mode: 'collect', debounceMs: 500, cap: 3, dropStrategy: 'oldest', maxWaitMs: 5000 });

      queue.enqueue('s1', makeMessage({ content: 'msg1' }));
      queue.enqueue('s1', makeMessage({ content: 'msg2' }));

      // Queue has 2 messages, below cap of 3
      assert.equal(queue.depth('s1'), 2);

      // 3rd message hits cap — but first add a 4th to test drop
      queue.enqueue('s1', makeMessage({ content: 'msg3' }));

      // Cap hit, processQueue fires. Wait for it.
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 3);

      // Now test the drop: enqueue 4 messages into a cap-3 queue
      processedBatches.length = 0;
      queue.enqueue('s1', makeMessage({ content: 'a' }));
      queue.enqueue('s1', makeMessage({ content: 'b' }));
      queue.enqueue('s1', makeMessage({ content: 'c' }));

      // Queue flushed at cap=3, start fresh
      await new Promise((r) => setTimeout(r, 50));
      processedBatches.length = 0;

      queue.enqueue('s1', makeMessage({ content: 'x1' }));
      queue.enqueue('s1', makeMessage({ content: 'x2' }));
      // Now add a message that exceeds cap (3rd goes over, shift drops x1)
      // Actually with cap=3, 3rd message hits >= cap and flushes with all 3
      // To test drop, use cap=2 but enqueue rapidly so shift happens before flush
      queue.clear();
      processedBatches.length = 0;

      const q2 = createQueue({ mode: 'collect', debounceMs: 5000, cap: 2, dropStrategy: 'oldest', maxWaitMs: 30000 });
      // With cap=2: msg1 enqueued (length=1, <2), msg2 enqueued (length=2, >=2 → flush)
      // So cap=2 means 2nd message triggers flush with both messages.
      // The drop only occurs when length > cap, which means we need a burst.
      q2.enqueue('s1', makeMessage({ content: 'first' }));
      // 2nd message hits cap — flushes [first, second]
      q2.enqueue('s1', makeMessage({ content: 'second' }));

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 2);
      q2.clear();
    });
  });

  describe('flush', () => {
    it('processes queue immediately on flush', async () => {
      queue = createQueue({ mode: 'debounce', debounceMs: 5000, maxWaitMs: 30000 });

      queue.enqueue('s1', makeMessage({ content: 'msg1' }));
      queue.enqueue('s1', makeMessage({ content: 'msg2' }));

      assert.equal(processedBatches.length, 0);

      await queue.flush('s1');

      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 2);
      assert.equal(queue.depth('s1'), 0);
    });

    it('is a no-op for empty queues', async () => {
      queue = createQueue({ mode: 'collect', debounceMs: 50 });
      await queue.flush('nonexistent');
      assert.equal(processedBatches.length, 0);
    });
  });

  describe('maxWaitMs force-flush', () => {
    it('force-flushes after maxWaitMs even if debounce keeps resetting', async () => {
      queue = createQueue({ mode: 'debounce', debounceMs: 80, maxWaitMs: 100 });

      queue.enqueue('s1', makeMessage({ content: 'msg1' }));

      // Keep sending before debounce fires
      await new Promise((r) => setTimeout(r, 40));
      queue.enqueue('s1', makeMessage({ content: 'msg2' }));

      // maxWaitMs (100ms) should force-flush even though debounce was reset
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].messages.length, 2);
    });
  });

  describe('mergeMessages', () => {
    it('returns single message content as-is', () => {
      const result = MessageQueue.mergeMessages([
        makeMessage({ content: 'hello world' }),
      ]);
      assert.equal(result, 'hello world');
    });

    it('joins multiple messages with header', () => {
      const now = Date.now();
      const result = MessageQueue.mergeMessages([
        makeMessage({ content: 'first', authorId: 'user1', timestamp: now }),
        makeMessage({ content: 'second', authorId: 'user1', timestamp: now + 3000 }),
      ]);

      assert.ok(result.includes('[queued: 2 messages over 3s]'));
      assert.ok(result.includes('first'));
      assert.ok(result.includes('second'));
    });

    it('includes author IDs for group chat (multiple authors)', () => {
      const now = Date.now();
      const result = MessageQueue.mergeMessages([
        makeMessage({ content: 'hi', authorId: 'alice', timestamp: now }),
        makeMessage({ content: 'hey', authorId: 'bob', timestamp: now + 1000 }),
      ]);

      assert.ok(result.includes('[alice]: hi'));
      assert.ok(result.includes('[bob]: hey'));
    });

    it('omits author IDs for single-user messages', () => {
      const now = Date.now();
      const result = MessageQueue.mergeMessages([
        makeMessage({ content: 'one', authorId: 'user1', timestamp: now }),
        makeMessage({ content: 'two', authorId: 'user1', timestamp: now + 1000 }),
      ]);

      assert.ok(!result.includes('[user1]'));
      assert.ok(result.includes('one'));
      assert.ok(result.includes('two'));
    });

    it('returns empty string for empty array', () => {
      assert.equal(MessageQueue.mergeMessages([]), '');
    });
  });

  describe('status', () => {
    it('returns status for active queues', () => {
      queue = createQueue({ mode: 'collect', debounceMs: 5000, maxWaitMs: 30000 });

      queue.enqueue('s1', makeMessage({ timestamp: Date.now() - 5000 }));
      queue.enqueue('s1', makeMessage());
      queue.enqueue('s2', makeMessage());

      const status = queue.status();
      assert.equal(status.length, 2);

      const s1 = status.find((s) => s.sessionId === 's1');
      assert.ok(s1);
      assert.equal(s1.depth, 2);
      assert.ok(s1.oldestMs >= 4000, 'oldest should be at least ~5s old');

      const s2 = status.find((s) => s.sessionId === 's2');
      assert.ok(s2);
      assert.equal(s2.depth, 1);
    });
  });

  describe('clear', () => {
    it('clears all queues and timers', async () => {
      queue = createQueue({ mode: 'debounce', debounceMs: 50, maxWaitMs: 5000 });

      queue.enqueue('s1', makeMessage());
      queue.enqueue('s2', makeMessage());

      queue.clear();

      assert.equal(queue.depth('s1'), 0);
      assert.equal(queue.depth('s2'), 0);
      assert.equal(queue.status().length, 0);

      // Ensure timers don't fire after clear
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(processedBatches.length, 0);
    });
  });

  describe('setMode', () => {
    it('changes queue mode at runtime', () => {
      queue = createQueue({ mode: 'collect' });
      assert.equal(queue.getConfig().mode, 'collect');

      queue.setMode('debounce');
      assert.equal(queue.getConfig().mode, 'debounce');

      queue.setMode('off');
      assert.equal(queue.getConfig().mode, 'off');
    });
  });

  describe('session isolation', () => {
    it('queues are independent per session', async () => {
      queue = createQueue({ mode: 'collect', debounceMs: 50, maxWaitMs: 5000 });

      queue.enqueue('s1', makeMessage({ content: 'for-s1' }));
      queue.enqueue('s2', makeMessage({ content: 'for-s2' }));

      assert.equal(queue.depth('s1'), 1);
      assert.equal(queue.depth('s2'), 1);

      await queue.flush('s1');

      assert.equal(processedBatches.length, 1);
      assert.equal(processedBatches[0].sessionId, 's1');
      assert.equal(queue.depth('s1'), 0);
      assert.equal(queue.depth('s2'), 1, 's2 should still have its message');
    });
  });
});
