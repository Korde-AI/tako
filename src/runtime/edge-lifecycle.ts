import { readFileSync, unlinkSync } from 'node:fs';
import { resolveConfig } from '../config/resolve.js';
import { removePidFile } from '../daemon/pid.js';
import type { Channel } from '../channels/channel.js';
import type { TakoConfig } from '../config/schema.js';
import type { TakoPaths } from '../core/paths.js';
import type { ToolRegistry } from '../tools/registry.js';
import { registerCronToolPack } from '../core/tool-composition.js';
import { CronScheduler } from '../core/cron.js';
import type { SessionManager } from '../gateway/session.js';
import type { ThreadBindingManager } from '../core/thread-bindings.js';
import type { SkillLoader } from '../skills/loader.js';
import type { Gateway } from '../gateway/gateway.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { HookSystem } from '../hooks/types.js';

interface EdgeLifecycleInput {
  config: TakoConfig;
  runtimePaths: TakoPaths;
  version: string;
  resolvedProviderLabel: string;
  embeddingProvider: unknown;
  channels: Channel[];
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistry;
  skillLoader: SkillLoader;
  sessions: SessionManager;
  threadBindings: ThreadBindingManager;
  messageQueue: { clear(): void };
  deliveryQueue: { stop(): void };
  gateway: Gateway;
  agentLoop: AgentLoop;
  hooks: HookSystem;
  getActiveToolCount(): number;
  stopHubHeartbeat: () => void;
  stopNetworkPolling: () => void;
  acpSessionManager: { shutdown(): Promise<void> };
  sandboxManager: { shutdown(): Promise<void> };
}

export interface EdgeLifecycleRuntime {
  shutdown(): Promise<void>;
}

