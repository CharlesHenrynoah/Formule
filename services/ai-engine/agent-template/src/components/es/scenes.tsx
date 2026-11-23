/**
 * SCÈNES VIVANTES (simulation poussée, rendus 3D de concepts), pilotées par le contremaître ou par le code de l'app.
 *  - kind 'pixi'  : PixiJS v8 (2D WebGL/WebGPU) — particle-flow, agent-sim, live-heatmap, network-graph
 *  - kind 'three' : three.js (3D)               — 3d-bars, 3d-surface, 3d-concept-model
 * Les bibliothèques ne sont PAS dans le bundle de l'app : chargées à la demande depuis le runtime local du studio
 * (/runtime/pixi.min.js, /runtime/three.min.js), une seule fois, seulement si une scène est affichée.
 * Scène sur mesure : <Scene kind="pixi" custom={(PIXI, app, spec) => ({ update(spec) {}, destroy() {} })} />
 */
import { useEffect, useRef, useState } from 'react';
import { VIZ, UI, STATUS } from './theme';
import { ErrorBoundary } from './boundary';

export const SCENES = { pixi: ['particle-flow', 'agent-sim', 'live-heatmap', 'network-graph'], three: ['3d-bars', '3d-surface', '3d-concept-model'] } as const;
export type SceneKind = keyof typeof SCENES;
export type SceneSpec = { id?: string; kind: SceneKind; scene?: string; title?: string; data?: any; params?: Record<string, number | string | boolean> };
type Instance = { update(spec: SceneSpec): void; destroy(): void };
/** Interface standard d'une scène SUR MESURE (générée par le Développeur) : données MCP + paramètres de simulation en direct,
 *  événements renvoyés (clic sur une étape, goulot…), nettoyage complet du renderer dans destroy(). */
export type SceneCtx = { app?: any; el: HTMLElement; width: number; height: number; onEvent: (event: string, value?: unknown) => void };
export type CustomScene = (lib: any, ctx: SceneCtx, spec: SceneSpec) => Instance;
// Registre des scènes sur mesure de l'app : le contremaître peut les afficher par leur nom (ui_render_scene).
const registry = new Map<string, { kind: SceneKind; factory: CustomScene }>();
export const registerScene = (name: string, kind: SceneKind, factory: CustomScene) => { registry.set(name, { kind, factory }); };
export const sceneExists = (kind: SceneKind, name: string) => (SCENES[kind] as readonly string[]).includes(name) || registry.get(name)?.kind === kind;
export const customScenes = () => [...registry.entries()].map(([name, v]) => ({ name, kind: v.kind }));

const base = () => ((window as any).__ES_RUNTIME__ as string | undefined) ?? '/runtime';
const libs: Record<string, Promise<any>> = {};
export const loadLib = (kind: SceneKind) => (libs[kind] ??= import(/* @vite-ignore */ `${base()}/${kind === 'pixi' ? 'pixi.min.js' : 'three.min.js'}`));

const PALETTE = [...VIZ];
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const heat = (t: number) => { // 0..1 → bleu nuit → cyan → jaune → rose
  const s = [[15, 23, 42], [34, 211, 238], [251, 191, 36], [244, 63, 94]]; const x = Math.max(0, Math.min(0.999, t)) * 3; const i = Math.floor(x); const f = x - i;
  const c = s[i].map((a, k) => Math.round(a + (s[i + 1][k] - a) * f)); return (c[0] << 16) | (c[1] << 8) | c[2];
};

