# Release Boundary

## Local Multiuser Ready

The system is locally multiuser ready when one edge can safely provide:
- project memberships
- shared local sessions
- project-scoped memory
- project-scoped tool roots
- Discord or Telegram collaboration on that one edge

## Network Multiuser Ready

The system is network multiuser ready when multiple trusted edges can safely provide:
- hub registration and heartbeat
- project route lookup
- invite and trust lifecycle
- cross-edge network sessions
- bounded remote delegation

## Explicit non-goals

- central shared filesystem
- hub-owned private memory
- unrestricted remote shell
- hub-owned tool execution

## Operator assumptions

- each node gets a unique `--home`
- each node gets a unique bind/port pair
- each project has an explicit tool root
- each operator manages their own credentials and memory roots
