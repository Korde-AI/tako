/**
 * CLI channel — terminal/stdin adapter.
 *
 * The simplest channel: reads from stdin, writes to stdout.
 * Properly awaits async message handlers and re-prompts after completion.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Channel, InboundMessage, OutboundMessage, MessageHandler } from './channel.js';

export class CLIChannel implements Channel {
  id = 'cli';
  private rl: ReadlineInterface | null = null;
  private handlers: MessageHandler[] = [];
  private promptStr: string;
  private busy = false;

  constructor(opts?: { prompt?: string }) {
    this.promptStr = opts?.prompt ?? 'tako> ';
  }

  async connect(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.promptStr,
    });

    this.rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.showPrompt();
        return;
      }

      // Prevent overlapping handler executions
      if (this.busy) return;
      this.busy = true;

      const msg: InboundMessage = {
        id: crypto.randomUUID(),
        channelId: 'cli',
        author: { id: 'local', name: 'user' },
        content: trimmed,
        timestamp: new Date().toISOString(),
      };

      try {
        for (const handler of this.handlers) {
          await handler(msg);
        }
      } catch (err) {
        console.error('[tako] Error:', err instanceof Error ? err.message : err);
      } finally {
        this.busy = false;
        this.showPrompt();
      }
    });

    this.rl.on('close', () => {
      // Only exit if CLI is the sole channel (no Discord/Telegram).
      // In Docker or daemon mode, stdin closes immediately — don't kill the process.
      if (!process.env['TAKO_KEEP_ALIVE']) {
        process.exit(0);
      }
    });

    this.showPrompt();
  }

  /** Display the prompt. */
  showPrompt(): void {
    this.rl?.prompt();
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    process.stdout.write(msg.content + '\n');
  }

  /**
   * Send a message and return a synthetic ID.
   * CLI doesn't have real message IDs, but this enables the streaming
   * interface. Subsequent editMessage calls overwrite the current line.
   */
  async sendAndGetId(msg: OutboundMessage): Promise<string> {
    process.stdout.write(msg.content);
    return 'cli-stream';
  }

  /**
   * Edit the current streaming message by clearing and rewriting.
   * For CLI, we use carriage return to overwrite the current output.
   */
  async editMessage(_chatId: string, _messageId: string, content: string): Promise<void> {
    // Move cursor to start of line, clear, and rewrite
    process.stdout.write('\r\x1b[K' + content);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }
}
