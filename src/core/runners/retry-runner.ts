import type { Session, SessionManager } from '../../gateway/session.js';
import type { RetryQueue } from '../retry-queue.js';

export function configureRetryRunner(input: {
  retryQueue: RetryQueue;
  sessions: SessionManager;
  runSession: (session: Session, userMessage: string) => AsyncIterable<string>;
}): void {
  input.retryQueue.setRunner(async (sessionId, userMessage) => {
    const session = input.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found for retry`);
    let result = '';
    for await (const chunk of input.runSession(session, userMessage)) {
      result += chunk;
    }
    return result;
  });
}
