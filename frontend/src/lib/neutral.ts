/**
 * « Formule Agent » : une seule voix dans le studio. En interne, la crew (exploration des données, spécification,
 * construction, revue) et l'agent de chaque app restent identiques ; ici on ne fait que la PRÉSENTATION :
 * étapes neutres, textes sans noms de rôles.
 */
import type { AgentEvent } from '../types';
import { hear, isSpeech } from './speech';

export const AGENT_NAME = 'Formule Agent';

/** Noms de rôles interdits dans le texte visible du studio. */
export const ROLE_TERMS_RE = /\bData Engineer\b|\bProduct Owner\b|\bD[ée]veloppeur\b|\bIng[ée]nieur\b|\bcontrema[iî]tre\b|\brevue PO\b|\bpasse n°\s*\d*|\brevue n°\s*\d*|\bPO\s*→|→\s*Dev\b|\bco-?DJ\b/i;

const REPL: Array<[RegExp, string]> = [
  [/\bl['’]équipe(?: d['’]agents)?\s*(?:\(?Data Engineer\s*→\s*(?:PO|Product Owner)\s*→\s*(?:Dev|Développeur)\)?)/gi, AGENT_NAME],
  [/\bData Engineer\s*→\s*(?:PO|Product Owner)\s*→\s*(?:Dev|Développeur)\b/gi, AGENT_NAME],
  [/\bProduct Owner\s*:\s*revue n°\s*\d+[^,;.\n]*/gi, 'Vérification'],
  [/\bProduct Owner\s*:\s*sp[ée]cification(?: et contrat)?/gi, 'Conception'],
  [/\bD[ée]veloppeur\s*:\s*correction automatique[^\n]*/gi, 'Construction · corrections automatiques'],
  [/\bD[ée]veloppeur\s*:\s*reprise n°\s*\d+/gi, 'Construction · ajustements'],
  [/\bD[ée]veloppeur\s*:\s*(orchestration|donn[ée]es|atomes|mol[ée]cules|organismes|page)\b/gi, 'Construction · $1'],
  [/\bD[ée]veloppeur\s*:\s*[^\n,;]*/gi, 'Construction'],
  [/\bData Engineer\s*:\s*[^\n,;]*/gi, 'Analyse des données'],
  [/\brevue PO n°\s*\d+/gi, 'vérification'],
  [/\brevue n°\s*\d+/gi, 'vérification'],
  [/\bpasse n°\s*\d+/gi, 'étape'],
  [/\b(?:le|du|au|un) contrema[iî]tre\b/gi, AGENT_NAME],
  [/\bcontrema[iî]tre\b/gi, AGENT_NAME],
  [/\bl['’]équipe d['’]agents\b/gi, AGENT_NAME],
  [/\b(?:le|au|du) (?:Data Engineer|Product Owner|D[ée]veloppeur|Ing[ée]nieur)\b/gi, AGENT_NAME],
  [/\bData Engineer\b|\bProduct Owner\b|\bD[ée]veloppeur\b|\bIng[ée]nieur\b/gi, AGENT_NAME],
  [/\bco-?DJ\b/gi, AGENT_NAME],
  [/\bd[ée]l[èe]gue (l['’][ée]volution |la modification )?(?:à|au) Formule Agent\b/gi, 'prend en charge $1'],
  [/\bFormule Agent \(Formule Agent\)/g, AGENT_NAME],
  [/ +([,.])/g, '$1'],
];
/** Texte affichable sans noms de rôles (réponses, libellés de phase, notes de revue). */
export const neutral = (t: unknown) => REPL.reduce((s, [re, to]) => s.replace(re, to), String(t ?? ''));

export type StepName = 'Analyse des données' | 'Conception' | 'Construction' | 'Vérification';
export type CrewStep = { name: StepName; status: 'running' | 'done' | 'failed'; details: Array<{ text: string; ok?: boolean }> };

const stepForRole = (role?: string, iteration?: number): StepName =>
  role === 'data' ? 'Analyse des données' : role === 'po' ? (iteration ? 'Vérification' : 'Conception') : 'Construction';

/** Regroupe les événements de la crew en 4 étapes neutres (détail technique en lignes courtes). */
export function crewSteps(events: AgentEvent[], running: boolean): { steps: CrewStep[]; summary: AgentEvent | null } {
  const steps: CrewStep[] = [];
  let cur: CrewStep | null = null;
  const go = (name: StepName) => {
    let s = steps.find((x) => x.name === name);
    if (!s) { s = { name, status: 'running', details: [] }; steps.push(s); }
    if (cur && cur !== s && cur.status === 'running') cur.status = 'done';
    s.status = 'running'; cur = s; return s;
  };
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.id, e]));
  let summary: AgentEvent | null = null;
  for (const e of events) {
    switch (e.kind) {
      case 'role': go(stepForRole(e.role, e.iteration)); break;
      case 'memory': go('Analyse des données').details.push({ text: neutral(e.text) }); break;
      case 'brief': go('Analyse des données').details.push({ text: e.relevant === false ? 'Aucune source pertinente trouvée' : 'Synthèse des données prête' }); break;
      case 'spec': go('Conception').details.push({ text: `Cahier des charges rédigé${e.components?.length ? ` · ${e.components.length} composants` : ''}` }); break;
      case 'contract': (cur ?? go('Conception')).details.push({ text: e.ok ? `Contrat : ${e.contract?.tools?.length ?? 0} outils` : `Contrat : ${neutral(e.error)}`, ok: !!e.ok }); break;
      case 'tool': {
        if (['build', 'shadcn_add', 'write_file', 'test_backend'].includes(e.tool)) break;
        const r = results.get(e.id);
        (cur ?? go(stepForRole(e.role))).details.push({ text: `${e.tool === 'mcp_call' ? e.args?.tool : e.tool}${r?.ms ? ` · ${r.ms} ms` : ''}`, ok: r ? !!r.ok : undefined });
        break;
      }
      case 'file': (cur ?? go('Construction')).details.push({ text: `${e.op === 'write' ? 'écrit' : e.op === 'edit' ? 'retouché' : 'lu'} ${e.path}` }); break;
      case 'cli': (cur ?? go('Construction')).details.push({ text: `$ ${e.command}`, ok: !!e.ok }); break;
      case 'build': (cur ?? go('Construction')).details.push({ text: `Build ${e.ok ? 'réussi' : 'en échec'}${e.bytes ? ` · ${Math.round(e.bytes / 1024)} Ko` : ''}`, ok: !!e.ok }); break;
      case 'backend_test': (cur ?? go('Construction')).details.push({ text: `Backend ${e.ok ? 'conforme' : 'à corriger'} · ${e.smoke?.filter((x: any) => x.ok).length ?? 0}/${e.smoke?.length ?? 0} outils`, ok: !!e.ok }); break;
      case 'review': {
        const s = go('Vérification');
        s.details.push({ text: e.verdict === 'ok' ? 'Critères validés' : 'Ajustements demandés', ok: e.verdict === 'ok' });
        for (const c of e.criteria ?? []) s.details.push({ text: neutral(`${c.id} ${c.note ?? ''}`), ok: !!c.ok });
        break;
      }
      case 'message': {
        const raw = String(e.text ?? '');
        const text = isSpeech(raw) ? `${raw.split(' ').slice(0, 8).join(' ')} · ${neutral(hear(raw))}` : neutral(raw);
        (cur ?? go(stepForRole(e.role))).details.push({ text: text.slice(0, 300) });
        break;
      }
      case 'summary': summary = e; break;
    }
  }
  if (steps.length) {
    const last = steps[steps.length - 1];
    for (const s of steps) if (s !== last && s.status === 'running') s.status = 'done';
    if (!running) last.status = summary ? 'done' : 'failed';
  }
  return { steps, summary };
}

/** Demande de CRÉATION d'une nouvelle interface (sinon : modification / question sur l'interface ouverte). */
export const isCreateRequest = (t: string) =>
  /^\s*(?:cr[ée]e[rz]?|g[ée]n[èe]re[rz]?|construi[st]|fais[- ]moi|je veux|nouvelle?)\b/i.test(t)
  && /\b(?:app|application|interface|console|dashboard|tableau de bord|outil|cockpit)\b/i.test(t.slice(0, 120))
  && !/\b(?:ajoute|panneau|graphique|colonne|filtre|bouton)\b/i.test(t.slice(0, 40));

/** Application complète, construite par la crew. Une question ou un tableau passent par le constructeur de dashboards. */
export const isFullAppRequest = (t: string) => isCreateRequest(t) && !/\b(?:dashboard|tableau)\b/i.test(t.slice(0, 140));
