#!/usr/bin/env bash
# Everything Software en ligne depuis le Mac, À CÔTÉ du mode dev (front 5174 + services 4000-4006 inchangés) :
#  - gateway publique sur 127.0.0.1:${PUBLIC_PORT:-4100} (frontend de prod, port unique, Basic Auth .access-public)
#  - tunnel HTTPS cloudflared (trycloudflare, sans compte) supervisé : relancé en cas de coupure, URL dans .public-url
# Prérequis : services lancés (npm run start:services) et frontend construit (npm run build).
# Usage : bash scripts/start-public-mac.sh | bash scripts/start-public-mac.sh --stop
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
export PATH=/Users/cash/.nvm/versions/node/v24.13.0/bin:$HOME/Projets/bin:/opt/homebrew/bin:$PATH
LOGS=${LOGS:-$HOME/Projets/es-logs}; mkdir -p "$LOGS"
PUBLIC_PORT=${PUBLIC_PORT:-4100}
ACCESS=$ROOT/.access-public

stop() {
  pkill -f "es-public-gateway-supervisor" 2>/dev/null
  pkill -f "tunnel-supervisor.sh" 2>/dev/null
  pkill -f "cloudflared tunnel --no-autoupdate" 2>/dev/null
  for p in $(lsof -nP -iTCP:$PUBLIC_PORT -sTCP:LISTEN -t 2>/dev/null); do kill "$p"; done
  sleep 1
}
if [[ "${1:-}" == "--stop" ]]; then stop; rm -f .public-url; echo "Arrêté."; exit 0; fi
[[ -s "$ACCESS" ]] || { echo "Fichier $ACCESS manquant (charles:motdepasse, chmod 600)"; exit 1; }
chmod 600 "$ACCESS"
[[ -f frontend/dist/index.html ]] || { echo "Frontend non construit : npm run build"; exit 1; }
stop

# Gateway publique : ENV_FILE inexistant pour que le .env (GATEWAY_PORT=4000) ne s'applique pas à ce processus.
setsid_cmd() { if command -v setsid >/dev/null; then setsid "$@"; else "$@"; fi; }
nohup bash -c "# es-public-gateway-supervisor
cd '$ROOT/services/api-gateway'
while true; do
  ENV_FILE=/nonexistent GATEWAY_PORT=$PUBLIC_PORT BIND_HOST=127.0.0.1 ACCESS_FILE='$ACCESS' npx tsx src/index.ts
  echo \"[supervisor] gateway publique arrêtée, relance dans 3 s\"; sleep 3
done" >> "$LOGS/public-gateway.log" 2>&1 < /dev/null &

for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PUBLIC_PORT/health" && break; sleep 1; done
echo "Gateway publique locale : http://127.0.0.1:$PUBLIC_PORT (HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PUBLIC_PORT/health) sans mot de passe, 401 attendu)"

rm -f .public-url
nohup env PORT=$PUBLIC_PORT TLOG="$LOGS/tunnel.log" OUTDIR="$LOGS" PROVIDERS="cloudflared" CLOUDFLARED="$(command -v cloudflared)" bash scripts/tunnel-supervisor.sh >> "$LOGS/tunnel.log" 2>&1 < /dev/null &
for i in $(seq 1 90); do [[ -s .public-url ]] && break; sleep 1; done
if [[ -s .public-url ]]; then echo "URL publique : $(cat .public-url)  (identifiant charles, mot de passe dans $ACCESS)"; else echo "Tunnel pas encore en ligne (voir $LOGS/tunnel.log)"; fi