// ---------------- PixiJS ----------------
function pixiScene(PIXI: any, app: any, spec0: SceneSpec): Instance {
  let spec = spec0; const W = () => app.screen.width; const H = () => app.screen.height;
  const g = new PIXI.Graphics(); app.stage.addChild(g);
  const labels = new PIXI.Container(); app.stage.addChild(labels);
  const text = (t: string, x: number, y: number, color = UI.muted) => { const o = new PIXI.Text({ text: t, style: { fill: color, fontSize: 11, fontFamily: 'ui-monospace, monospace' } }); o.x = x; o.y = y; labels.addChild(o); return o; };
  let state: any = {}; let tick = 0;
  const setup = () => {
    labels.removeChildren(); const d = spec.data ?? {}; const p = spec.params ?? {};
    if (spec.scene === 'agent-sim') {
      const groups = (Array.isArray(d.groups) ? d.groups : [{ label: 'agents', count: num(d.count ?? p.count, 300) }]) as Array<{ label: string; count: number; color?: number }>;
      state.agents = groups.flatMap((gr, gi) => Array.from({ length: Math.min(3000, num(gr.count, 100)) }, () => ({ x: Math.random() * W(), y: Math.random() * H(), vx: Math.random() - 0.5, vy: Math.random() - 0.5, g: gi })));
      groups.forEach((gr, i) => text(`● ${gr.label} (${gr.count})`, 8, 8 + i * 14, PALETTE[i % 6]));
      state.groups = groups;
    } else if (spec.scene === 'network-graph') {
      const nodes = (d.nodes ?? []).map((n: any, i: number) => ({ ...n, id: String(n.id ?? i), x: W() / 2 + Math.cos(i) * 80 * Math.random() + 1, y: H() / 2 + Math.sin(i) * 80 * Math.random() + 1, vx: 0, vy: 0 }));
      state.nodes = nodes; state.edges = (d.edges ?? []).map((e: any) => ({ ...e, a: nodes.find((n: any) => n.id === String(e.source ?? e.from)), b: nodes.find((n: any) => n.id === String(e.target ?? e.to)) })).filter((e: any) => e.a && e.b);
      state.nodeLabels = nodes.map((n: any) => text(String(n.label ?? n.id), n.x, n.y, UI.text));
    } else if (spec.scene === 'live-heatmap') {
      const v: number[][] = Array.isArray(d.values) ? d.values : [];
      state.v = v; state.max = Math.max(1e-9, ...v.flat().map(Number)); state.min = Math.min(...v.flat().map(Number), 0);
    } else { // particle-flow
      const flows = (Array.isArray(d.flows) ? d.flows : [{ from: 'source', to: 'cible', value: 100 }]) as Array<{ from: string; to: string; value: number }>;
      const srcs = [...new Set(flows.map((f) => f.from))]; const dsts = [...new Set(flows.map((f) => f.to))];
      state.flows = flows; state.srcs = srcs; state.dsts = dsts; state.parts = []; state.max = Math.max(1, ...flows.map((f) => num(f.value, 0)));
      srcs.forEach((s, i) => text(s, 8, ((i + 0.5) / srcs.length) * H() - 6, UI.text));
      dsts.forEach((s, i) => { const t = text(s, 0, ((i + 0.5) / dsts.length) * H() - 6, UI.text); t.x = W() - t.width - 8; });
    }
  };
  setup();
  const frame = (dt: number) => {
    tick += dt; g.clear(); const p = spec.params ?? {}; const speed = num(p.speed, 1);
    if (spec.scene === 'agent-sim') {
      const attr = num(p.attraction, 0); const cx = W() / 2; const cy = H() / 2; const noise = num(p.noise, 0.3);
      for (const a of state.agents) {
        a.vx += (Math.random() - 0.5) * noise * 0.2 + (cx - a.x) * attr * 1e-4; a.vy += (Math.random() - 0.5) * noise * 0.2 + (cy - a.y) * attr * 1e-4;
        const v = Math.hypot(a.vx, a.vy); const m = 1.6 * speed; if (v > m) { a.vx *= m / v; a.vy *= m / v; }
        a.x += a.vx * dt; a.y += a.vy * dt;
        if (a.x < 0 || a.x > W()) a.vx *= -1; if (a.y < 0 || a.y > H()) a.vy *= -1;
        g.circle(a.x, a.y, 2.2).fill({ color: state.groups[a.g]?.color ?? PALETTE[a.g % 6], alpha: 0.85 });
      }
    } else if (spec.scene === 'network-graph') {
      const N = state.nodes; // petite simulation de forces
      for (const a of N) { for (const b of N) if (a !== b) { const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01; a.vx += dx / d2 * 30; a.vy += dy / d2 * 30; } a.vx += (W() / 2 - a.x) * 0.002; a.vy += (H() / 2 - a.y) * 0.002; }
      for (const e of state.edges) { const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1, f = (d - 90) * 0.004; e.a.vx += dx / d * f * d; e.a.vy += dy / d * f * d; e.b.vx -= dx / d * f * d; e.b.vy -= dy / d * f * d; }
      N.forEach((n: any, i: number) => { n.vx *= 0.82; n.vy *= 0.82; n.x = Math.max(20, Math.min(W() - 20, n.x + n.vx * 0.05 * dt)); n.y = Math.max(20, Math.min(H() - 20, n.y + n.vy * 0.05 * dt)); state.nodeLabels[i].x = n.x + 8; state.nodeLabels[i].y = n.y - 6; });
      for (const e of state.edges) {
        const w = Math.max(0.5, Math.min(5, num(e.value, 1) / 20)); g.moveTo(e.a.x, e.a.y).lineTo(e.b.x, e.b.y).stroke({ width: w, color: UI.line, alpha: 0.6 });
        const t = ((tick * 0.01 * speed) + (e.a.x % 1)) % 1; g.circle(e.a.x + (e.b.x - e.a.x) * t, e.a.y + (e.b.y - e.a.y) * t, 2.5).fill({ color: VIZ[0] });
      }
      N.forEach((n: any, i: number) => g.circle(n.x, n.y, 5 + Math.min(12, num(n.value, 0) / 10)).fill({ color: n.alert ? STATUS.alert : PALETTE[i % 6], alpha: 0.9 }));
    } else if (spec.scene === 'live-heatmap') {
      const v = state.v; const R = v.length; const C = v[0]?.length ?? 0; if (!R || !C) return;
      const cw = W() / C, ch = H() / R; const pulse = num(p.pulse, 1);
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
        const t = (Number(v[r][c]) - state.min) / (state.max - state.min || 1); const wob = 0.06 * pulse * Math.sin(tick * 0.05 + r * 0.7 + c * 0.4);
        g.roundRect(c * cw + 1, r * ch + 1, cw - 2, ch - 2, 3).fill({ color: heat(t + wob), alpha: 0.92 });
      }
    } else {
      const rate = num(p.rate, 1) * speed; const srcY = (s: string) => ((state.srcs.indexOf(s) + 0.5) / state.srcs.length) * H(); const dstY = (s: string) => ((state.dsts.indexOf(s) + 0.5) / state.dsts.length) * H();
      for (const f of state.flows) { const n = (num(f.value, 0) / state.max) * 0.9 * rate * dt; for (let k = 0; k < Math.floor(n + Math.random()); k++) state.parts.push({ f, t: 0, j: (Math.random() - 0.5) * 18, c: PALETTE[state.flows.indexOf(f) % 6] }); }
      if (state.parts.length > 2500) state.parts.splice(0, state.parts.length - 2500);
      for (const f of state.flows) { const y1 = srcY(f.from), y2 = dstY(f.to); g.moveTo(90, y1).bezierCurveTo(W() / 2, y1, W() / 2, y2, W() - 90, y2).stroke({ width: Math.max(1, num(f.value, 0) / state.max * 10), color: UI.line, alpha: 0.6 }); }
      state.parts = state.parts.filter((q: any) => (q.t += 0.006 * speed * dt) < 1);
      for (const q of state.parts) { const y1 = srcY(q.f.from), y2 = dstY(q.f.to), t = q.t, u = 1 - t; const x = u * u * u * 90 + 3 * u * u * t * W() / 2 + 3 * u * t * t * W() / 2 + t * t * t * (W() - 90); const y = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2 + q.j * Math.sin(t * Math.PI); g.circle(x, y, 1.8).fill({ color: q.c, alpha: 0.9 }); }
    }
  };
  app.ticker.add((t: any) => frame(Math.min(3, t.deltaTime)));
  return {
    update(next) { const reset = next.scene !== spec.scene || JSON.stringify(next.data) !== JSON.stringify(spec.data); spec = next; if (reset) { state = {}; setup(); } },
    destroy() { app.destroy(true, { children: true }); },
  };
}

