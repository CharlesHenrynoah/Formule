/**
 * Recrée un workspace de build à partir de la dernière version d'une app (fichiers + composants shadcn) :
 *   node --import tsx scripts/workspace-from-app.mts <appId>   → affiche le chemin du workspace
 * À enchaîner avec repair-app-version.mts (ex. rebuild sous le nouveau thème monochrome).
 */
import { Workspace } from '../services/ai-engine/src/agent/workspace.ts';
const appId = process.argv[2];
if (!appId) { console.error('usage : workspace-from-app.mts <appId>'); process.exit(2); }
const STORAGE = process.env.STORAGE_URL ?? 'http://127.0.0.1:4003';
const latest = await (await fetch(`${STORAGE}/projects/${appId}/latest`)).json() as any;
if (!latest?.files) { console.error('aucun fichier source pour cette app'); process.exit(1); }
const fromImports = Object.values(latest.files as Record<string, string>).flatMap((c) => [...c.matchAll(/@\/components\/ui\/([a-z-]+)['"]/g)].map((m) => m[1]));
const components = [...new Set([...(latest.agent?.components ?? []), ...fromImports])].filter((c: string) => /^[a-z-]+$/.test(c));
const ws = await Workspace.create({ files: latest.files, components });
console.log(`v${latest.number} · ${Object.keys(latest.files).length} fichiers`);
console.log(ws.dir);
