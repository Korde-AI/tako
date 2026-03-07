/**
 * CLI: tako message — send messages via the daemon.
 */

import { getDaemonStatus } from '../daemon/pid.js';
import { WebSocket } from 'ws';

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function connectGateway(): Promise<{ ws: WebSocket; info: { bind: string; port: number } }> {
  const status = await getDaemonStatus();
  if (!status.running || !status.info) {
    console.error('Tako daemon is not running. Start it first: tako start -d');
    process.exit(1);
  }

  const { bind, port } = status.info;
  const ws = new WebSocket(`ws://${bind}:${port}`);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });

  return { ws, info: { bind, port } };
}

export async function runMessage(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'send': {
      const channel = getArg(args, '--channel');
      const target = getArg(args, '--target');
      const message = getArg(args, '--message');

      if (!channel || !target || !message) {
        console.error('Usage: tako message send --channel <type> --target <channelId> --message <text>');
        console.error('  Example: tako message send --channel discord --target 123456789 --message "Hello!"');
        process.exit(1);
      }

      const { ws } = await connectGateway();

      ws.send(JSON.stringify({
        type: 'chat',
        sessionId: `cli-message-${Date.now()}`,
        content: `[system] Send message to ${channel}/${target}: ${message}`,
      }));

      console.log(`Message sent to ${channel}/${target}`);
      ws.close();
      break;
    }

    case 'broadcast': {
      const message = getArg(args, '--message');
      if (!message) {
        console.error('Usage: tako message broadcast --message <text>');
        process.exit(1);
      }

      const { ws } = await connectGateway();

      ws.send(JSON.stringify({
        type: 'chat',
        sessionId: `cli-broadcast-${Date.now()}`,
        content: `[system] Broadcast to all channels: ${message}`,
      }));

      console.log('Broadcast message sent.');
      ws.close();
      break;
    }

    default:
      console.error('Usage: tako message <send|broadcast>');
      console.error('  send      Send a message to a specific channel');
      console.error('  broadcast Send a message to all channels');
      process.exit(1);
  }
}
