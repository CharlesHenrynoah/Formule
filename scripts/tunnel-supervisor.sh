#!/usr/bin/env bash
# es-supervisor tunnel : garde un tunnel HTTPS public vers la gateway locale, quel que soit le fournisseur disponible.
# Ordre : cloudflared (trycloudflare) → localhost.run (ssh) → pinggy (ssh 443) → serveo (ssh).
# Écrit l'URL courante dans .public-url ; vérifie l'URL toutes les 60 s et relance le tunnel s'il ne répond plus.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-4000}
TLOG=${TLOG:-/tmp/es-tunnel.log}
OUTDIR=${OUTDIR:-/tmp}
PROVIDERS=${PROVIDERS:-cloudflared localhostrun pinggy serveo}
CLOUDFLARED=${CLOUDFLARED:-$(command -v cloudflared || echo /home/box/.local/bin/cloudflared)}
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o BatchMode=yes"
log() { echo "[$(date '+%F %T')] $*" >> "$TLOG"; }

start_provider() {
  local name=$1 out=$OUTDIR/es-tunnel-$1.out
  : > "$out"
  case $name in
    cloudflared) "$CLOUDFLARED" tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" > "$out" 2>&1 & ;;
    localhostrun) ssh $SSH_OPTS -R 80:127.0.0.1:$PORT nokey@localhost.run -- --output json > "$out" 2>&1 < /dev/null & ;;
    pinggy) ssh $SSH_OPTS -p 443 -R0:127.0.0.1:$PORT a.pinggy.io > "$out" 2>&1 < /dev/null & ;;
    serveo) ssh $SSH_OPTS -R 80:127.0.0.1:$PORT serveo.net > "$out" 2>&1 < /dev/null & ;;
  esac
  TPID=$!
  local re='https://[a-z0-9-]+\.(trycloudflare\.com|lhr\.life|localhost\.run|a\.free\.pinggy\.link|free\.pinggy\.link|serveo\.net|serveousercontent\.com)'
  for _ in $(seq 1 45); do
    URL=$(grep -oE "$re" "$out" | grep -v 'api.trycloudflare' | tail -1)
    [[ -n "$URL" ]] && return 0
    kill -0 "$TPID" 2>/dev/null || break
    sleep 1
  done
  kill "$TPID" 2>/dev/null; return 1
}

alive() { # 401 attendu sans identifiants = la gateway répond derrière le tunnel
  local c; c=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$1/health")
  [[ "$c" == "401" || "$c" == "200" ]]
}

while true; do
  for p in $PROVIDERS; do
    log "essai du tunnel $p"
    if start_provider "$p"; then
      sleep 8
      if alive "$URL"; then
        echo "$URL" > .public-url; log "EN LIGNE via $p : $URL"
        fails=0
        while kill -0 "$TPID" 2>/dev/null; do
          sleep 60
          if alive "$URL"; then fails=0; else fails=$((fails+1)); log "URL injoignable ($fails/3)"; fi
          [[ $fails -ge 3 ]] && { log "relance du tunnel"; kill "$TPID" 2>/dev/null; break; }
        done
        log "tunnel $p arrêté"
      else
        log "$p : URL $URL sans réponse"; kill "$TPID" 2>/dev/null
      fi
    else
      log "$p indisponible"
    fi
    sleep 3
  done
  log "aucun tunnel disponible (réseau) : nouvel essai dans 2 min"
  sleep 120
done
