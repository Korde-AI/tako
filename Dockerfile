FROM node:22-bookworm-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src/ src/
COPY workspace/ workspace/
RUN npm run build

# Run as node user (UID 1000, already exists in node base image)
USER node

# Default config/workspace directories
RUN mkdir -p /home/node/.tako/workspace /home/node/.tako/auth /home/node/.tako/sessions

ENV NODE_ENV=production
ENV HOME=/home/node
EXPOSE 18790

CMD ["node", "dist/index.js", "start"]
