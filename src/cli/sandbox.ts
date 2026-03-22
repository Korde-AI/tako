import { resolveConfig } from '../config/resolve.js';
import { SandboxManager } from '../sandbox/sandbox.js';
import { DockerContainer } from '../sandbox/container.js';
import { ToolPolicy } from '../tools/policy.js';

export async function runSandbox(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';
  const config = await resolveConfig();

  switch (subcommand) {
    case 'status': {
      const manager = new SandboxManager(config.sandbox);
      const status = await manager.getStatus();

      console.log('Tako Sandbox Status\n');
      console.log(`Mode: ${status.mode}`);
      console.log(`Docker: ${status.dockerAvailable ? 'available' : 'NOT available'}`);
      console.log(`Scope: ${config.sandbox.scope}`);
      console.log(`Workspace access: ${config.sandbox.workspaceAccess}`);
      console.log(`Image: ${config.sandbox.docker?.image ?? 'tako-sandbox:bookworm-slim'}`);
      console.log(`Network: ${config.sandbox.docker?.network ?? 'none'}`);

      if (status.dockerAvailable) {
        const containers = await DockerContainer.listSandboxContainers();
        if (containers.length > 0) {
          console.log(`\nActive sandbox containers (${containers.length}):`);
          for (const c of containers) {
            console.log(`  ${c.id} ${c.name} (${c.running ? 'running' : 'stopped'})`);
          }
        } else {
          console.log('\nNo active sandbox containers.');
        }
      }

      if (config.tools.exec) {
        console.log(`\nExec policy:`);
        console.log(`  Security: ${config.tools.exec.security}`);
        if (config.tools.exec.allowlist) {
          console.log(`  Allowlist: ${config.tools.exec.allowlist.length} patterns`);
        }
        if (config.tools.exec.timeout) {
          console.log(`  Timeout: ${config.tools.exec.timeout}ms`);
        }
      } else {
        console.log(`\nExec policy: full (no restrictions)`);
      }
      break;
    }

    case 'explain': {
      const toolName = args[1];
      if (!toolName) {
        console.error('Usage: tako sandbox explain <tool-name>');
        console.error('  Example: tako sandbox explain exec');
        process.exit(1);
      }

      const manager = new SandboxManager(config.sandbox);
      console.log(manager.explain(toolName, true));
      console.log();

      const toolPolicy = new ToolPolicy({
        profile: config.tools.profile,
        allow: config.tools.allow,
        deny: config.tools.deny,
        sandbox: config.tools.sandbox,
        exec: config.tools.exec ? {
          security: config.tools.exec.security,
          allowlist: config.tools.exec.allowlist,
          timeout: config.tools.exec.timeout,
          maxOutputSize: config.tools.exec.maxOutputSize,
        } : undefined,
      });
      console.log('Tool Policy:');
      console.log(toolPolicy.explain(toolName, config.sandbox.mode !== 'off'));
      break;
    }

    case 'cleanup': {
      const dockerOk = await DockerContainer.isDockerAvailable();
      if (!dockerOk) {
        console.log('Docker is not available. Nothing to clean up.');
        return;
      }
      const count = await DockerContainer.cleanupAll();
      console.log(`Removed ${count} sandbox container(s).`);
      break;
    }

    default:
      console.error(`Unknown sandbox subcommand: ${subcommand}`);
      console.error('Available: status, explain <tool>, cleanup');
      process.exit(1);
  }
}
