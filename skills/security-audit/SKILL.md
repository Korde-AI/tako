---
name: security-audit
description: Host security hardening and risk-tolerance audit for Tako deployments. Use when a user asks for security audits, firewall/SSH/update hardening, risk posture, exposure review, Docker security checks, or version status checks on a machine running Tako.
---

# Security Audit

Host security hardening and risk-tolerance audit for Tako deployments.

## Core Rules

- **Require explicit approval** before any state-changing action
- **Never modify remote access** without confirming how the user connects
- **Prefer reversible, staged changes** — one thing at a time
- **Every choice set must be numbered** for easy reply
- **Recommend running with a powerful model** for best results (e.g. claude-opus-4-6)

## Audit Flow

### Step 1: Context Gathering (read-only)

Before making any recommendations, gather the environment context. Run these checks silently and summarize the findings:

1. **OS and version** — `cat /etc/os-release` or `sw_vers` (macOS)
2. **Privilege level** — `whoami`, check if running as root vs regular user
3. **Access path** — How is the user connected? (local terminal, SSH, tailnet, etc.)
4. **Network exposure** — Check for public IP (`curl -s ifconfig.me`), reverse proxy, tunnels
5. **Tako gateway status** — Read `~/.tako/tako.json` for bind address and port; check if the process is running
6. **Docker status** — Is Docker installed? Running? What containers are active? Security options enabled?
7. **Backup system** — Any backup tooling detected? (restic, borg, timeshift, etc.)

Present findings as a summary table:

```
Environment Summary
═══════════════════
OS:           Ubuntu 24.04 LTS
User:         shuyhere (non-root)
Access:       SSH (key-based)
Public IP:    203.0.113.42
Tako bind:    127.0.0.1:18790 (localhost only) ✅
Docker:       running, 2 containers
Firewall:     ufw active
Backups:      not detected ⚠️
```

### Step 2: Risk Tolerance Assessment

Ask the user to pick their risk level. This determines the strictness of recommendations:

```
What's your risk tolerance for this machine?

  1) Minimal   — Personal laptop, home network, low risk
  2) Standard  — Shared network, some exposure, moderate risk
  3) Hardened  — Production server, public-facing, high security
  4) Maximum   — Critical infrastructure, zero trust
```

Default to **Standard** if the user doesn't specify.

Risk level determines thresholds:
- **Minimal**: Only flag critical issues (open root SSH, no firewall on public IP)
- **Standard**: Flag important issues + suggest common hardening
- **Hardened**: All checks strict, recommend fail2ban, audit logging, container scanning
- **Maximum**: Zero trust posture, all ports closed except explicit, mandatory encryption, immutable containers

### Step 3: Security Checks (automated)

Run these checks and report pass/warn/fail for each:

#### Network & Access
- [ ] Tako gateway bind address (localhost vs LAN vs public)
- [ ] Open ports scan (`ss -tlnp` or `netstat -tlnp`)
- [ ] Firewall status (ufw/iptables/nftables/firewalld)
- [ ] SSH configuration (key-only auth, no root login, non-default port)
- [ ] SSL/TLS for any exposed endpoints

#### Docker & Containers
- [ ] Docker container security (non-root user, read-only rootfs, network isolation)
- [ ] Docker socket permissions (`/var/run/docker.sock` group access)
- [ ] Container image vulnerability scan (if `trivy` or `grype` is available)
- [ ] Docker daemon configuration (`/etc/docker/daemon.json` — userns-remap, no-new-privileges)

#### Tako-Specific
- [ ] Auth token/API key exposure (env vars in process list, file permissions on `~/.tako/.env`)
- [ ] Tako config file permissions (`~/.tako/` should be `700`, files `600`)
- [ ] Sandbox configuration review (sandbox mode, workspace access level)
- [ ] Gateway auth token set (should be enabled for non-localhost binds)

#### System
- [ ] System updates pending (`apt list --upgradable` / `dnf check-update`)
- [ ] Unattended upgrades configured (for security patches)
- [ ] Failed login attempts (`journalctl` or `/var/log/auth.log`)

Present results as a checklist:

```
Security Checks
═══════════════
✅ Tako bind: localhost only
✅ Firewall: ufw active, default deny
⚠️  SSH: password authentication still enabled
❌ Tako permissions: ~/.tako/ is 755, should be 700
✅ Docker: non-root user in container
⚠️  Updates: 12 packages upgradable (3 security)
❌ Auth token: not set (required for non-localhost)
✅ Sandbox: enabled for non-main sessions
```

### Step 4: Recommendations

Based on the risk level and check results, provide **numbered actionable recommendations**.

Each recommendation must include:

1. **What to do** — Clear one-line description
2. **Why it matters** — The risk if not addressed
3. **How to do it** — Exact command(s) to run
4. **How to undo it** — Rollback command if something goes wrong

Format:

```
Recommendation 1: Lock down Tako config permissions
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Why:    ~/.tako/ contains API keys and auth tokens. World-readable
        permissions expose credentials to other users on the system.
Fix:    chmod 700 ~/.tako && chmod 600 ~/.tako/.env ~/.tako/tako.json
Undo:   chmod 755 ~/.tako && chmod 644 ~/.tako/.env ~/.tako/tako.json
Risk:   ❌ Critical (credential exposure)
```

**Always ask for approval before running any fix commands.**

Present all recommendations at once, then ask:

```
Which recommendations should I apply? (e.g. "1,3,5" or "all" or "none")
```

### Step 5: Periodic Audit

After the initial audit, suggest setting up recurring checks:

#### Option A: Tako Heartbeat Integration
If Tako's heartbeat system is configured, suggest adding a security check to the heartbeat prompt:

```
Add to your heartbeat prompt in tako.json:
"During heartbeat, run a quick security check: verify Tako bind address,
check for pending security updates, and confirm ~/.tako permissions."
```

#### Option B: Cron Job
Suggest a lightweight cron job using the bundled audit script:

```bash
# Run security audit weekly, log results
0 9 * * 1 /path/to/tako/skills/security-audit/audit.sh >> ~/.tako/security-audit.log 2>&1
```

#### Option C: Manual
Remind the user they can re-run this skill anytime:
```
Just ask: "run a security audit" or "check my security posture"
```

## Quick Audit Mode

If the user says "quick audit" or "quick security check", skip the risk assessment and run all checks at Standard level, presenting only warnings and failures (skip passes).

## Tool: audit.sh

A standalone bash script is available at `skills/security-audit/audit.sh` for quick command-line audits outside of Tako. Run it with:

```bash
bash skills/security-audit/audit.sh
```

This performs a subset of the automated checks and prints results to stdout.
