/**
 * EXEMPLE de scène sur mesure (PixiJS) : « mon tunnel de conversion comme une machine ».
 * Tapis roulants entre étapes, engrenages dont la vitesse suit le débit, particules = visiteurs (1 particule ≈ N visiteurs),
 * pertes qui tombent du tapis selon le taux de chute, goulot d'étranglement qui rougit et fume.
 * data   : { stages: [{ label, value }] }                (volumes réels, ex. issus d'un outil MCP)
 * params : { speed, traffic_pct, boost_stage, boost_pct } (curseurs de simulation, effet immédiat)
 * events : 'stage_click' { label, value, conversion_pct }  → renvoyé au contremaître
 */
import type { CustomScene } from '../scenes';
import { VIZ, UI, STATUS } from '../theme';

export const conversionMachine: CustomScene = (PIXI, ctx, spec0) => {
  const { app } = ctx; let spec = spec0;
  const root = new PIXI.Container(); app.stage.addChild(root);
  const g = new PIXI.Graphics(); root.addChild(g);
  const texts = new PIXI.Container(); root.addChild(texts);
  type P = { seg: number; t: number; falling?: boolean; x: number; y: number; vy: number; lost?: boolean };
  let parts: P[] = []; let smoke: Array<{ x: number; y: number; a: number; r: number }> = []; let tick = 0; let gearAngle: number[] = [];
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

  /** Volumes simulés : trafic d'entrée et boost de conversion d'une étape appliqués aux données réelles. */
  const model = () => {
    const raw = (spec.data?.stages ?? []) as Array<{ label: string; value: number }>; const p = spec.params ?? {};
    const traffic = 1 + num(p.traffic_pct, 0) / 100; const bi = num(p.boost_stage, -1); const boost = 1 + num(p.boost_pct, 0) / 100;
    const out: Array<{ label: string; value: number; rate: number }> = []; let prev = 0;
    raw.forEach((s, i) => {
      const rate = i === 0 ? 1 : Math.min(1, (num(s.value, 0) / Math.max(1, num(raw[i - 1].value, 1))) * (i === bi ? boost : 1));
      const value = i === 0 ? num(s.value, 0) * traffic : prev * rate; prev = value; out.push({ label: s.label, value, rate });
    });
    return out;
  };
  const layout = () => { const st = model(); const W = app.screen.width, H = app.screen.height; const n = Math.max(1, st.length); const gap = W / n;
    return { st, W, H, x: (i: number) => gap * (i + 0.5), y: H * 0.45, gap }; };
  const labels = () => { texts.removeChildren(); const L = layout();
    L.st.forEach((s, i) => { const t = new PIXI.Text({ text: `${s.label}\n${Math.round(s.value).toLocaleString('fr-FR')}${i ? ` · ${Math.round(s.rate * 100)} %` : ''}`, style: { fill: UI.text, fontSize: 11, fontFamily: 'ui-monospace, monospace', align: 'center' } });
      t.anchor.set(0.5, 0); t.x = L.x(i); t.y = L.y + 44; texts.addChild(t); }); };
  labels();
  app.stage.eventMode = 'static'; app.stage.hitArea = app.screen;
  app.stage.on('pointertap', (e: any) => { const L = layout(); const i = Math.floor(e.global.x / L.gap); const s = L.st[i]; if (s) ctx.onEvent('stage_click', { label: s.label, value: Math.round(s.value), conversion_pct: Math.round(s.rate * 1000) / 10 }); });

  const gear = (cx: number, cy: number, r: number, a: number, color: number) => {
    const teeth = 10; g.circle(cx, cy, r).fill({ color, alpha: 0.9 });
    for (let k = 0; k < teeth; k++) { const th = a + (k / teeth) * Math.PI * 2; g.circle(cx + Math.cos(th) * r, cy + Math.sin(th) * r, r * 0.22).fill({ color }); }
    g.circle(cx, cy, r * 0.35).fill({ color: UI.bg });
  };
  const frame = (dt: number) => {
    tick += dt; g.clear(); const L = layout(); const n = L.st.length; if (n < 2) return; const speed = num(spec.params?.speed, 1);
    const max = Math.max(1, ...L.st.map((s) => s.value));
    // goulot = étape avec le plus faible taux de passage
    let worst = 1; L.st.forEach((s, i) => { if (i && s.rate < L.st[worst].rate) worst = i; });
    for (let i = 0; i < n - 1; i++) { // tapis roulants
      const x1 = L.x(i) + 26, x2 = L.x(i + 1) - 26; g.roundRect(x1, L.y - 5, x2 - x1, 10, 5).fill({ color: UI.panel });
      for (let k = 0; k < 8; k++) { const xx = x1 + (((k / 8) + tick * 0.004 * speed) % 1) * (x2 - x1); g.rect(xx, L.y - 5, 2, 10).fill({ color: UI.line }); }
    }
    L.st.forEach((s, i) => { // engrenages : vitesse ∝ débit ; le goulot rougit
      gearAngle[i] = (gearAngle[i] ?? 0) + 0.02 * speed * dt * (s.value / max);
      const hot = i === worst; const pulse = hot ? 0.5 + 0.5 * Math.sin(tick * 0.15) : 0;
      gear(L.x(i), L.y, 22, gearAngle[i] * (i % 2 ? -1 : 1), hot ? ((0xf4 << 16) | (Math.round(63 + 60 * pulse) << 8) | 0x5e) : VIZ[0]);
      if (hot && Math.random() < 0.35 * dt) smoke.push({ x: L.x(i) + (Math.random() - 0.5) * 14, y: L.y - 26, a: 0.6, r: 3 + Math.random() * 3 });
    });
    // entrée de visiteurs ∝ volume du 1er étage
    const spawn = (L.st[0].value / max) * 0.8 * speed * dt; for (let k = 0; k < Math.floor(spawn + Math.random()); k++) parts.push({ seg: 0, t: 0, x: L.x(0), y: L.y, vy: 0 });
    if (parts.length > 1500) parts.splice(0, parts.length - 1500);
    for (const q of parts) {
      if (q.falling) { q.vy += 0.25 * dt; q.y += q.vy * dt; if (q.y > L.H) q.lost = true; g.circle(q.x, q.y, 2).fill({ color: STATUS.alert, alpha: 0.8 }); continue; }
      q.t += 0.012 * speed * dt; const x1 = L.x(q.seg) + 26, x2 = L.x(q.seg + 1) - 26; q.x = x1 + (x2 - x1) * q.t; q.y = L.y - 9;
      if (q.t >= 1) { // arrivée à l'étape k : passe avec la probabilité du taux de conversion, sinon tombe du tapis
        const k = q.seg + 1;
        if (Math.random() > L.st[k].rate) { q.falling = true; q.vy = -1.5; continue; }
        if (k >= n - 1) { q.lost = true; continue; }
        q.seg = k; q.t = 0;
      }
      g.circle(q.x, q.y, 2.2).fill({ color: VIZ[1] });
    }
    parts = parts.filter((q) => !q.lost);
    smoke = smoke.filter((s) => (s.a -= 0.01 * dt) > 0); for (const s of smoke) { s.y -= 0.5 * dt; s.r += 0.05 * dt; g.circle(s.x, s.y, s.r).fill({ color: UI.muted, alpha: s.a * 0.5 }); }
  };
  app.ticker.add((t: any) => frame(Math.min(3, t.deltaTime)));
  return {
    update(next) { spec = next; labels(); },
    destroy() { app.destroy(true, { children: true }); },
  };
};
