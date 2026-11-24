/** Capteur de génération : un événement du processus devient une ligne horodatée, par composant. */

export type GenLog = { at: string; component: string; step: string; level: 'info' | 'ok' | 'error'; text: string };

const clip = (value: unknown, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const ROLE: Record<string, string> = { data: 'Liaison', po: 'Product Owner', dev: 'Développeur' };

function line(component: string, step: string, level: GenLog['level'], text: string, at: string): GenLog {
  return { at, component: component.slice(0, 40) || 'Processus', step: step.slice(0, 60) || 'étape', level, text: clip(text) };
}

function agentLog(event: Record<string, unknown>, at: string): GenLog {
  const label = typeof event.label === 'string' ? event.label : '';
  const role = typeof event.role === 'string' ? ROLE[event.role] ?? 'Moteur' : 'Moteur';
  const kind = String(event.kind ?? '');
  const component = kind === 'review' ? 'Revue' : kind === 'role' && label ? label : role;
  switch (kind) {
    case 'role': return line(component, 'entrée', 'info', label || role, at);
    case 'tool': {
      const args = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {};
      const name = String(args.tool ?? event.tool ?? 'outil');
      return line(component, clip(event.tool, 40), 'info', name, at);
    }
    case 'tool_result': return line(component, clip(event.tool, 40), event.ok === false ? 'error' : 'ok', clip(event.summary), at);
    case 'file': return line(component, String(event.op ?? 'fichier'), 'info', clip(event.path), at);
    case 'cli': return line(component, 'commande', event.ok === false ? 'error' : 'ok', clip(event.command), at);
    case 'build': return line(component, 'build', event.ok === false ? 'error' : 'ok', event.ok === false ? clip(event.output) : 'build réussi', at);
    case 'brief': return line(component, 'brief', event.relevant === false ? 'error' : 'ok', event.relevant === false ? 'aucune source pertinente' : 'synthèse prête', at);
    case 'message': return line(component, 'message', 'info', clip(event.text), at);
    case 'spec': return line(component, 'spec', 'ok', `${Array.isArray(event.components) ? event.components.length : 0} composants`, at);
    case 'review': return line('Revue', `passe ${event.iteration ?? 1}`, event.verdict === 'ok' ? 'ok' : 'error', String(event.verdict ?? ''), at);
    case 'contract': return line(component, 'contrat', event.ok === false ? 'error' : 'ok', event.ok === false ? clip(event.error) : 'contrat posé', at);
    case 'backend_test': return line(component, 'backend', event.ok === false ? 'error' : 'ok', event.ok === false ? clip((event.problems as string[] | undefined)?.[0]) : 'conforme', at);
    case 'app_agent': return line(component, 'agent', 'ok', 'assistant défini', at);
    case 'memory': return line(component, 'mémoire', 'info', clip(event.text), at);
    case 'summary': {
      const files = Array.isArray(event.files) ? event.files.length : 0;
      return line(component, 'bilan', 'ok', `${event.iterations ?? 0} pas · ${files} fichiers`, at);
    }
    case 'kanban': return line(component, 'chantier', 'info', `${event.doneCount ?? 0} terminés`, at);
    default: return line(component, kind || 'événement', 'info', kind, at);
  }
}

function argLines(event: Record<string, unknown>, component: string, step: string, at: string): GenLog[] {
  const raw = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {};
  const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args as Record<string, unknown> : raw;
  return Object.entries(args).slice(0, 12).map(([key, value]) => line(component, step, 'info', `${key}=${clip(value, 80)}`, at));
}

/** Lignes fines d'un événement : l'appel, puis chaque argument, durée, fichier, critère. */
export function senseLines(event: { type?: string; [key: string]: unknown }, at = new Date().toISOString()): GenLog[] {
  const first = sense(event, at);
  if (!first || event.type !== 'agent') return first ? [first] : [];
  const kind = String(event.kind ?? '');
  const more: GenLog[] = [];
  if (kind === 'tool') more.push(...argLines(event, first.component, first.step, at));
  if (kind === 'tool_result' && event.ms != null) more.push(line(first.component, first.step, first.level, `${event.ms} ms`, at));
  if (kind === 'file') more.push(line(first.component, first.step, 'info', `${event.bytes ?? 0} o · ${event.lines ?? 0} lignes${event.changed != null ? ` · ${event.changed} modifiées` : ''}`, at));
  if (kind === 'cli') more.push(line(first.component, 'durée', event.ok === false ? 'error' : 'ok', `${event.ms ?? 0} ms`, at));
  if (kind === 'build') more.push(line(first.component, 'build', event.ok === false ? 'error' : 'ok', `${event.ms ?? 0} ms${event.bytes ? ` · ${event.bytes} o` : ''}`, at));
  if (kind === 'review' && Array.isArray(event.criteria)) {
    for (const item of event.criteria as Array<{ id?: string; ok?: boolean; note?: string }>) {
      more.push(line('Revue', String(item.id ?? 'critère'), item.ok === false ? 'error' : 'ok', clip(item.note ?? (item.ok ? 'ok' : 'à corriger'), 120), at));
    }
  }
  if (kind === 'backend_test' && Array.isArray(event.smoke)) {
    for (const item of event.smoke as Array<{ tool?: string; ok?: boolean; error?: string }>) {
      more.push(line(first.component, String(item.tool ?? 'outil'), item.ok === false ? 'error' : 'ok', clip(item.error ?? 'ok', 120), at));
    }
  }
  if (kind === 'contract' && event.contract && typeof event.contract === 'object') {
    const tools = (event.contract as { tools?: Array<{ name?: string }> }).tools ?? [];
    if (tools.length) more.push(line(first.component, 'outils', 'info', tools.map((tool) => tool.name).filter(Boolean).slice(0, 12).join(', '), at));
  }
  return [first, ...more];
}

/** Traduit un événement SSE en ligne de journal. Les flux de tokens (deltas) restent dehors. */
export function sense(event: { type?: string; [key: string]: unknown }, at = new Date().toISOString()): GenLog | null {
  const type = String(event?.type ?? '');
  if (!type || type === 'log' || type === 'result' || type === 'code_delta' || type === 'plan_delta' || type === 'code_snapshot') return null;
  if (type === 'agent') return agentLog(event, at);
  if (type === 'meta') return line('Moteur', 'modèle', 'info', `${event.provider ?? ''} ${event.model ?? ''}`, at);
  if (type === 'phase') return line('Passerelle', String(event.phase ?? 'phase'), 'info', clip(event.label), at);
  if (type === 'source') return line('Sélecteur', 'lectures', event.canBuild === false ? 'error' : 'ok', clip(event.text), at);
  if (type === 'plan_done') return line('Moteur', 'plan', 'ok', 'plan prêt', at);
  if (type === 'code_done') return line('Développeur', 'code', 'ok', 'code livré', at);
  if (type === 'tool_call') return line('Moteur', 'outil', 'info', clip(event.name), at);
  if (type === 'tool_result') return line('Moteur', 'outil', event.error ? 'error' : 'ok', clip(event.error ?? event.name), at);
  if (type === 'validation') return line('Validateur', `essai ${event.attempt ?? 1}`, event.ok === false ? 'error' : 'ok', event.ok === false ? clip((event.errors as Array<{ message?: string }> | undefined)?.[0]?.message) : 'code accepté', at);
  if (type === 'saved') return line('Stockage', 'version', 'ok', event.number ? `v${event.number}` : clip(event.title ?? 'enregistré'), at);
  if (type === 'app_ready') return line('Backend', 'prêt', 'ok', `${Array.isArray(event.tools) ? event.tools.length : 0} outils`, at);
  if (type === 'app_warning') return line('Backend', 'alerte', 'error', clip(event.message), at);
  if (type === 'error') return line('Processus', 'erreur', 'error', clip(event.message), at);
  if (type === 'start') return line('Passerelle', 'départ', 'info', String(event.mode ?? 'generate'), at);
  if (type === 'done') return line('Passerelle', 'fin', 'ok', event.ms ? `${event.ms} ms` : 'terminé', at);
  if (type === 'source_ready') return line('Sélecteur', 'offre', 'ok', 'lectures proposées', at);
  if (type === 'dashboard_open') return line('Tableau', 'ouverture', 'info', clip(event.title), at);
  if (type === 'dashboard_layout') return line('Tableau', 'grille', 'info', 'grille posée', at);
  if (type === 'chart_ready') {
    const chart = event.chart && typeof event.chart === 'object' ? event.chart as { title?: string } : {};
    return line('Tableau', 'graphique', 'ok', clip(chart.title ?? 'graphique'), at);
  }
  if (type === 'dashboard_spec') return line('Tableau', 'spec', 'ok', clip(event.reply ?? 'tableau prêt'), at);
  return line('Processus', type, 'info', type, at);
}
