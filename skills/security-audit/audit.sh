#!/usr/bin/env bash
# Tako Security Audit — quick check script
set -euo pipefail

echo "🐙 Tako Security Audit"
echo "======================"

# Check Tako bind
echo ""
echo "## Tako Gateway"
if [ -f ~/.tako/tako.json ]; then
    echo "Config: $(grep -o '"bind"[^,}]*' ~/.tako/tako.json 2>/dev/null || echo 'default')"
else
    echo "Config: not found"
fi

# Check Docker
echo ""
echo "## Docker"
if command -v docker &>/dev/null; then
    echo "Docker: installed"
    docker info --format '{{.SecurityOptions}}' 2>/dev/null || echo "Cannot read docker info"
else
    echo "Docker: not installed"
fi

# Check firewall
echo ""
echo "## Firewall"
if command -v ufw &>/dev/null; then
    sudo ufw status 2>/dev/null || echo "ufw: cannot check (need sudo)"
elif command -v firewall-cmd &>/dev/null; then
    sudo firewall-cmd --state 2>/dev/null || echo "firewalld: cannot check"
else
    echo "No firewall tool found"
fi

# Check SSH
echo ""
echo "## SSH"
if [ -f /etc/ssh/sshd_config ]; then
    echo "PermitRootLogin: $(grep -i '^PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null || echo 'default')"
    echo "PasswordAuth: $(grep -i '^PasswordAuthentication' /etc/ssh/sshd_config 2>/dev/null || echo 'default')"
else
    echo "sshd_config: not found"
fi

# Check open ports
echo ""
echo "## Open Ports"
if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | head -20
elif command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | head -20
fi

# Check file permissions
echo ""
echo "## Tako File Permissions"
if [ -d ~/.tako ]; then
    ls -la ~/.tako/ 2>/dev/null
else
    echo "~/.tako not found"
fi

echo ""
echo "Audit complete."
