// Backend MCP de l'app « Console ventes » (mindset DJ : decks = sources, knobs = simulation instantanée,
// VU-mètres = monitoring live, pads = actions confirmées, presets = scènes, agent = co-DJ).
// Backend MCP (bac à sable @es/app-mcp : aucun import, handlers synchrones).
// Stockage local uniquement : historique des métriques, scénarios, réglages (seuils) et journal des actions.
type Point = { id: string; date: string; commandes: number; prix_moyen: number; ca_eur: number; visiteurs: number; conversion_pct: number };
type Db = { list(c: string, f?: object): any[]; get(c: string, id: string): any; insert(c: string, o: object): any; update(c: string, id: string, p: object): any; remove(c: string, id: string): boolean; getMeta(k: string): any; setMeta(k: string, v: any): boolean };

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d);
const round = (v: number, p = 1) => Math.round(v * 10 ** p) / 10 ** p;
const series = (db: Db) => (db.list('metrics') as Point[]).sort((a, b) => a.date.localeCompare(b.date));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const pct = (a: number, b: number) => (b ? round(((a - b) / b) * 100) : 0);
const thresholds = (db: Db) => ({ commandes_min: 90, conversion_min: 4.5, ...(db.getMeta('seuils') ?? {}) });
const weekdayAvg = (pts: Point[], key: 'commandes' | 'ca_eur') => {
  const by: Record<number, number[]> = {};
  for (const p of pts.slice(-28)) (by[new Date(p.date).getUTCDay()] ??= []).push(p[key]);
  return (dow: number) => mean(by[dow] ?? pts.slice(-7).map((p) => p[key]));
};