// ---------------- three.js ----------------
function threeScene(THREE: any, el: HTMLElement, spec0: SceneSpec): Instance {
  let spec = spec0;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6)); const dl = new THREE.DirectionalLight(0xffffff, 1.1); dl.position.set(5, 10, 7); scene.add(dl);
  let group = new THREE.Group(); scene.add(group);
  const grid = new THREE.GridHelper(20, 20, UI.line, UI.grid); scene.add(grid);
  const build = () => {
    scene.remove(group); group = new THREE.Group(); scene.add(group); const d = spec.data ?? {}; const p = spec.params ?? {};
    if (spec.scene === '3d-surface') {
      const v: number[][] = Array.isArray(d.values) ? d.values : Array.from({ length: 30 }, (_, i) => Array.from({ length: 30 }, (_, j) => Math.sin(i / 4) * Math.cos(j / 5)));
      const R = v.length, C = v[0].length; const flat = v.flat().map(Number); const mn = Math.min(...flat), mx = Math.max(...flat); const amp = num(p.amplitude, 4);
      const geo = new THREE.PlaneGeometry(12, 12, C - 1, R - 1); const pos = geo.attributes.position; const cols: number[] = [];
      for (let k = 0; k < pos.count; k++) { const t = (flat[k] - mn) / (mx - mn || 1); pos.setZ(k, t * amp); const c = new THREE.Color(heat(t)); cols.push(c.r, c.g, c.b); }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.5 })); m.rotation.x = -Math.PI / 2; group.add(m);
      const w = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: UI.ink, wireframe: true, transparent: true, opacity: 0.12 })); w.rotation.x = -Math.PI / 2; group.add(w);
    } else if (spec.scene === '3d-concept-model') {
      const nodes = (d.nodes ?? []) as Array<{ id: string; label?: string; size?: number; group?: number }>; const pos: Record<string, any> = {};
      nodes.forEach((n, i) => { const phi = Math.acos(1 - 2 * (i + 0.5) / nodes.length), th = Math.PI * (1 + Math.sqrt(5)) * i; const r = 5; const v = new THREE.Vector3(r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi) + 3, r * Math.sin(phi) * Math.sin(th)); pos[String(n.id)] = v;
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.25 + Math.min(1, num(n.size, 1) / 5), 24, 16), new THREE.MeshStandardMaterial({ color: PALETTE[num(n.group, i) % 6], emissive: PALETTE[num(n.group, i) % 6], emissiveIntensity: 0.35 })); s.position.copy(v); group.add(s); });
      for (const e of (d.edges ?? []) as Array<{ source: string; target: string }>) { const a = pos[String(e.source)], b = pos[String(e.target)]; if (a && b) group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: VIZ[0], transparent: true, opacity: 0.5 }))); }
    } else { // 3d-bars
      const rows = (Array.isArray(d) ? d : d.bars ?? []) as Array<{ label?: string; value: number; group?: number }>; const mx = Math.max(1e-9, ...rows.map((r) => num(r.value, 0))); const h = num(p.height, 6); const n = rows.length; const side = Math.ceil(Math.sqrt(n));
      rows.forEach((r, i) => { const t = num(r.value, 0) / mx; const b = new THREE.Mesh(new THREE.BoxGeometry(0.8, Math.max(0.05, t * h), 0.8), new THREE.MeshStandardMaterial({ color: heat(0.25 + t * 0.7), emissive: heat(t), emissiveIntensity: 0.25 })); b.position.set((i % side - side / 2) * 1.2, Math.max(0.05, t * h) / 2, (Math.floor(i / side) - side / 2) * 1.2); group.add(b); });
    }
  };
  build();
  const ro = new ResizeObserver(() => { const w = el.clientWidth || 300, hh = el.clientHeight || 220; renderer.setSize(w, hh); camera.aspect = w / hh; camera.updateProjectionMatrix(); }); ro.observe(el);
  let t = 0; renderer.setAnimationLoop(() => { t += 0.004 * num(spec.params?.speed, 1); camera.position.set(Math.cos(t) * 16, 9, Math.sin(t) * 16); camera.lookAt(0, 2, 0); renderer.render(scene, camera); });
  return { update(next) { const rebuild = next.scene !== spec.scene || JSON.stringify(next.data) !== JSON.stringify(spec.data) || JSON.stringify(next.params) !== JSON.stringify(spec.params); spec = next; if (rebuild) build(); }, destroy() { renderer.setAnimationLoop(null); ro.disconnect(); renderer.dispose(); renderer.domElement.remove(); } };
}

