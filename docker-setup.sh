#!/usr/bin/env bash
set -euo pipefail

echo "🐙 Tako Docker Setup"
echo ""

# Check Docker
if ! command -v docker &>/dev/null; then
    echo "❌ Docker not found. Install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker info &>/dev/null; then
    echo "❌ Docker daemon not running. Start Docker and try again."
    exit 1
fi

echo "✅ Docker is running"

# Ask bind preference
echo ""
echo "Network binding:"
echo "  1) localhost only (recommended, most secure)"
echo "  2) LAN (accessible from other devices)"
read -rp "Choose [1]: " BIND_CHOICE
BIND_CHOICE=${BIND_CHOICE:-1}

if [ "$BIND_CHOICE" = "2" ]; then
    export TAKO_BIND="0.0.0.0"
    echo "⚠️  Binding to 0.0.0.0 — Tako will be accessible from your network"
    # Update docker-compose port binding for LAN access
    sed -i 's/127\.0\.0\.1:18790:18790/0.0.0.0:18790:18790/' docker-compose.yml
else
    export TAKO_BIND="127.0.0.1"
    echo "✅ Binding to localhost only"
fi

# Build
echo ""
echo "Building Tako image..."
docker build -t tako:local .

# Run onboarding
echo ""
echo "Running onboarding wizard..."
docker compose run --rm tako node dist/index.js onboard

# Start
echo ""
echo "Starting Tako..."
docker compose up -d

echo ""
echo "🐙 Tako is running!"
echo "   Gateway: http://${TAKO_BIND}:18790"
echo "   Health:  curl http://127.0.0.1:18790/healthz"
echo ""
echo "Commands:"
echo "   docker compose logs -f tako    # view logs"
echo "   docker compose restart tako    # restart"
echo "   docker compose down            # stop"