export const tools = {
  ingest_metrics: {
    description: "Enregistre dans l'historique local les points de métriques lus depuis la source MCP (upsert par date). Utilisé par le rafraîchissement automatique.",
    input: { points: { type: 'array', description: 'Points { date, commandes|valeur, prix_moyen, ca_eur, visiteurs, conversion_pct }' } },
    write: true, safe: true, kind: 'store',
    run: (args: { points: any[] }, db: Db) => {
      let n = 0;
      for (const p of (args.points ?? []).slice(-120)) {
        if (!p?.date) continue;
        const row = { date: String(p.date).slice(0, 10), commandes: num(p.commandes ?? p.valeur), prix_moyen: num(p.prix_moyen, 42), ca_eur: num(p.ca_eur), visiteurs: num(p.visiteurs), conversion_pct: num(p.conversion_pct) };
        if (db.get('metrics', row.date)) db.update('metrics', row.date, row); else db.insert('metrics', { id: row.date, ...row });
        n++;
      }
      db.setMeta('derniere_synchro', new Date().toISOString());
      return { enregistres: n, total: db.list('metrics').length };
    },
  },
  get_kpis: {
    description: 'KPIs du dernier jour vs moyenne des N jours précédents (commandes, CA, conversion, prix) avec statut par rapport aux seuils',
    input: { window: { type: 'integer', optional: true, description: 'Fenêtre de comparaison en jours (défaut 7)' } },
    write: false, kind: 'read',
    run: (args: { window?: number }, db: Db) => {
      const pts = series(db);
      if (!pts.length) return { vide: true, message: 'Aucune donnée : lancez un rafraîchissement' };
      const w = Math.max(2, Math.min(30, args.window ?? 7));
      const last = pts[pts.length - 1];
      const prev = pts.slice(-1 - w, -1);
      const s = thresholds(db);
      const k = (key: keyof Point) => ({ valeur: last[key] as number, moyenne: round(mean(prev.map((p) => p[key] as number))), variation_pct: pct(last[key] as number, mean(prev.map((p) => p[key] as number))) });
      const kpis = { commandes: k('commandes'), ca_eur: k('ca_eur'), conversion_pct: k('conversion_pct'), prix_moyen: k('prix_moyen') };
      const alertes = [
        ...(last.commandes < s.commandes_min ? [`commandes ${last.commandes} < seuil ${s.commandes_min}`] : []),
        ...(last.conversion_pct < s.conversion_min ? [`conversion ${last.conversion_pct} % < seuil ${s.conversion_min} %`] : []),
      ];
      return { date: last.date, fenetre_jours: w, kpis, seuils: s, alertes, statut: alertes.length ? 'alerte' : 'ok', derniere_synchro: db.getMeta('derniere_synchro') };
    },
  },
  get_series: {
    description: 'Historique local des métriques (pour les graphiques), N derniers jours',
    input: { days: { type: 'integer', optional: true } },
    write: false, kind: 'read',
    run: (args: { days?: number }, db: Db) => ({ points: series(db).slice(-(args.days ?? 30)) }),
  },
  detect_anomalies: {
    description: "Détecte les jours anormaux (z-score sur les commandes, corrigé du jour de semaine) et propose une explication (trafic vs conversion)",
    input: { z: { type: 'number', optional: true, description: 'Seuil de z-score (défaut 2)' } },
    write: false, kind: 'read',
    run: (args: { z?: number }, db: Db) => {
      const pts = series(db);
      const zmax = args.z ?? 2;
      const avg = weekdayAvg(pts, 'commandes');
      const resid = pts.map((p) => p.commandes - avg(new Date(p.date).getUTCDay()));
      const sd = std(resid) || 1;
      const out = pts.map((p, i) => ({ p, z: resid[i] / sd })).filter((x) => Math.abs(x.z) >= zmax).map(({ p, z }) => {
        const visits = mean(pts.map((q) => q.visiteurs)); const conv = mean(pts.map((q) => q.conversion_pct));
        const cause = p.visiteurs < visits * 0.8 ? 'baisse du trafic' : p.conversion_pct < conv * 0.8 ? 'baisse de la conversion' : p.prix_moyen > mean(pts.map((q) => q.prix_moyen)) * 1.05 ? 'prix plus élevé' : 'cause non identifiée';
        return { date: p.date, commandes: p.commandes, z: round(z, 2), sens: z < 0 ? 'baisse' : 'hausse', cause_probable: cause };
      });
      return { anomalies: out, seuil_z: zmax, jours_analyses: pts.length };
    },
  },
  forecast: {
    description: 'Prévision des commandes et du CA sur N jours (moyenne par jour de semaine + tendance)',
    input: { days: { type: 'integer', optional: true, description: 'Horizon en jours (défaut 7)' } },
    write: false, kind: 'simulate',
    run: (args: { days?: number }, db: Db) => {
      const pts = series(db);
      if (pts.length < 7) return { previsions: [], message: 'historique insuffisant' };
      const h = Math.max(1, Math.min(30, args.days ?? 7));
      const avgC = weekdayAvg(pts, 'commandes'); const avgCA = weekdayAvg(pts, 'ca_eur');
      const trend = 1 + pct(mean(pts.slice(-7).map((p) => p.commandes)), mean(pts.slice(-14, -7).map((p) => p.commandes))) / 100 / 7;
      const last = new Date(pts[pts.length - 1].date);
      const previsions = Array.from({ length: h }, (_, i) => {
        const d = new Date(last.getTime() + (i + 1) * 86_400_000); const dow = d.getUTCDay(); const f = trend ** (i + 1);
        return { date: d.toISOString().slice(0, 10), commandes: Math.round(avgC(dow) * f), ca_eur: Math.round(avgCA(dow) * f) };
      });
      return { previsions, total_ca_eur: previsions.reduce((a, p) => a + p.ca_eur, 0) };
    },
  },
  simulate_scenario: {
    description: "Simulation what-if INSTANTANÉE (appelée à chaque mouvement de knob, sans écriture) : variation de prix (%) et de trafic (%), élasticité-prix ; compare CA et commandes du scénario au prévisionnel",
    input: {
      price_change_pct: { type: 'number', description: 'Variation de prix en %, ex. 5' },
      traffic_change_pct: { type: 'number', optional: true, description: 'Variation de trafic en %' },
      elasticity: { type: 'number', optional: true, description: 'Élasticité-prix (défaut -1.6)' },
      days: { type: 'integer', optional: true, description: 'Horizon (défaut 14)' },
      name: { type: 'string', optional: true },
    },
    write: false, kind: 'simulate',
    run: (args: { price_change_pct: number; traffic_change_pct?: number; elasticity?: number; days?: number; name?: string }, db: Db) => {
      const base = tools.forecast.run({ days: args.days ?? 14 }, db) as { previsions: Array<{ date: string; commandes: number; ca_eur: number }> };
      const e = args.elasticity ?? -1.6; const p = args.price_change_pct / 100; const t = (args.traffic_change_pct ?? 0) / 100;
      const qf = Math.max(0, (1 + p) ** e * (1 + t));
      const serie = base.previsions.map((x) => ({ date: x.date, ca_prevu: x.ca_eur, ca_scenario: Math.round(x.ca_eur * qf * (1 + p)), commandes_prevues: x.commandes, commandes_scenario: Math.round(x.commandes * qf) }));
      const tot = (k: 'ca_prevu' | 'ca_scenario') => serie.reduce((a, x) => a + x[k], 0);
      const res = { nom: args.name ?? `Prix ${args.price_change_pct >= 0 ? '+' : ''}${args.price_change_pct} %${t ? ` · trafic ${args.traffic_change_pct} %` : ''}`, parametres: { ...args, elasticity: e }, serie, total_ca_prevu: tot('ca_prevu'), total_ca_scenario: tot('ca_scenario'), ecart_ca_pct: pct(tot('ca_scenario'), tot('ca_prevu')), variation_commandes_pct: round((qf - 1) * 100) };
      return res;
    },
  },
  save_preset: {
    description: 'Sauvegarde une scène (preset) : position des knobs et du crossfader, pour la rappeler en un geste',
    input: { name: { type: 'string' }, params: { type: 'object', description: '{ price_change_pct, traffic_change_pct, elasticity, crossfader }' } },
    write: true, safe: true, kind: 'store',
    run: (args: { name: string; params: Record<string, number> }, db: Db) => {
      const id = args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'scene';
      const sim = tools.simulate_scenario.run({ price_change_pct: num(args.params?.price_change_pct), traffic_change_pct: num(args.params?.traffic_change_pct), elasticity: args.params?.elasticity ?? -1.6 }, db) as { ecart_ca_pct?: number };
      const row = { name: args.name, params: args.params ?? {}, ecart_ca_pct: sim.ecart_ca_pct ?? 0 };
      if (db.get('presets', id)) return db.update('presets', id, row);
      return db.insert('presets', { id, ...row });
    },
  },
  list_presets: {
    description: 'Scènes (presets) sauvegardées, à rappeler',
    input: {}, write: false, kind: 'read',
    run: (_a: object, db: Db) => ({ presets: db.list('presets') }),
  },
  suggest_next_move: {
    description: "Co-DJ : propose le prochain mouvement (knob à tourner, pad à déclencher) à partir des KPIs, seuils et anomalies",
    input: { price_change_pct: { type: 'number', optional: true, description: 'Position actuelle du knob prix' } },
    write: false, kind: 'read',
    run: (args: { price_change_pct?: number }, db: Db) => {
      const k = tools.get_kpis.run({}, db) as any;
      if (k.vide) return { moves: [{ type: 'cue', label: 'Rafraîchir les sources', why: 'aucune donnée chargée' }] };
      const an = (tools.detect_anomalies.run({}, db) as any).anomalies as any[];
      const p = args.price_change_pct ?? 0;
      const moves: Array<{ type: string; label: string; why: string; param?: string; value?: number; tool?: string }> = [];
      const recent = an.filter((a) => a.sens === 'baisse').slice(-1)[0];
      if (k.statut === 'alerte') moves.push({ type: 'pad', tool: 'demo__send_alert', label: "Pad Alerte", why: k.alertes.join(' ; ') });
      if (recent) moves.push({ type: 'pad', tool: 'demo__send_alert', label: 'Pad Alerte', why: `anomalie ${recent.date} : ${recent.cause_probable}` });
      if (p > 0) {
        const sim = tools.simulate_scenario.run({ price_change_pct: p }, db) as any;
        if (sim.ecart_ca_pct < 0) moves.push({ type: 'knob', param: 'price_change_pct', value: Math.max(0, p - 3), label: 'Baisse le knob prix', why: `+${p} % fait perdre ${Math.abs(sim.ecart_ca_pct)} % de CA (élasticité)` });
      }
      if (k.kpis.conversion_pct.variation_pct < -10) moves.push({ type: 'knob', param: 'traffic_change_pct', value: 10, label: 'Monte le knob trafic', why: `conversion ${k.kpis.conversion_pct.variation_pct} % vs moyenne` });
      if (!moves.length) moves.push({ type: 'hold', label: 'Garde le mix', why: 'KPIs dans les seuils, pas d’anomalie récente' });
      return { moves: moves.slice(0, 3), statut: k.statut };
    },
  },
  set_thresholds: {
    description: "Règle les seuils d'alerte (réglage local de l'app)",
    input: { commandes_min: { type: 'number', optional: true }, conversion_min: { type: 'number', optional: true } },
    write: true, safe: true, kind: 'store',
    run: (args: { commandes_min?: number; conversion_min?: number }, db: Db) => { const s = { ...thresholds(db), ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) }; db.setMeta('seuils', s); return s; },
  },
  log_action: {
    description: "Journalise une action exécutée sur un système externe (après confirmation de l'utilisateur)",
    input: { action: { type: 'string' }, details: { type: 'string', optional: true }, statut: { type: 'string', enum: ['executee', 'refusee', 'echec'], optional: true }, origine: { type: 'string', enum: ['bouton', 'agent', 'regle'], optional: true } },
    write: true, safe: true, kind: 'store',
    run: (args: { action: string; details?: string; statut?: string; origine?: string }, db: Db) => db.insert('actions', { action: args.action, details: args.details ?? '', statut: args.statut ?? 'executee', origine: args.origine ?? 'bouton' }),
  },
  get_action_log: {
    description: 'Journal des actions (les plus récentes en premier)',
    input: {}, write: false, kind: 'read',
    run: (_a: object, db: Db) => ({ actions: db.list('actions').reverse().slice(0, 30) }),
  },
};
