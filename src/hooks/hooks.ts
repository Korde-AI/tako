/**
 * HookSystem implementation — simple event emitter for lifecycle hooks.
 */

import type { HookEvent, HookContext, HookHandler, HookSystem } from './types.js';

export class TakoHookSystem implements HookSystem {
  private handlers = new Map<HookEvent, HookHandler[]>();

  /** Register a handler for a lifecycle event. */
  on(event: HookEvent, handler: HookHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  /** Remove a previously registered handler. */
  off(event: HookEvent, handler: HookHandler): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Emit an event, invoking all registered handlers in registration order. */
  async emit(event: HookEvent, ctx: HookContext): Promise<void> {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const handler of list) {
      await handler(ctx);
    }
  }

  /** Remove all handlers for a given event (or all events). */
  clear(event?: HookEvent): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  /** Get the count of registered handlers for an event. */
  listenerCount(event: HookEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}
