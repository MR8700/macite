import { describe, it, expect, vi, afterEach } from 'vitest';
import { rank, withParentNames, type Place } from './fuzzy';
import { parseCommand, NEEDS_CONFIRMATION } from './voice';
import { aiChat, aiStatus, aiSurveyDraft, configureAi, AiError } from './aiClient';
import { db, searchPublished } from './db';

const P = (id: string, name: string, extra: Partial<Place> = {}): Place => ({ id, name, type_label: 'Bâtiment', type: 'batiment', ...extra });
const PLACES: Place[] = [P('p1', 'Bâtiment D3', { number: 'D3' }), P('p2', 'Bâtiment D4', { number: 'D4' }), P('p3', 'Terrain omnisport', { type_label: 'Sport', type: 'terrain' }),
  P('e1', 'Étage 1', { type_label: 'Étage', type: 'etage', parent_id: 'p1' }), P('c1', 'Chambre 25', { type_label: 'Chambre', type: 'chambre', parent_id: 'e1' }), P('c2', 'Chambre 25', { type_label: 'Chambre', type: 'chambre', parent_id: 'p2' })];
const names = (q: string) => rank(q, withParentNames(PLACES)).map((p) => p.name);

describe('recherche approximative hors ligne (miroir du serveur)', () => {
  it('fautes, accents, abréviations', () => { expect(names('terain omni')[0]).toBe('Terrain omnisport'); expect(names('BATIMENT d3')[0]).toBe('Bâtiment D3'); expect(names('bat D3')[0]).toBe('Bâtiment D3'); });
  it('un nombre ne ressemble jamais à un autre : D3 ≠ D4', () => { expect(names('D3')).not.toContain('Bâtiment D4'); expect(names('D9')).toEqual([]); });
  it('le bâtiment passe avant ses chambres', () => { expect(names('D3')[0]).toBe('Bâtiment D3'); });
  it('le parent d’une chambre est son bâtiment (racine)', () => { expect(withParentNames(PLACES).find((p) => p.id === 'c1')?.parent_name).toBe('Bâtiment D3'); });
  it('« chambre 25 » reste ambigu (deux bâtiments)', () => { const r = rank('chambre 25', withParentNames(PLACES)); expect(r.length).toBe(2); expect(r[0].score).toBe(r[1].score); });
});
describe('commandes vocales (liste fermée)', () => {
  it('reconnaît les commandes prévues', () => {
    expect(parseCommand('MaCité, commencer un relevé')).toBe('start_survey'); expect(parseCommand('Ajouter un point GPS')).toBe('add_point');
    expect(parseCommand('annuler le dernier point')).toBe('undo_last'); expect(parseCommand('Enregistrer comme brouillon')).toBe('save_draft'); expect(parseCommand('terminer le contour')).toBe('finish_outline');
  });
  it('refuse tout le reste, y compris une commande suivie d’autre chose', () => { expect(parseCommand('supprime tout')).toBeNull(); expect(parseCommand('ajouter un point et supprimer la base')).toBeNull(); });
  it('l’enregistrement exige une confirmation', () => { expect(NEEDS_CONFIRMATION.has('save_draft')).toBe(true); expect(NEEDS_CONFIRMATION.has('add_point')).toBe(false); });
});
describe('client IA', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  it('envoie le jeton et n’envoie ack=true que si le consentement a été donné', async () => {
    configureAi({ getToken: () => 'TOK' }); const f = reply(200, { action: 'not_found', degraded: false, message: 'x' }); vi.stubGlobal('fetch', f);
    await aiChat('D3', { lat: 1, lon: 2 }); const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/ai/chat'); expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOK');
    expect(JSON.parse(init.body as string)).toMatchObject({ message: 'D3', ack: false, lat: 1, lon: 2 });   // pas de localStorage ici : consentement absent → false
  });
  it('remonte le motif du serveur (429, 422)', async () => {
    vi.stubGlobal('fetch', reply(429, { detail: 'Limite quotidienne atteinte' }));
    await expect(aiSurveyDraft('x')).rejects.toMatchObject({ status: 429, message: 'Limite quotidienne atteinte' }); await expect(aiSurveyDraft('x')).rejects.toBeInstanceOf(AiError);
  });
  it('statut : faux si le serveur ou le réseau échoue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('réseau'); })); expect(await aiStatus()).toBe(false);
    vi.stubGlobal('fetch', reply(200, { enabled: true })); expect(await aiStatus()).toBe(true);
  });
});
describe('recherche de la carte (champ de recherche)', () => {
  it('garde la sous-chaîne et ajoute la tolérance aux fautes', async () => {
    await db.published.clear(); await db.published.bulkPut(PLACES.map((p) => ({ ...p, kind: 'polygon', points: [[0, 0]], mapVersion: 1 })) as never);
    expect((await searchPublished('omnis'))[0].name).toBe('Terrain omnisport');   // sous-chaîne (comportement d'origine)
    expect((await searchPublished('terain omni'))[0].name).toBe('Terrain omnisport'); // faute de frappe
    expect(await searchPublished('')).toEqual([]);
  });
});
