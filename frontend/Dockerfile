# Contexte de build : racine du dépôt (docker-compose : context: ., dockerfile: frontend/Dockerfile)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY frontend/package.json frontend/
COPY packages/es-runtime/package.json packages/es-runtime/
RUN npm install --no-audit --no-fund -w frontend -w @es/runtime --include-workspace-root=false
COPY frontend frontend
COPY packages/es-runtime packages/es-runtime
RUN npm run build -w @es/runtime && cd frontend && npx vite build

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY --from=build /app/packages/es-runtime/dist /usr/share/nginx/html/runtime
COPY packages/es-runtime/vendor/*.js /usr/share/nginx/html/runtime/
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