/** Scène vivante : chargement paresseux de PixiJS / three.js, mise à jour en direct quand spec.data / spec.params changent. */
type SceneProps = { spec: SceneSpec; custom?: CustomScene; height?: number; className?: string; onEvent?: (event: string, value?: unknown) => void };
/** Rendu défensif : type/scène inconnus → repli lisible ; plantage du rendu → error boundary locale. */
export function Scene(props: SceneProps) {
  const { spec, custom, height = 260, className } = props;
  const kindOk = spec && (spec.kind === 'pixi' || spec.kind === 'three');
  const sceneOk = kindOk && (!!custom || !spec.scene || sceneExists(spec.kind, spec.scene));
  if (!kindOk || !sceneOk) return <div className={className} style={{ height }} data-testid="scene-fallback"><div className="grid h-full place-items-center rounded-lg border border-amber-500/30 text-xs text-amber-700">Visualisation inconnue : {String(spec?.kind)}/{String(spec?.scene ?? '—')} (non affichée)</div></div>;
  return <ErrorBoundary name={`visualisation ${spec.scene ?? spec.kind}`} compact><SceneView {...props} /></ErrorBoundary>;
}

function SceneView({ spec, custom: custom0, height = 260, className, onEvent }: SceneProps) {
  const custom = custom0 ?? (spec.scene ? registry.get(spec.scene)?.factory : undefined);
  const evRef = useRef(onEvent); evRef.current = onEvent;
  const emit = (event: string, value?: unknown) => evRef.current?.(event, value);
  const el = useRef<HTMLDivElement>(null); const inst = useRef<Instance | null>(null); const specRef = useRef(spec); specRef.current = spec;
  const [err, setErr] = useState<string | null>(null); const [ready, setReady] = useState(false);
  useEffect(() => {
    let dead = false; const host = el.current!;
    (async () => {
      try {
        const lib = await loadLib(spec.kind); if (dead) return;
        if (spec.kind === 'pixi') {
          const app = new lib.Application(); await app.init({ resizeTo: host, backgroundAlpha: 0, antialias: true, preference: 'webgl' }); if (dead) { app.destroy(true); return; }
          host.appendChild(app.canvas);
          inst.current = custom ? custom(lib, { app, el: host, width: host.clientWidth, height: host.clientHeight, onEvent: emit }, specRef.current) : pixiScene(lib, app, specRef.current);
        } else inst.current = custom ? custom(lib, { el: host, width: host.clientWidth, height: host.clientHeight, onEvent: emit }, specRef.current) : threeScene(lib, host, specRef.current);
        setReady(true);
      } catch (e) { setErr(`rendu ${spec.kind} indisponible : ${(e as Error).message}`); }
    })();
    return () => { dead = true; inst.current?.destroy(); inst.current = null; };
  }, [spec.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { inst.current?.update(spec); }, [JSON.stringify(spec)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={className} style={{ position: 'relative', height }} data-testid="scene" data-scene={spec.scene} data-ready={ready ? '1' : '0'}>
      <div ref={el} style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 8 }} />
      {!ready && !err && <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">chargement du rendu {spec.kind === 'pixi' ? 'PixiJS' : 'three.js'}…</div>}
      {err && <div className="absolute inset-0 grid place-items-center text-xs text-amber-700">{err}</div>}
    </div>
  );
}
