// Tests des corrections issues de l'audit (web) : quota IA, retour des statuts, file de validation, réponse locale.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { confidentLocalMatch, type Place } from './fuzzy';
import { db, newId, type Survey } from './db';
import { pullSurveyStatuses, pushSurveys, reviewApi, SESSION_EXPIRED } from './sync';

const P = (id: string, name: string, extra: Partial<Place> = {}): Place => ({ id, name, type_label: 'Bâtiment', type: 'batiment', ...extra });
const PLACES: Place[] = [P('p1', 'Bâtiment D3', { number: 'D3' }), P('p2', 'Bâtiment D4', { number: 'D4' }), P('p3', 'Terrain omnisport', { type_label: 'Sport', type: 'terrain' }),
  P('e1', 'Étage 1', { type_label: 'Étage', type: 'etage', parent_id: 'p1' }), P('c1', 'Chambre 25', { type_label: 'Chambre', type: 'chambre', parent_id: 'e1' }),
  P('c2', 'Chambre 25', { type_label: 'Chambre', type: 'chambre', parent_id: 'p2' }), P('w1', 'Point d’eau nord', { type_label: 'Point d’eau', type: 'eau' }), P('w2', 'Point d’eau sud', { type_label: 'Point d’eau', type: 'eau' })];

describe('réponse locale sans IA (économie de quota)', () => {
  it('une désignation sans ambiguïté est résolue localement', () => {
    expect(confidentLocalMatch('bâtiment D3', PLACES)?.id).toBe('p1');
    expect(confidentLocalMatch('D3', PLACES)?.id).toBe('p1');                 // le bâtiment, pas ses chambres
    expect(confidentLocalMatch('terrain omnisport', PLACES)?.id).toBe('p3');
  });
  it('une demande de trajet ou de catégorie part au serveur (le modèle décide)', () => {
    expect(confidentLocalMatch('comment aller au terrain omnisport', PLACES)).toBeNull();
    expect(confidentLocalMatch('itinéraire bâtiment D3', PLACES)).toBeNull();
    expect(confidentLocalMatch('où trouver un point d’eau', PLACES)).toBeNull();
  });
  it('un doute (ambigu, inconnu, vide) n’est jamais tranché localement', () => {
    expect(confidentLocalMatch('chambre 25', PLACES)).toBeNull();            // deux bâtiments
    expect(confidentLocalMatch('D9', PLACES)).toBeNull();
    expect(confidentLocalMatch('D3 ou D4 ?', PLACES)).toBeNull();
    expect(confidentLocalMatch('le la les', PLACES)).toBeNull();
    expect(confidentLocalMatch('point d’eau', PLACES)).toBeNull();           // deux points d'eau
  });
});

const base = (o: Partial<Survey> = {}): Survey => ({ id: newId(), kind: 'point', name: 'Relevé synthétique', placeType: 'repere', notes: '', points: [[0, 0]], accuracies: [4], capturedAt: [1], orientation: null, status: 'a_verifier', version: 1, updatedAt: 1, synced: false, ...o });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => { await db.surveys.clear(); await db.photos.clear(); });

describe('synchronisation des relevés', () => {
  it('reprend la version du serveur : la resoumission après correction n’est plus un « conflit »', async () => {
    const s = base(); await db.surveys.put(s);
    vi.stubGlobal('fetch', vi.fn(async () => json({ results: [{ id: s.id, ok: true, version: 2 }] })));
    const r = await pushSurveys('t'); expect(r.pushed).toBe(1);
    expect((await db.surveys.get(s.id))?.version).toBe(2);
  });
  it('rapatrie le statut et le motif de rejet, sans écraser une modification locale en attente', async () => {
    const a = base({ synced: true, version: 2 }), b = base({ synced: false, status: 'en_cours', version: 2 }), c = base({ synced: true, version: 2 });
    await db.surveys.bulkPut([a, b, c]);
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: a.id, status: 'a_corriger', version: 3, reject_reason: 'trop imprécis' }, { id: b.id, status: 'a_corriger', version: 3, reject_reason: 'x' }, { id: c.id, status: 'publie', version: 2 }])));
    expect(await pullSurveyStatuses('t')).toBe(2);
    const A = await db.surveys.get(a.id); expect(A?.status).toBe('a_corriger'); expect(A?.rejectReason).toBe('trop imprécis'); expect(A?.version).toBe(3);
    expect((await db.surveys.get(b.id))?.status).toBe('en_cours');           // modification locale préservée
    expect((await db.surveys.get(c.id))?.status).toBe('publie');
    expect(await pullSurveyStatuses('t')).toBe(0);                            // idempotent
  });
  it('une photo refusée définitivement n’est pas renvoyée à chaque synchro', async () => {
    const s = base({ synced: false }); await db.surveys.put(s); await db.photos.put({ id: 'ph1', surveyId: s.id, blob: new Blob(['x']), uploaded: false });
    const f = vi.fn(async (url?: unknown) => String(url).endsWith('/sync') ? json({ results: [{ id: s.id, ok: true, version: 2 }] }) : json({ detail: 'Photo trop lourde (max 2 Mo)' }, 413));
    vi.stubGlobal('fetch', f);
    const r = await pushSurveys('t'); expect(r.photoErrors).toBe(1); expect((await db.photos.get('ph1'))?.error).toMatch(/trop lourde/);
    const calls = f.mock.calls.length; await pushSurveys('t'); expect(f.mock.calls.length).toBe(calls);   // plus aucun envoi : ni relevé en file, ni photo à réessayer
  });
});

