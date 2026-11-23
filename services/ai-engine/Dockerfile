# Contexte de build : racine du dépôt (docker-compose : context: ., dockerfile: services/ai-engine/Dockerfile)
FROM node:24-alpine
WORKDIR /repo
COPY services/ai-engine/package.json services/ai-engine/
RUN cd services/ai-engine && npm install --omit=dev --no-audit --no-fund
COPY services/ai-engine/src services/ai-engine/src
COPY packages/app-mcp packages/app-mcp
RUN npm install --prefix /repo --no-save --no-audit --no-fund esbuild@^0.28.0
COPY services/ai-engine/agent-template services/ai-engine/agent-template
COPY frontend/src/components/ui frontend/src/components/ui
COPY scripts/setup-agent-template.sh scripts/
# Template de l'agent Développeur : Vite + React + Tailwind + `shadcn init` (nécessite le réseau au build)
RUN apk add --no-cache bash && bash scripts/setup-agent-template.sh
WORKDIR /repo/services/ai-engine
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/index.ts"]
