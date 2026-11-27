/** Certification par portes : une porte obligatoire ratée bloque. Pas de score moyen. */
export const GATES = {
  G0: 'Intention et permissions',
  G1: 'Source réelle et couverture',
  G2: 'Contrat, types, unités, provenance',
  G3: 'Build, imports, sécurité',
  G4: 'Tests backend contre un oracle indépendant',
  G5: 'Navigateur : DOM, interactions, états',
  G6: 'Exigences obligatoires et fraîcheur',
  G7: 'Non-régression, publication, restauration',
} as const;
export type GateId = keyof typeof GATES;

export interface GateResult { gate: GateId; passed: boolean; details: string[] }
export interface RequirementStatus { id: string; label: string; mandatory: boolean; status: 'covered' | 'missing' | 'unavailable'; reason?: string }

export interface CertificationReport {
  certified: boolean;
  complete: boolean;
  covered: number;
  total: number;
  missing: string[];
  blockingGates: GateId[];
  gates: GateResult[];
  outcome: 'READY' | 'DEGRADED' | 'REPAIR' | 'FAILED';
  message: string;
  lastReadAt: string | null;
}

const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FORMULE_TZ || 'Europe/Paris' }) : 'inconnue');

export function certify(gates: GateResult[], reqs: RequirementStatus[], lastReadAt: string | null, opts: { repairable?: boolean } = {}): CertificationReport {
  const all = Object.keys(GATES) as GateId[];
  const byId = new Map(gates.map((g) => [g.gate, g]));
  // Une porte absente = non prouvée = échouée.
  const normalized: GateResult[] = all.map((id) => byId.get(id) ?? { gate: id, passed: false, details: ['porte non évaluée'] });
  const mandatory = reqs.filter((r) => r.mandatory);
  const covered = mandatory.filter((r) => r.status === 'covered').length;
  const unmet = mandatory.filter((r) => r.status !== 'covered');
  const missing = unmet.map((r) => r.label);
  const unmetText = unmet.map((r) => {
    const state = r.status === 'unavailable' ? 'techniquement indisponible' : 'non conforme';
    return r.reason ? `${r.label} (${state} : ${r.reason})` : `${r.label} (${state})`;
  });
  const pct = mandatory.length ? Math.round((covered / mandatory.length) * 100) : 0;
  const rate = mandatory.length ? `conformité ${pct} % (${covered}/${mandatory.length} exigences)` : 'aucune exigence obligatoire';
  const complete = mandatory.length > 0 && missing.length === 0;
  // G6 est recalculée ici à partir des exigences : impossible de la déclarer réussie à la main.
  const g6 = normalized.find((g) => g.gate === 'G6')!;
  g6.passed = g6.passed && complete;
  if (!complete) g6.details = [...g6.details, `exigences manquantes : ${missing.join(', ') || 'aucune exigence obligatoire déclarée'}`];
  const blocking = normalized.filter((g) => !g.passed).map((g) => g.gate);
  const certified = blocking.length === 0;
  const onlyG6 = blocking.length === 1 && blocking[0] === 'G6';
  let outcome: CertificationReport['outcome'];
  let message: string;
  if (certified) {
    outcome = 'READY';
    message = `Application créée et certifiée : ${rate}, conformes et testées. Dernière lecture : ${hhmm(lastReadAt)}.`;
  } else if (onlyG6 && covered > 0) {
    outcome = 'DEGRADED';
    message = `Conformité ${pct} % (${covered}/${mandatory.length} exigences). Non satisfaites : ${unmetText.join(' ; ')}. Non certifiée complète.`;
  } else {
    outcome = opts.repairable ? 'REPAIR' : 'FAILED';
    message = `Non certifiée : ${rate}. ${blocking.map((g) => `${g} (${GATES[g]})`).join(', ')} en échec.`;
  }
  return { certified, complete, covered, total: mandatory.length, missing, blockingGates: blocking, gates: normalized, outcome, message, lastReadAt };
}
