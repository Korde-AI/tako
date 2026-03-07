/**
 * Docker container operations — create, start, exec, stop, remove.
 *
 * Uses shell commands (docker CLI) to avoid a heavy dockerode dependency.
 * All operations are async and throw on failure.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { DockerConfig, WorkspaceAccess } from './config.js';

const execAsync = promisify(execCb);

/** Result of executing a command inside a container. */
export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Represents a managed Docker container. */
export interface ContainerInfo {
  /** Docker container ID (short hash). */
  id: string;
  /** Container name. */
  name: string;
  /** Whether the container is currently running. */
  running: boolean;
}

/**
 * Docker container lifecycle operations.
 *
 * Wraps the Docker CLI to create, manage, and remove sandbox containers.
 * No network by default. Workspace mounted based on access level.
 */
export class DockerContainer {
  private containerId: string | null = null;
  private containerName: string;
  private dockerConfig: Required<Pick<DockerConfig, 'image' | 'network'>> & DockerConfig;
  private workspaceAccess: WorkspaceAccess;
  private workspacePath: string | null;

  constructor(opts: {
    name: string;
    dockerConfig: DockerConfig;
    workspaceAccess: WorkspaceAccess;
    workspacePath?: string;
  }) {
    this.containerName = `tako-sandbox-${opts.name}`;
    this.dockerConfig = {
      image: 'tako-sandbox:bookworm-slim',
      network: 'none',
      ...opts.dockerConfig,
    };
    this.workspaceAccess = opts.workspaceAccess;
    this.workspacePath = opts.workspacePath ?? null;
  }

  /** Check if Docker is available on the host. */
  static async isDockerAvailable(): Promise<boolean> {
    try {
      await execAsync('docker info', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Create and start the container. */
  async create(): Promise<string> {
    const args: string[] = [
      'docker', 'create',
      '--name', this.containerName,
      '--network', this.dockerConfig.network,
      '--label', 'tako.sandbox=true',
    ];

    // Workspace mount
    if (this.workspacePath && this.workspaceAccess !== 'none') {
      const roFlag = this.workspaceAccess === 'ro' ? ':ro' : '';
      args.push('-v', `${this.workspacePath}:/workspace${roFlag}`);
      args.push('-w', '/workspace');
    }

    // User
    if (this.dockerConfig.user) {
      args.push('-u', this.dockerConfig.user);
    }

    // Extra bind mounts
    if (this.dockerConfig.binds) {
      for (const bind of this.dockerConfig.binds) {
        args.push('-v', bind);
      }
    }

    // Image + keep-alive command
    args.push(this.dockerConfig.image, 'sleep', 'infinity');

    const { stdout } = await execAsync(args.join(' '), { timeout: 30_000 });
    this.containerId = stdout.trim().slice(0, 12);

    // Start the container
    await execAsync(`docker start ${this.containerId}`, { timeout: 10_000 });

    // Run setup command if provided
    if (this.dockerConfig.setupCommand) {
      await this.exec(this.dockerConfig.setupCommand, 30_000);
    }

    return this.containerId;
  }

  /** Execute a command inside the running container. */
  async exec(command: string, timeout: number = 30_000): Promise<ContainerExecResult> {
    if (!this.containerId) {
      throw new Error('Container not created');
    }

    const escapedCmd = command.replace(/'/g, "'\\''");
    const dockerCmd = `docker exec ${this.containerId} sh -c '${escapedCmd}'`;

    try {
      const { stdout, stderr } = await execAsync(dockerCmd, {
        timeout,
        maxBuffer: 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.code ?? 1,
      };
    }
  }

  /** Stop the container. */
  async stop(): Promise<void> {
    if (!this.containerId) return;
    try {
      await execAsync(`docker stop -t 5 ${this.containerId}`, { timeout: 15_000 });
    } catch {
      // Container may already be stopped
    }
  }

  /** Remove the container (force). */
  async remove(): Promise<void> {
    if (!this.containerId) return;
    try {
      await execAsync(`docker rm -f ${this.containerId}`, { timeout: 10_000 });
    } catch {
      // Container may already be removed
    }
    this.containerId = null;
  }

  /** Stop and remove the container. */
  async destroy(): Promise<void> {
    await this.stop();
    await this.remove();
  }

  /** Check if the container is running. */
  async isRunning(): Promise<boolean> {
    if (!this.containerId) return false;
    try {
      const { stdout } = await execAsync(
        `docker inspect -f '{{.State.Running}}' ${this.containerId}`,
        { timeout: 5000 },
      );
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Get container info. */
  getInfo(): ContainerInfo | null {
    if (!this.containerId) return null;
    return {
      id: this.containerId,
      name: this.containerName,
      running: false, // Caller should use isRunning() for live status
    };
  }

  /** Get the container ID (null if not created). */
  getId(): string | null {
    return this.containerId;
  }

  /** Get the container name. */
  getName(): string {
    return this.containerName;
  }

  /**
   * List all Tako sandbox containers on the host.
   * Uses the `tako.sandbox=true` label to filter.
   */
  static async listSandboxContainers(): Promise<ContainerInfo[]> {
    try {
      const { stdout } = await execAsync(
        'docker ps -a --filter "label=tako.sandbox=true" --format "{{.ID}}\\t{{.Names}}\\t{{.State}}"',
        { timeout: 5000 },
      );
      if (!stdout.trim()) return [];
      return stdout.trim().split('\n').map((line) => {
        const [id, name, state] = line.split('\t');
        return { id, name, running: state === 'running' };
      });
    } catch {
      return [];
    }
  }

  /**
   * Remove all Tako sandbox containers.
   */
  static async cleanupAll(): Promise<number> {
    const containers = await DockerContainer.listSandboxContainers();
    for (const c of containers) {
      try {
        await execAsync(`docker rm -f ${c.id}`, { timeout: 10_000 });
      } catch {
        // best-effort
      }
    }
    return containers.length;
  }
}
