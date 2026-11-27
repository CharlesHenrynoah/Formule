import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';

const cert = (certified: boolean) => ({ certified });

describe('stockage : versions et promotion atomique', () => {
  it('la dernière version certifiée reste active quand un candidat échoue ou est partiel', () => {
    const s = new Store(':memory:');
    const p = s.createProject('T', false) as { id: string };
    const n1 = s.addCandidate(p.id, { spec: { v: 1 }, html: 'a', bundle: {}, certification: cert(true), jobId: 'j1', parentN: null });
    expect(s.promote(p.id, n1, 'certified').promoted).toBe(true);
    const n2 = s.addCandidate(p.id, { spec: { v: 2 }, html: 'b', bundle: {}, certification: cert(false), jobId: 'j2', parentN: 1 });
    expect(() => s.promote(p.id, n2, 'certified')).toThrow(/non certifiée/);
    expect(s.promote(p.id, n2, 'partial').promoted).toBe(false);
    expect((s.activeVersion(p.id) as { n: number }).n).toBe(1);
  });
  it('restauration et isolation à la suppression', () => {
    const s = new Store(':memory:');
    const a = s.createProject('A', false) as { id: string };
    const b = s.createProject('B', false) as { id: string };
    for (const i of [1, 2]) { const n = s.addCandidate(a.id, { spec: { i }, html: '', bundle: {}, certification: cert(true), jobId: 'j', parentN: null }); s.promote(a.id, n, 'certified'); }
    s.addCandidate(b.id, { spec: {}, html: '', bundle: {}, certification: cert(true), jobId: 'j', parentN: null });
    expect(s.restore(a.id, 1).active).toBe(1);
    expect((s.getVersion(a.id, 2) as { status: string }).status).toBe('SUPERSEDED');
    expect(() => s.restore(b.id, 1)).toThrow(); // candidate jamais publiée
    s.putSnapshot({ envelope: { id: 'acq_1', hash: null }, raw: null, projectId: a.id, jobId: null });
    s.deleteProject(a.id);
    expect(s.getSnapshot('acq_1')).toBeNull();
    expect(s.listVersions(b.id)).toHaveLength(1);
  });
  it('transitions de job vérifiées et seq monotone', () => {
    const s = new Store(':memory:');
    const job = s.createJob({ projectId: null, kind: 'build', mode: 'agent', prompt: 'x' }) as { id: string };
    expect(() => s.transition(job.id, 'ACTIVE')).toThrow(/Transition refusée/);
    s.transition(job.id, 'DISCOVERY');
    const seqs = [1, 2, 3].map(() => s.appendEvent({ jobId: job.id, projectId: null, version: null, type: 'log', payload: {} }).seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(s.events(job.id, 1)).toHaveLength(2);
  });
  it('un nonce de confirmation ne sert qu’une fois', () => {
    const s = new Store(':memory:');
    const o1 = s.createOp({ opHash: 'h', projectId: null, serverId: 's', tool: 't', args: {} }) as { id: string };
    const o2 = s.createOp({ opHash: 'h', projectId: null, serverId: 's', tool: 't', args: {} }) as { id: string };
    s.updateOp(o1.id, { status: 'confirmed', nonce: 'n1' });
    expect(() => s.updateOp(o2.id, { status: 'confirmed', nonce: 'n1' })).toThrow(/déjà utilisée/);
  });
});
