/**
 * SandboxManager — manages Docker-based sandboxed execution environments.
 *
 * Creates and tracks containers keyed by scope (session, agent, or shared).
 * Routes tool execution through the appropriate container when sandboxing
 * is active. Falls back to host execution when sandboxing is off or
 * Docker is unavailable.
 */

import { DockerContainer, type ContainerExecResult } from './container.js';
import type { SandboxConfig, SandboxMode } from './config.js';
import { DEFAULT_SANDBOX_CONFIG } from './config.js';

/** Status snapshot of the sandbox system. */
export interface SandboxStatus {
  mode: SandboxMode;
  dockerAvailable: boolean;
  activeContainers: number;
  containers: Array<{
    key: string;
    id: string | null;
    name: string;
    running: boolean;
  }>;
}

/**
 * SandboxManager — lifecycle management for sandboxed tool execution.
 *
 * Usage:
 * 1. Initialize with config
 * 2. Call shouldSandbox(sessionId, isMain) to check if a session needs sandboxing
 * 3. Call getOrCreateContainer(key) to get a container for the session/agent
 * 4. Call execInSandbox(key, command, timeout) to run commands
 * 5. Call destroyContainer(key) when session ends
 * 6. Call shutdown() on process exit
 */
export class SandboxManager {
  private config: SandboxConfig;
  private containers = new Map<string, DockerContainer>();
  private dockerAvailable: boolean | null = null;

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /** Get the current sandbox mode. */
  getMode(): SandboxMode {
    return this.config.mode;
  }

  /** Get the full config (read-only snapshot). */
  getConfig(): Readonly<SandboxConfig> {
    return { ...this.config };
  }

  /** Check if Docker is available (caches result). */
  async checkDocker(): Promise<boolean> {
    if (this.dockerAvailable === null) {
      this.dockerAvailable = await DockerContainer.isDockerAvailable();
    }
    return this.dockerAvailable;
  }

  /**
   * Determine if a given session should be sandboxed.
   *
   * @param isMainSession - true for the primary CLI session
   * @returns true if tool execution should go through a container
   */
  shouldSandbox(isMainSession: boolean): boolean {
    if (this.config.mode === 'off') return false;
    if (this.config.mode === 'all') return true;
    // 'non-main' — only sandbox spawned/non-main sessions
    return !isMainSession;
  }

  /**
   * Resolve the container key based on scope.
   *
   * - 'session' scope: one container per session
   * - 'agent' scope: one container per agent (future; uses sessionId for now)
   * - 'shared' scope: single container for all sandboxed sessions
   */
  resolveKey(sessionId: string): string {
    switch (this.config.scope) {
      case 'shared':
        return 'shared';
      case 'agent':
        return `agent-${sessionId}`;
      case 'session':
      default:
        return `session-${sessionId}`;
    }
  }

  /**
   * Get or create a container for the given key.
   * Returns the DockerContainer instance (already started).
   */
  async getOrCreateContainer(key: string, workspacePath?: string): Promise<DockerContainer> {
    const existing = this.containers.get(key);
    if (existing) {
      const running = await existing.isRunning();
      if (running) return existing;
      // Container exists but isn't running — recreate
      await existing.destroy();
      this.containers.delete(key);
    }

    const container = new DockerContainer({
      name: key,
      dockerConfig: this.config.docker ?? {},
      workspaceAccess: this.config.workspaceAccess,
      workspacePath,
    });

    await container.create();
    this.containers.set(key, container);
    return container;
  }

  /**
   * Execute a command in the sandbox container for the given key.
   * The container is created if it doesn't exist yet.
   */
  async execInSandbox(
    key: string,
    command: string,
    timeout?: number,
    workspacePath?: string,
  ): Promise<ContainerExecResult> {
    const container = await this.getOrCreateContainer(key, workspacePath);
    return container.exec(command, timeout);
  }

  /** Destroy a specific container by key. */
  async destroyContainer(key: string): Promise<void> {
    const container = this.containers.get(key);
    if (!container) return;
    await container.destroy();
    this.containers.delete(key);
  }

  /** Get the status of the sandbox system. */
  async getStatus(): Promise<SandboxStatus> {
    const dockerAvailable = await this.checkDocker();
    const containerInfos: SandboxStatus['containers'] = [];

    for (const [key, container] of this.containers) {
      const running = await container.isRunning();
      containerInfos.push({
        key,
        id: container.getId(),
        name: container.getName(),
        running,
      });
    }

    return {
      mode: this.config.mode,
      dockerAvailable,
      activeContainers: containerInfos.filter((c) => c.running).length,
      containers: containerInfos,
    };
  }

  /**
   * Explain why a tool would be allowed or blocked in sandbox context.
   * Returns a human-readable explanation string.
   */
  explain(toolName: string, isMainSession: boolean): string {
    const lines: string[] = [];
    lines.push(`Sandbox explanation for tool "${toolName}":`);
    lines.push(`  Mode: ${this.config.mode}`);
    lines.push(`  Session type: ${isMainSession ? 'main' : 'spawned'}`);

    if (this.config.mode === 'off') {
      lines.push(`  Result: Tool runs on HOST (sandboxing is off)`);
    } else if (this.config.mode === 'all') {
      lines.push(`  Result: Tool runs in SANDBOX (all sessions sandboxed)`);
    } else {
      if (isMainSession) {
        lines.push(`  Result: Tool runs on HOST (main session not sandboxed in "non-main" mode)`);
      } else {
        lines.push(`  Result: Tool runs in SANDBOX (non-main session)`);
      }
    }

    lines.push(`  Workspace access: ${this.config.workspaceAccess}`);
    lines.push(`  Container scope: ${this.config.scope}`);
    lines.push(`  Docker image: ${this.config.docker?.image ?? 'default'}`);
    lines.push(`  Network: ${this.config.docker?.network ?? 'none'}`);

    return lines.join('\n');
  }

  /** Shut down all managed containers. */
  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [key, container] of this.containers) {
      promises.push(
        container.destroy().then(() => {
          this.containers.delete(key);
        }),
      );
    }
    await Promise.all(promises);
  }
}
