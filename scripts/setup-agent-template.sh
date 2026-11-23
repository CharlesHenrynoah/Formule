#!/usr/bin/env bash
# Prépare le template de workspace de l'agent Développeur :
# Vite + React + TS + Tailwind 4, `shadcn init` (style radix-nova), build mono-fichier.
# Usage : bash scripts/setup-agent-template.sh   (≈ 10 s avec le cache npm)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=services/ai-engine/agent-template
DEST=${AGENT_TEMPLATE_DIR:-data/agent-template}
rm -rf "$DEST.tmp" && mkdir -p "$(dirname "$DEST")" && cp -r "$SRC" "$DEST.tmp"
cd "$DEST.tmp"
npm install --no-audit --no-fund --prefer-offline --loglevel=error
npx shadcn init -t vite -b radix -p nova -y --silent
# shadcn/ui Charts (Recharts) pré-installé : aucune installation à chaque génération
npx shadcn add chart -y --silent
# Composants d'ACTION pilotés par le contremaître (équivalents shadcn des 27 composants « Apps SDK UI », cf. src/components/es/actions.tsx)
npx shadcn add tabs alert avatar badge checkbox calendar popover empty spinner progress input dropdown-menu radio-group toggle-group toggle select command slider switch textarea tooltip -y --silent
# Markdown (composant d'action « Markdown ») : react-markdown + GFM + Tailwind typography
npm install react-markdown@^10 remark-gfm @tailwindcss/typography --no-audit --no-fund --prefer-offline --loglevel=error
grep -q '@tailwindcss/typography' src/index.css || sed -i.bak '3a\
@plugin "@tailwindcss/typography";
' src/index.css && rm -f src/index.css.bak
# Correctifs du preset : utilitaire cn standard, police système (pas de webfont), accent violet
cat > src/lib/utils.ts <<'TS'
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
TS
python3 - <<'PY'
import re, json
p='src/index.css'; s=open(p).read()
s=s.replace('@import "@fontsource-variable/geist";\n','')
s=s.replace("--font-sans: 'Geist Variable', sans-serif;","--font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;")
s=re.sub(r'(\.dark \{[^}]*?--primary: )[^;]+;', r'\1oklch(0.606 0.25 292.717);', s, count=1)
s=re.sub(r'(\.dark \{[^}]*?--primary-foreground: )[^;]+;', r'\1oklch(0.985 0 0);', s, count=1)
s=re.sub(r'(:root \{[^}]*?--primary: )[^;]+;', r'\1oklch(0.541 0.281 293.009);', s, count=1)
s=re.sub(r'(:root \{[^}]*?--primary-foreground: )[^;]+;', r'\1oklch(0.985 0 0);', s, count=1)
# palette colorée pour shadcn/ui Charts
for i,c in enumerate(['oklch(0.606 0.25 292.717)','oklch(0.696 0.17 162.48)','oklch(0.769 0.188 70.08)','oklch(0.623 0.214 259.815)','oklch(0.645 0.246 16.439)'],1):
    s=re.sub(r'--chart-%d: [^;]+;'%i,'--chart-%d: %s;'%(i,c),s)
open(p,'w').write(s)
pk=json.load(open('package.json'))
pk['dependencies'].pop('@fontsource-variable/geist', None)  # « cn » est gardé : le preset nova le réinstalle à chaque add
json.dump(pk, open('package.json','w'), indent=2)
PY
cat "$OLDPWD/scripts/control-room.css" >> src/index.css   # thème « salle de contrôle » de l'AppShell
npx vite build >/dev/null
cd - >/dev/null
rm -rf "$DEST" && mv "$DEST.tmp" "$DEST"
echo "Template prêt : $DEST ($(du -sh "$DEST/node_modules" | cut -f1) de node_modules)"