describe('file de validation', () => {
  it('une session expirée lève une erreur claire au lieu de renvoyer un objet qui fait planter l’écran', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Non authentifié' }, 401)));
    await expect(reviewApi.list('t')).rejects.toThrow(SESSION_EXPIRED);
  });
  it('renvoie toujours un tableau', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'bizarre' }, 200))); expect(await reviewApi.list('t')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: 'a' }]))); expect(await reviewApi.list('t')).toHaveLength(1);
  });
});

import { shortestPath as sp, type Graph } from './graph';
describe('Dijkstra à tas binaire', () => {
  it('choisit le chemin le plus court parmi plusieurs et renvoie null sans liaison', () => {
    const P: [number, number][] = [[0, 0], [0.001, 0], [0.002, 0], [0.001, 0.001]];
    const nodes = new Map(P.map((p, i) => [String(i), p])); const adj = new Map<string, { to: string; w: number }[]>(P.map((_, i) => [String(i), []]));
    const L = (a: string, b: string, w: number) => { adj.get(a)!.push({ to: b, w }); adj.get(b)!.push({ to: a, w }); };
    L('0', '1', 100); L('1', '2', 100); L('0', '3', 10); L('3', '2', 10);
    const g: Graph = { nodes, adj };
    expect(sp(g, '0', '2')!.keys).toEqual(['0', '3', '2']);
    adj.set('9', []); nodes.set('9', [1, 1]); expect(sp(g, '0', '9')).toBeNull();
  });
});

import Dexie from 'dexie';
import { MaCiteDB } from './db';
describe('migration IndexedDB v4 : category disparaît', () => {
  it('relevés : category -> placeType ; lieux publiés : category (libellé) -> type_label ; rien de perdu', async () => {
    const name = 'migration-v4-' + Math.random();
    const old = new Dexie(name);   // base telle qu'elle existe sur un téléphone avant la mise à jour (version 3)
    old.version(3).stores({ surveys: 'id, status, synced, updatedAt', published: 'id, name, category', photos: 'id, surveyId', offlineMap: 'id' });
    await old.table('surveys').put({ id: 's1', kind: 'point', name: 'Ancien relevé', category: 'entree', notes: '', status: 'brouillon', version: 1, updatedAt: 1, synced: false });
    await old.table('published').put({ id: 'p1', kind: 'point', name: 'Bâtiment D3', category: 'Bâtiment', type: 'batiment', points: [[0, 0]], mapVersion: 3 });
    await old.table('published').put({ id: 'p2', kind: 'point', name: 'Sans libellé', category: 'Sport', points: [[0, 0]], mapVersion: 3 });
    old.close();
    const neu = new MaCiteDB(name);
    const s = (await neu.surveys.get('s1')) as unknown as Record<string, unknown>; const p1 = (await neu.published.get('p1')) as unknown as Record<string, unknown>; const p2 = (await neu.published.get('p2')) as unknown as Record<string, unknown>;
    expect(s.placeType).toBe('entree'); expect('category' in s).toBe(false); expect(s.name).toBe('Ancien relevé');
    expect(p1.type_label).toBe('Bâtiment'); expect('category' in p1).toBe(false); expect(p1.type).toBe('batiment'); expect(p2.type_label).toBe('Sport');
    expect((await neu.published.where('type_label').equals('Bâtiment').toArray()).map(x => x.id)).toEqual(['p1']);   // le nouvel index fonctionne
    neu.close(); await Dexie.delete(name);
  });
});
