# Image unique : tous les services Formule + le Studio compilé, servis par la gateway (:4000).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
COPY servers ./servers
COPY frontend ./frontend
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund && npm run build -w @formule/frontend
ENV HOST=0.0.0.0 FORMULE_DATA_DIR=/data FORMULE_SERVE_STUDIO=1 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 4000
CMD ["npx", "concurrently", "-k", "--names", "sto,hub,val,apps,voice,ai,gw", "npm:start -w @formule/storage", "npm:start -w @formule/mcp-hub", "npm:start -w @formule/validator", "npm:start -w @formule/app-agents", "npm:start -w @formule/voice-gateway", "npm:start -w @formule/ai-engine", "npm:start -w @formule/api-gateway"]
