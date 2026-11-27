import type { Point } from './series.js';

/**
 * Simulation « dérive linéaire » : aucun effet externe, reproductible, hypothèses explicites.
 * Le scénario part de la dernière valeur observée et applique une variation par période.
 */
export interface SimParams { variation_pct: number; horizon: number }
export interface SimResult { base: Point[]; scenario: Point[]; assumptions: string[]; step: number | null }

export function simulateLinear(points: Point[], p: SimParams): SimResult {
  const obs = points.filter((x) => x.v !== null);
  const assumptions = [
    `variation de ${p.variation_pct >= 0 ? '+' : ''}${p.variation_pct} % par période, appliquée à la dernière valeur observée`,
    `horizon de ${p.horizon} périodes ; période = pas médian observé`,
    'les trous de la série réelle ne sont pas comblés',
  ];
  if (obs.length < 2) return { base: points, scenario: [], assumptions: [...assumptions, 'série trop courte : scénario indisponible'], step: null };
  const steps = obs.slice(1).map((x, i) => x.t - obs[i].t).sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)];
  const last = obs[obs.length - 1];
  if (last.v === 0) assumptions.push('dernière valeur observée nulle : une variation en % la laisse nulle');
  const scenario: Point[] = [{ t: last.t, v: last.v }];
  let v = last.v as number;
  for (let i = 1; i <= Math.max(1, Math.min(120, Math.round(p.horizon))); i++) {
    v = v * (1 + p.variation_pct / 100);
    scenario.push({ t: last.t + i * step, v: Math.round(v * 100) / 100 });
  }
  return { base: points, scenario, assumptions, step };
}
