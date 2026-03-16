# Troubleshooting

## First checks

```bash
tako status --home <edgeHome> --json
tako network status --home <edgeHome> --json
tako doctor --home <edgeHome>
tako hub status --home <hubHome> --json
```

## Common problems

### Hub route not found

Check:

```bash
tako hub projects --home <hubHome>
tako hub route <projectIdOrSlug> --home <hubHome>
```

Likely causes:
- edge did not register
- project summary did not sync
- wrong hub URL in `network.hub`

### Invite accepted but delegation denied

Check:

```bash
tako network trust list --home <edgeHome>
tako network capabilities list --home <edgeHome>
tako network requests show <requestId> --home <edgeHome>
```

Likely causes:
- remote node is not trusted
- trust ceiling is too low
- capability is disabled
- receiving edge does not host the project

### Tool access denied inside a project

Check the effective project root:

```bash
tako projects show <projectIdOrSlug> --home <edgeHome> --json
tako projects root <projectIdOrSlug> --home <edgeHome>
```

Likely causes:
- path escaped the allowed project root
- `cwd` escaped the allowed project root
- project root is not readable or writable

### Edge is not reaching the hub

Check:

```bash
tako network status --home <edgeHome>
tako hub nodes --home <hubHome>
```

Likely causes:
- invalid `network.hub`
- hub not listening on expected bind/port
- edge heartbeat not running because the edge never completed startup
