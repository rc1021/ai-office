# AI Office — Multi-stage Docker build
# Builds all services for reproducible deployment.

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for all modules
COPY package*.json ./
COPY core/package*.json ./core/
COPY discord-bot/package*.json ./discord-bot/
COPY coordination/package*.json ./coordination/
COPY orchestrator/package*.json ./orchestrator/
COPY pixel-office/package*.json ./pixel-office/
COPY setup/package*.json ./setup/
COPY cli/package*.json ./cli/

# Install dependencies
RUN cd core && npm ci --silent && cd .. \
 && cd discord-bot && npm ci --silent && cd .. \
 && cd coordination && npm ci --silent && cd .. \
 && cd orchestrator && npm ci --silent && cd .. \
 && cd pixel-office && npm ci --silent && cd .. \
 && cd setup && npm ci --silent && cd .. \
 && cd cli && npm ci --silent

# Copy source
COPY core/ ./core/
COPY discord-bot/ ./discord-bot/
COPY coordination/ ./coordination/
COPY orchestrator/ ./orchestrator/
COPY pixel-office/ ./pixel-office/
COPY setup/ ./setup/
COPY cli/ ./cli/
COPY config/ ./config/
COPY roles/ ./roles/
COPY agents/ ./agents/
COPY CLAUDE.md ./

# Build all TypeScript (core first — discord-bot depends on it via file:)
RUN cd core && npm run build \
 && cd ../discord-bot && npm run build \
 && cd ../coordination && npm run build \
 && cd ../orchestrator && npm run build \
 && cd ../setup && npm run build \
 && cd ../cli && npm run build \
 && cd ../pixel-office && npm run build:server

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/core/dist ./core/dist/
COPY --from=builder /app/core/node_modules ./core/node_modules/
COPY --from=builder /app/core/package.json ./core/

COPY --from=builder /app/discord-bot/dist ./discord-bot/dist/
COPY --from=builder /app/discord-bot/node_modules ./discord-bot/node_modules/
COPY --from=builder /app/discord-bot/package.json ./discord-bot/

COPY --from=builder /app/coordination/dist ./coordination/dist/
COPY --from=builder /app/coordination/node_modules ./coordination/node_modules/
COPY --from=builder /app/coordination/package.json ./coordination/

COPY --from=builder /app/orchestrator/dist ./orchestrator/dist/
COPY --from=builder /app/orchestrator/node_modules ./orchestrator/node_modules/
COPY --from=builder /app/orchestrator/package.json ./orchestrator/

COPY --from=builder /app/pixel-office/dist ./pixel-office/dist/
COPY --from=builder /app/pixel-office/node_modules ./pixel-office/node_modules/
COPY --from=builder /app/pixel-office/package.json ./pixel-office/

COPY --from=builder /app/setup/dist ./setup/dist/
COPY --from=builder /app/setup/node_modules ./setup/node_modules/
COPY --from=builder /app/setup/package.json ./setup/

COPY --from=builder /app/cli/dist ./cli/dist/
COPY --from=builder /app/cli/node_modules ./cli/node_modules/
COPY --from=builder /app/cli/package.json ./cli/

# Copy config and templates
COPY --from=builder /app/config ./config/
COPY --from=builder /app/roles ./roles/
COPY --from=builder /app/agents ./agents/
COPY --from=builder /app/CLAUDE.md ./

# Create workspace directory
RUN mkdir -p /app/.ai-office/state /app/.ai-office/artifacts /app/.ai-office/logs

ENV AI_OFFICE_WORKSPACE=/app/.ai-office
EXPOSE 3847

CMD ["node", "pixel-office/dist/server/index.js"]
