import { getRuntimePaths } from '../core/paths.js';
import { PrincipalRegistry } from '../principals/registry.js';

export async function runPrincipals(args: string[]): Promise<void> {
  const registry = new PrincipalRegistry(getRuntimePaths().principalsDir);
  await registry.load();

  const subcommand = args[0] ?? 'list';
  switch (subcommand) {
    case 'list':
      await listPrincipals(registry);
      return;
    case 'show':
      await showPrincipal(registry, args[1]);
      return;
    default:
      console.error(`Unknown principals subcommand: ${subcommand}`);
      console.error('Available: list, show <principalId>');
      process.exit(1);
  }
}

async function listPrincipals(registry: PrincipalRegistry): Promise<void> {
  const principals = registry.list();
  const mappings = registry.listMappings();
  if (principals.length === 0) {
    console.log('No principals found.');
    return;
  }
  for (const principal of principals) {
    const linked = mappings
      .filter((mapping) => mapping.principalId === principal.principalId)
      .map((mapping) => `${mapping.platform}:${mapping.platformUserId}`)
      .join(', ');
    console.log(`${principal.principalId}  ${principal.type}  ${principal.displayName}${linked ? `  [${linked}]` : ''}`);
  }
}

async function showPrincipal(registry: PrincipalRegistry, principalId?: string): Promise<void> {
  if (!principalId) {
    console.error('Usage: tako principals show <principalId>');
    process.exit(1);
  }
  const principal = registry.get(principalId);
  if (!principal) {
    console.error(`Principal not found: ${principalId}`);
    process.exit(1);
  }
  const mappings = registry.listMappings().filter((mapping) => mapping.principalId === principalId);
  console.log(JSON.stringify({ ...principal, mappings }, null, 2));
}
