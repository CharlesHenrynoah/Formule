#!/usr/bin/env bash
# Déploiement Mac : mémoire de la crew + mode incrémental + thème monochrome.
# Préserve .env, data/secrets, mcp.config.json, services/storage/data/everything.db*. Ne touche pas ~/Desktop/everything ni le port 5173.
# Usage (depuis ~/Projets) : bash everything-software/scripts/deploy-mac-mem-nb.sh ~/Projets/es-deploy-mem-nb.tgz
set -euo pipefail
export PATH=/Users/cash/.nvm/versions/node/v24.13.0/bin:/opt/homebrew/bin:$PATH
TGZ=${1:?archive}
cd ~/Projets/everything-software
fp() { for f in .env mcp.config.json data/secrets/mcp-servers.json services/storage/data/everything.db; do [[ -f $f ]] && echo "$f $(shasum -a 256 "$f" | cut -c1-16)"; done; }
fp > /tmp/es-fp-before.txt
tar -xzf "$TGZ" -C .
fp > /tmp/es-fp-after.txt
diff /tmp/es-fp-before.txt /tmp/es-fp-after.txt && echo "Empreintes identiques (.env, secrets, mcp.config, DB)"
# Template installé : fichiers plateforme à jour (thème, AppShell, theme.ts)
for f in src/index.css src/main.tsx vite.config.ts src/components/es; do cp -R services/ai-engine/agent-template/$f data/agent-template/$(dirname $f)/ 2>/dev/null || true; done
echo OK
