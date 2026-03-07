/**
 * TUI Bridge — EventEmitter-based communication between TUIChannel and Ink app.
 *
 * Replaces the globalThis.__takoTui hack with a proper typed EventEmitter.
 */

import { EventEmitter } from 'node:events';
import type { ChatMessage } from './components/MessageList.js';

/** Events emitted by the TUI bridge. */
export interface TuiBridgeEvents {
  /** A new message to display in the chat */
  message: [msg: ChatMessage];
  /** Clear all messages */
  clear: [];
  /** Set the processing/thinking state */
  processing: [isProcessing: boolean];
  /** Update token usage display */
  tokenUsage: [usage: { input: number; output: number }];
}

/**
 * Typed EventEmitter for TUI ↔ Channel communication.
 *
 * The TUIChannel calls emit() to push data into the Ink app.
 * The Ink app subscribes with on() to receive updates.
 */
class TuiBridge extends EventEmitter {
  addMessage(msg: ChatMessage): void {
    this.emit('message', msg);
  }

  clearMessages(): void {
    this.emit('clear');
  }

  setIsProcessing(processing: boolean): void {
    this.emit('processing', processing);
  }

  setTokenUsage(usage: { input: number; output: number }): void {
    this.emit('tokenUsage', usage);
  }
}

/** Singleton bridge instance shared between TUIChannel and Ink app. */
export const tuiBridge = new TuiBridge();