export async function startEdgeLifecycle(input: EdgeLifecycleInput): Promise<EdgeLifecycleRuntime> {
  const blockingIds = new Set(['cli', 'tui']);

  const cronScheduler = new CronScheduler();
  cronScheduler.setHandlers({
    agentTurn: async (message: string) => {
      const cronSession = input.sessions.create({ name: 'cron', metadata: { isCron: true } });
      let response = '';
      for await (const chunk of input.agentLoop.run(cronSession, message)) {
        response += chunk;
      }
      return response;
    },
    systemEvent: (text: string) => {
      const mainSession = input.sessions.get('main') ?? input.sessions.create({ name: 'main' });
      input.sessions.addMessage(mainSession.id, { role: 'system', content: text });
    },
    delivery: (result, delivery) => {
      if (delivery.mode === 'announce' && delivery.channel) {
        const channel = input.channels.find((candidate) => candidate.id === delivery.channel || candidate.id.startsWith(delivery.channel!));
        if (channel) {
          channel.send({ target: delivery.to ?? '', content: `📋 **${result.jobName}**\n${result.response.slice(0, 1500)}` });
        }
      }
    },
  });
  registerCronToolPack({
    toolRegistry: input.toolRegistry,
    cronScheduler,
  });
  await cronScheduler.start();

  const idleSweepTimer = setInterval(async () => {
    const expired = input.sessions.sweepIdle();
    let archivedCount = 0;
    for (const session of expired) {
      const isSubAgent = session.metadata.isSubAgent as boolean | undefined;
      const isAcp = session.metadata.isAcp as boolean | undefined;
      if (!isSubAgent && !isAcp) continue;

      const channelType = session.metadata.channelType as string | undefined;
      const target = session.metadata.channelTarget as string | undefined;
      if (channelType && target) {
        const channel = input.channels.find((candidate) => candidate.id === channelType);
        if (channel) {
          await channel.send({
            target,
            content: '⚙️ Session ended automatically after 24h of inactivity.',
          }).catch(() => {});
        }
      }
      input.sessions.archiveSession(session.id);
      archivedCount++;
    }
    if (archivedCount > 0) {
      console.log(`[tako] Archived ${archivedCount} idle sub-agent/ACP session(s)`);
    }

    const expiredBindings = input.threadBindings.sweepExpired();
    for (const binding of expiredBindings) {
      const discordChannel = input.channels.find((channel) => channel.id === 'discord');
      if (discordChannel) {
        await discordChannel.send({
          target: binding.threadId,
          content: '⚙️ Session ended automatically after 24h of inactivity. Messages here will no longer be routed.',
        }).catch(() => {});

        if ('archiveThread' in discordChannel && typeof (discordChannel as any).archiveThread === 'function') {
          await (discordChannel as any).archiveThread(binding.threadId).catch(() => {});
        }
      }
    }
    if (expiredBindings.length > 0) {
      await input.threadBindings.save();
      console.log(`[tako] Swept ${expiredBindings.length} expired thread binding(s)`);
    }
  }, 120_000);

  let rotationTimeout: ReturnType<typeof setTimeout> | null = null;
  const scheduleNextRotation = () => {
    const now = new Date();
    const next4am = new Date(now);
    next4am.setHours(4, 0, 0, 0);
    if (next4am <= now) {
      next4am.setDate(next4am.getDate() + 1);
    }
    const delay = next4am.getTime() - now.getTime();
    console.log(`[tako] Next session rotation at 4:00 AM (in ${Math.round(delay / 60000)}min)`);

    rotationTimeout = setTimeout(async () => {
      console.log('[tako] Running daily 4 AM session rotation...');
      try {
        const result = await input.sessions.rotateAllSessions();
        console.log(`[tako] Rotated: ${result.archived.length} archived, ${result.created.length} created`);
      } catch (err) {
        console.error('[tako] Rotation error:', err instanceof Error ? err.message : err);
      }
      scheduleNextRotation();
    }, delay);
  };
  scheduleNextRotation();

  const broadcastToChannels = async (text: string, includeAgentChannels = false): Promise<void> => {
    for (const channel of input.channels) {
      if (blockingIds.has(channel.id)) continue;
      if (!includeAgentChannels && channel.agentId) continue;
      try {
        if (channel.broadcast) {
          await channel.broadcast(text);
        }
      } catch {
        // Channel may not be connected yet.
      }
    }
  };

  const shutdown = async () => {
    console.log('\n[tako] Shutting down...');
    console.log('⚙️ Tako going offline.');

    clearInterval(idleSweepTimer);
    if (rotationTimeout) clearTimeout(rotationTimeout);
    input.stopHubHeartbeat();
    input.stopNetworkPolling();
    input.messageQueue.clear();
    await input.threadBindings.save();
    cronScheduler.stop();
    input.skillLoader.stopWatching();
    input.deliveryQueue.stop();
    for (const channel of input.channels) {
      await channel.disconnect().catch(() => {});
    }
    await input.gateway.stop();
    await input.acpSessionManager.shutdown();
    await input.sandboxManager.shutdown();
    await input.sessions.shutdown();
    await removePidFile();
  };

  process.on('SIGUSR1', async () => {
    console.log('[tako] Received SIGUSR1 — reloading config...');
    try {
      const newConfig = await resolveConfig();
      if (newConfig.providers.primary !== input.config.providers.primary) {
        input.agentLoop.setModel(newConfig.providers.primary);
        input.config.providers.primary = newConfig.providers.primary;
        console.log(`[tako] Model updated to: ${newConfig.providers.primary}`);
      }
      if (newConfig.tools.profile !== input.config.tools.profile) {
        input.toolRegistry.setProfile(newConfig.tools.profile);
        input.config.tools.profile = newConfig.tools.profile;
        console.log(`[tako] Tool profile updated to: ${newConfig.tools.profile}`);
      }
      const newManifests = await input.skillLoader.discover();
      for (const manifest of newManifests) {
        const loaded = await input.skillLoader.load(manifest);
        input.skillLoader.registerTools(loaded, input.toolRegistry);
        input.skillLoader.registerHooks(loaded, input.hooks);
      }
      console.log(`[tako] Config reload complete. Skills: ${newManifests.length}`);

      input.gateway.setStatusInfo({
        model: input.config.providers.primary,
        tools: input.getActiveToolCount(),
        skills: newManifests.length,
        channels: input.channels.map((channel) => channel.id),
      });
    } catch (err) {
      console.error('[tako] Config reload failed:', err instanceof Error ? err.message : err);
    }
  });

  process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
  process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });

  const embeddingStatus = input.embeddingProvider ? 'vector+BM25' : 'BM25-only';
  const channelNames = input.channels.map((channel) => channel.id).join(', ');
  const loadedSkillNames = input.skillLoader.getAll().map((skill) => skill.manifest.name);
  const hasTui = input.channels.some((channel) => channel.id === 'tui');

  if (!hasTui) {
    console.log(`Tako 🐙 v${input.version}`);
    console.log(`Provider: ${input.resolvedProviderLabel}`);
    console.log(`Tools: ${input.getActiveToolCount()} active (profile: ${input.config.tools.profile})`);
    console.log(`Memory: ${embeddingStatus}`);
    console.log(`Skills: ${loadedSkillNames.length} loaded (${loadedSkillNames.join(', ') || 'none'})`);
    console.log(`Channels: ${channelNames}`);
    console.log(`Sandbox: ${input.config.sandbox.mode}${input.config.sandbox.mode !== 'off' ? ` (scope: ${input.config.sandbox.scope}, workspace: ${input.config.sandbox.workspaceAccess})` : ''}`);
    console.log(`Agents: ${input.agentRegistry.list().length} registered (${input.agentRegistry.list().map((agent) => agent.id).join(', ')})`);
    console.log(`Gateway: ws://${input.config.gateway.bind}:${input.config.gateway.port}`);
    console.log('Type /quit to exit.\n');
  }

  for (const channel of input.channels) {
    if (!blockingIds.has(channel.id)) {
      try {
        await channel.connect();
      } catch (err) {
        console.error(`[${channel.id}] ✗ Failed to connect: ${err instanceof Error ? err.message : err}`);
        console.error(`[${channel.id}]   Check your token/config with \`tako onboard\``);
      }
    }
  }

  const hasExternalChannels = input.channels.some((channel) => !blockingIds.has(channel.id));
  if (hasExternalChannels) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(`🐙 Tako online — model: ${input.config.providers.primary}`);

  try {
    const raw = readFileSync(input.runtimePaths.restartNoteFile, 'utf-8');
    const restartNote = JSON.parse(raw) as { note: string; channelId?: string; agentId?: string };
    unlinkSync(input.runtimePaths.restartNoteFile);

    const noteText = `⚙️ ${restartNote.note}`;
    console.log(`[tako] Post-restart: ${restartNote.note}`);

    let delivered = false;
    if (restartNote.channelId) {
      const targetAgentId = restartNote.agentId || 'main';
      const agentChannel = input.channels.find((channel) => channel.agentId === targetAgentId && !blockingIds.has(channel.id))
        ?? input.channels.find((channel) => !blockingIds.has(channel.id));
      if (agentChannel?.sendToChannel) {
        try {
          await agentChannel.sendToChannel(restartNote.channelId, noteText);
          delivered = true;
        } catch (err) {
          console.warn('[tako] Failed to deliver restart note to originating channel:', err);
        }
      }
    }
    if (!delivered) {
      await broadcastToChannels(noteText);
    }
  } catch {
    // no restart note
  }

  const blockingChannel = input.channels.find((channel) => blockingIds.has(channel.id));
  if (blockingChannel) {
    await blockingChannel.connect();
  }

  return { shutdown };
}
