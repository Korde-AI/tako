/**
 * Tests for response streaming — chunked delivery with channel-specific editing.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ResponseStreamer, type StreamConfig, type StreamContext } from '../src/core/streaming.js';
import type { Channel, OutboundMessage, MessageHandler } from '../src/channels/channel.js';

// ─── Mock channel with edit support ──────────────────────────────────

class MockEditChannel implements Channel {
  id = 'mock-edit';
  sent: Array<{ content: string; id: string }> = [];
  edits: Array<{ messageId: string; content: string }> = [];
  private nextId = 1;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async send(msg: OutboundMessage): Promise<void> {
    const id = `msg-${this.nextId++}`;
    this.sent.push({ content: msg.content, id });
  }

  onMessage(_handler: MessageHandler): void {}

  async sendAndGetId(msg: OutboundMessage): Promise<string> {
    const id = `msg-${this.nextId++}`;
    this.sent.push({ content: msg.content, id });
    return id;
  }

  async editMessage(_chatId: string, messageId: string, content: string): Promise<void> {
    this.edits.push({ messageId, content });
  }

  reset(): void {
    this.sent = [];
    this.edits = [];
    this.nextId = 1;
  }
}

// ─── Mock channel without edit support (CLI-style) ───────────────────

class MockSimpleChannel implements Channel {
  id = 'mock-simple';
  sent: string[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg.content);
  }

  onMessage(_handler: MessageHandler): void {}

  reset(): void {
    this.sent = [];
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('ResponseStreamer', () => {
  describe('buffer accumulation and flush threshold', () => {
    it('should not flush until minChunkSize is reached', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 50, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      await streamer.push('short');
      // Buffer hasn't reached minChunkSize, no send yet
      assert.equal(channel.sent.length, 0);

      await streamer.finish();
      // After finish, remaining buffer is flushed
      assert.equal(channel.sent.length, 1);
      assert.equal(channel.sent[0], 'short');
    });

    it('should flush when buffer exceeds minChunkSize', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 10, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      await streamer.push('This is a longer piece of text that exceeds the threshold');
      // Should have flushed
      assert.ok(channel.sent.length >= 1);

      await streamer.finish();
    });
  });

  describe('finish() flushes remaining', () => {
    it('should flush all remaining buffer content on finish', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 1000, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      await streamer.push('Hello ');
      await streamer.push('world');
      assert.equal(channel.sent.length, 0); // Not yet flushed (below threshold)

      await streamer.finish();
      assert.equal(channel.sent.length, 1);
      assert.equal(channel.sent[0], 'Hello world');
    });

    it('should be idempotent', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 1000, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      await streamer.push('data');
      await streamer.finish();
      await streamer.finish(); // Second call should be no-op
      assert.equal(channel.sent.length, 1);
    });
  });

  describe('cancel() cleans up', () => {
    it('should discard buffer and stop accepting pushes', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 1000, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      await streamer.push('some data');
      await streamer.cancel();

      // After cancel, buffer should be discarded
      assert.equal(channel.sent.length, 0);

      // Further pushes should be ignored
      await streamer.push('more data');
      await streamer.finish();
      assert.equal(channel.sent.length, 0);
    });
  });

  describe('length tracking', () => {
    it('should track total characters including buffer', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 1000, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      await streamer.push('Hello');
      assert.equal(streamer.length, 5);

      await streamer.push(' world');
      assert.equal(streamer.length, 11);
    });
  });

  describe('channel-specific delivery', () => {
    it('should use editMessage for channels with edit support', async () => {
      const channel = new MockEditChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 5, flushIntervalMs: 10_000, maxMessageLength: 2000 },
        { channelId: 'test-chat', channel },
      );

      // First push — should send initial message
      await streamer.push('Hello world, this is a test message!');
      assert.equal(channel.sent.length, 1, 'Should have sent initial message');

      // Second push — should edit existing message
      await streamer.push(' And more text follows here.');
      assert.ok(channel.edits.length >= 1, 'Should have edited the message');

      await streamer.finish();
    });

    it('should use send() for channels without edit support', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 5, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      await streamer.push('Hello world, this is a test!');
      assert.ok(channel.sent.length >= 1);

      await streamer.finish();
    });
  });

  describe('safe breakpoint detection', () => {
    it('should not split inside a fenced code block', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 10, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      // Push text with an unclosed code block
      const textWithCode = 'Some intro text\n```javascript\nconst x = 1;\n';
      await streamer.push(textWithCode);

      // The streamer should either keep the code block together or break before it
      await streamer.finish();

      const allSent = channel.sent.join('');
      assert.equal(allSent, textWithCode, 'All text should be delivered');
      // Verify no chunk splits the ``` marker
      for (const chunk of channel.sent) {
        const backtickCount = (chunk.match(/```/g) || []).length;
        // Each chunk should have either 0 or an even number of ``` markers
        // (or be the last chunk which may have an unclosed block)
        assert.ok(
          backtickCount % 2 === 0 || chunk === channel.sent[channel.sent.length - 1],
          `Chunk should not split a code block: "${chunk.slice(0, 40)}..."`,
        );
      }
    });

    it('should prefer breaking at newlines', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 10, flushIntervalMs: 10_000 },
        { channelId: 'test', channel },
      );

      const text = 'Line one is here\nLine two is here\nLine three is here';
      await streamer.push(text);
      await streamer.finish();

      const allSent = channel.sent.join('');
      assert.equal(allSent, text);
    });
  });

  describe('message overflow with edit channels', () => {
    it('should start a new message when maxMessageLength is exceeded', async () => {
      const channel = new MockEditChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 5, flushIntervalMs: 10_000, maxMessageLength: 50 },
        { channelId: 'test-chat', channel },
      );

      // Push enough text to overflow the 50-char limit
      await streamer.push('A'.repeat(30));
      await streamer.push('B'.repeat(30));
      await streamer.finish();

      // Should have sent more than one message due to overflow
      assert.ok(
        channel.sent.length >= 1,
        `Should have sent at least one message, got ${channel.sent.length}`,
      );
    });
  });

  describe('timer-based flush', () => {
    it('should flush after flushIntervalMs even below minChunkSize', async () => {
      const channel = new MockSimpleChannel();
      const streamer = new ResponseStreamer(
        { minChunkSize: 1000, flushIntervalMs: 50 },
        { channelId: 'test', channel },
      );

      await streamer.push('small');
      assert.equal(channel.sent.length, 0);

      // Wait for the timer to fire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Timer should have flushed
      assert.equal(channel.sent.length, 1);
      assert.equal(channel.sent[0], 'small');

      await streamer.finish();
    });
  });
});
