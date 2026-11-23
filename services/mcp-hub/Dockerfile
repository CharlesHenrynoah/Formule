# Contexte de build : racine du dépôt (voir docker-compose.yml)
FROM node:24-alpine
WORKDIR /app
RUN npm install -g tsx@4 --no-audit --no-fund
COPY services/mcp-hub/package.json services/mcp-hub/
COPY packages/mcp-demo-server/package.json packages/mcp-demo-server/
RUN cd services/mcp-hub && npm install --omit=dev --no-audit --no-fund \
 && cd ../../packages/mcp-demo-server && npm install --omit=dev --no-audit --no-fund
COPY services/mcp-hub/src services/mcp-hub/src
COPY packages/mcp-demo-server/src packages/mcp-demo-server/src
# Runtime des backends MCP par app (@es/app-mcp) : SDK MCP résolu depuis /app/node_modules
COPY packages/app-mcp/package.json packages/app-mcp/
COPY packages/app-mcp/src packages/app-mcp/src
RUN npm install --prefix /app --no-save --no-audit --no-fund @modelcontextprotocol/sdk@^1.32.0
COPY mcp.config.json /app/mcp.config.json
WORKDIR /app/services/mcp-hub
ENV MCP_CONFIG_PATH=/app/mcp.config.json ES_ROOT=/app APPS_DIR=/apps NODE_ENV=production
CMD ["tsx", "src/index.ts"]
