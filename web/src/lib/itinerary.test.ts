import { describe, it, expect } from 'vitest';
import { buildNavGraph, type NavPlace } from './nav';
import type { LngLat } from './geo';
import { computeItinerary, outcomeMessage } from './itinerary';
// Même jeu SYNTHÉTIQUE que nav.test.ts : un bâtiment à 3 niveaux.
const o = (m: number): number => m / 111320; const P = (x: number, y: number): LngLat => [o(x), o(y)];
const sq = (x: number, y: number, s: number): LngLat[] => [P(x, y), P(x + s, y), P(x + s, y + s), P(x, y + s)];
function city(stairs = true): NavPlace[] {
  const L: NavPlace[] = [{ id: 'bat', type: 'batiment', kind: 'polygon', name: 'Bât A', points: sq(100, 0, 60) }, { id: 'rue', type: 'allee', kind: 'path', name: 'Allée', points: [P(0, 0), P(100, 20)] },
    { id: 'ent', type: 'entree', kind: 'point', name: 'Entrée A', points: [P(100, 20)], parent_id: 'bat' }];
  for (const l of [0, 1, 2]) {
    L.push({ id: `et${l}`, type: 'etage', kind: 'polygon', name: `Étage ${l}`, points: sq(100, 0, 60), level: l, parent_id: 'bat' });
    L.push({ id: `co${l}`, type: 'couloir', kind: 'path', name: `Couloir ${l}`, points: [P(100, 20), P(130, 20), P(160, 20)], level: l, parent_id: `et${l}` });
    if (l !== 1 || stairs) L.push({ id: `es${l}`, type: 'escalier', kind: 'point', name: 'Escalier A', points: [P(130, 20)], level: l, parent_id: 'bat' });
  }
  L.push({ id: 'ch', type: 'chambre', kind: 'polygon', name: 'Chambre 212', points: sq(150, 22, 8), level: 2, parent_id: 'et2' });
  L.push({ id: 'ile', type: 'chambre', kind: 'polygon', name: 'Chambre isolée', points: sq(500, 500, 8), level: 0 });
  return L;
}
const run = (pl: NavPlace[], destId: string | null, extra: Partial<Parameters<typeof computeItinerary>[0]> = {}, accessible = false) =>
  computeItinerary({ graph: buildNavGraph(pl, { accessibleOnly: accessible }), places: pl, dest: pl.find((x) => x.id === destId), gpsFix: { p: P(0, 0) }, accessible, ...extra });

describe('résultat d’itinéraire typé', () => {
  it('route calculée : distance, durée et étapes réelles', () => { const r = run(city(), 'ch'); expect(r.status).toBe('route_ready'); if (r.status === 'route_ready') { expect(r.distance_m).toBeGreaterThan(100); expect(r.minutes).toBeGreaterThanOrEqual(1); expect(r.plan.steps.length).toBeGreaterThan(0); expect(outcomeMessage(r, 'Chambre 212')).toMatch(/^Itinéraire prêt/); } });
  it('GPS indisponible et aucun départ choisi : gps_needed, aucune route annoncée', () => { const r = run(city(), 'ch', { gpsFix: null }); expect(r).toEqual({ status: 'gps_needed' }); expect(outcomeMessage(r, 'x')).not.toMatch(/prêt/); });
  it('départ choisi (QR) : le GPS n’est pas nécessaire', () => { const pl = city(); expect(run(pl, 'ch', { gpsFix: null, startId: 'ent' }).status).toBe('route_ready'); });
  it('lieu absent de la carte de l’appareil : place_unavailable', () => { expect(run(city(), null)).toEqual({ status: 'place_unavailable' }); });
  it('escalier manquant à un étage : aucun chemin praticable', () => { expect(run(city(false), 'ch')).toEqual({ status: 'no_route', reason: 'no_path' }); });
  it('mode sans escalier sans ascenseur : raison dédiée', () => { expect(run(city(), 'ch', {}, true)).toEqual({ status: 'no_route', reason: 'no_step_free_path' }); });
  it('lieu non relié au réseau', () => { expect(run(city(), 'ile')).toEqual({ status: 'no_route', reason: 'dest_unlinked' }); });
  it('départ hors réseau ou inconnu', () => { expect(run(city(), 'ch', { gpsFix: { p: P(9000, 9000) } })).toEqual({ status: 'no_route', reason: 'start_unlinked' }); expect(run(city(), 'ch', { startId: 'nope' })).toEqual({ status: 'no_route', reason: 'start_unlinked' }); });
  it('exception interne : error, jamais de plantage', () => { expect(computeItinerary({ graph: null as any, places: city(), dest: city()[0], gpsFix: { p: P(0, 0) }, accessible: false })).toEqual({ status: 'error' }); });
});
