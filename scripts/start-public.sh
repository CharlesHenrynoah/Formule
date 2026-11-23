#!/usr/bin/env bash
# Met Everything Software en ligne : build du frontend, services en production (localhost uniquement),
# gateway sur 127.0.0.1:4000 protégée par Basic Auth (.access), tunnel public HTTPS (cloudflared, sinon ssh localhost.run / pinggy / serveo).
# Usage : bash scripts/start-public.sh [--rebuild] [--no-tunnel] | bash scripts/start-public.sh --stop
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
LOG=/tmp/es-public.log
TLOG=/tmp/es-tunnel.log
CLOUDFLARED=${CLOUDFLARED:-$(command -v cloudflared || echo /home/box/.local/bin/cloudflared)}
PORT=$(grep -E '^GATEWAY_PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-4000}

stop() {
  pkill -f "es-supervisor" 2>/dev/null
  pkill -f "concurrently -k -n storage" 2>/dev/null
  pkill -f "$ROOT/node_modules/.bin/tsx" 2>/dev/null
  pkill -f "tsx (watch )?src/index.ts" 2>/dev/null
  pkill -f "vite --host 0.0.0.0 --port 5173" 2>/dev/null
  pkill -f "tunnel-supervisor.sh" 2>/dev/null
  pkill -f "cloudflared tunnel --no-autoupdate" 2>/dev/null
  pkill -f "nokey@localhost.run|a.pinggy.io|serveo.net" 2>/dev/null
  sleep 2
}

if [[ "${1:-}" == "--stop" ]]; then stop; echo "Arrêté."; exit 0; fi

[[ -f .access ]] || { echo "Fichier .access manquant (format user:motdepasse, chmod 600)"; exit 1; }
chmod 600 .access .env 2>/dev/null

stop
if [[ "${1:-}" == "--rebuild" || ! -f frontend/dist/index.html || ! -f packages/es-runtime/dist/es-runtime.js ]]; then
  echo "Build du frontend…"; npm run build > /tmp/es-build.log 2>&1 || { echo "Échec du build (voir /tmp/es-build.log)"; exit 1; }
fi

# Services (redémarrés automatiquement s'ils s'arrêtent)
setsid nohup bash -c "# es-supervisor services
while true; do npm run start:services; echo \"[supervisor] services arrêtés, relance dans 3 s\"; sleep 3; done" >> "$LOG" 2>&1 < /dev/null &

for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")
echo "Gateway locale : http://127.0.0.1:$PORT (HTTP $code sans mot de passe, 401 attendu)"

if [[ " $* " == *" --no-tunnel "* ]]; then exit 0; fi

# Tunnel public HTTPS (sans compte) : superviseur multi-fournisseurs, relancé en cas de coupure.
: > "$TLOG"; rm -f .public-url
setsid nohup env PORT=$PORT TLOG=$TLOG bash scripts/tunnel-supervisor.sh >> "$TLOG" 2>&1 < /dev/null &

for i in $(seq 1 150); do [[ -s .public-url ]] && break; sleep 1; done
if [[ -s .public-url ]]; then
  echo "URL publique : $(cat .public-url)  (identifiants : fichier .access)"
else
  echo "Tunnel pas encore en ligne (voir $TLOG) — accès local : http://127.0.0.1:$PORT"
fi
