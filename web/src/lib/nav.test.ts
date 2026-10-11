import { describe, it, expect } from 'vitest';
import { buildNavGraph, locate, locateXY, plan, type NavPlace } from './nav';
import type { LngLat } from './geo';
// Jeu SYNTHÉTIQUE : un bâtiment à 3 niveaux (0,1,2), sans lien avec la cité réelle. 1 m ≈ 1/111320°.
const o = (m: number): number => m / 111320; const P = (x: number, y: number): LngLat => [o(x), o(y)];
const sq = (x: number, y: number, s: number): LngLat[] => [P(x, y), P(x + s, y), P(x + s, y + s), P(x, y + s)];
function city(opts: { stairsL1?: boolean; elevator?: boolean; entree?: boolean } = {}): NavPlace[] {
  const { stairsL1 = true, elevator = false, entree = true } = opts;
  const L: NavPlace[] = [
    { id: 'bat', type: 'batiment', kind: 'polygon', name: 'Bât A', points: sq(100, 0, 60) },
    { id: 'rue', type: 'allee', kind: 'path', name: 'Allée', points: [P(0, 0), P(100, 20)] },
    ...(entree ? [{ id: 'ent', type: 'entree', kind: 'point', name: 'Entrée A', points: [P(100, 20)], parent_id: 'bat' } as NavPlace] : []),
  ];
  for (const l of [0, 1, 2]) {
    L.push({ id: `et${l}`, type: 'etage', kind: 'polygon', name: `Étage ${l}`, points: sq(100, 0, 60), level: l, parent_id: 'bat' });
    L.push({ id: `co${l}`, type: 'couloir', kind: 'path', name: `Couloir ${l}`, points: [P(100, 20), P(130, 20), P(160, 20)], level: l, parent_id: `et${l}` });
    if (l !== 1 || stairsL1) L.push({ id: `es${l}`, type: 'escalier', kind: 'point', name: 'Escalier A', points: [P(130, 20)], level: l, parent_id: 'bat' });
    if (elevator) L.push({ id: `as${l}`, type: 'ascenseur', kind: 'point', name: 'Ascenseur A', points: [P(160, 20)], level: l, parent_id: 'bat' });
  }
  L.push({ id: 'ch', type: 'chambre', kind: 'polygon', name: 'Chambre 212', points: sq(150, 22, 8), level: 2, parent_id: 'et2' });
  return L;
}
const go = (pl: NavPlace[], accessibleOnly = false) => {
  const g = buildNavGraph(pl, { accessibleOnly }); const from = locateXY(g, P(0, 0))!; const dest = pl.find(x => x.id === 'ch')!;
  return { g, p: plan(g, from, locate(g, dest, pl)!, dest.name) };
};
describe('recalage par QR', () => {
  it('départ au niveau 1 (QR) : pas d’entrée, on monte seulement au niveau 2', () => {
    const pl = city(); pl.push({ id: 'qr1', type: 'qr', kind: 'point', name: 'QR couloir N1', points: [P(110, 20)], level: 1, parent_id: 'et1' });
    const g = buildNavGraph(pl); const p = plan(g, locate(g, pl.find(x => x.id === 'qr1')!, pl)!, locate(g, pl.find(x => x.id === 'ch')!, pl)!, 'Chambre 212', 'QR couloir N1');
    expect(p!.steps[0]).toBe('Départ : QR couloir N1'); expect(p!.steps.join('|')).not.toContain('Entrez'); expect(p!.steps.join('|')).toContain('du niveau 1 au niveau 2');
  });
  it('QR dont le niveau n’a aucun couloir enregistré : départ non résolu', () => {
    const pl = city(); pl.push({ id: 'qr9', type: 'qr', kind: 'point', name: 'QR orphelin', points: [P(110, 20)], level: 7, parent_id: 'bat' });
    expect(locate(buildNavGraph(pl), pl.find(x => x.id === 'qr9')!, pl)).toBeNull();
  });
});
describe('navigation intérieure par niveaux', () => {
  it('extérieur → entrée → couloir → escalier → chambre du niveau 2', () => {
    const { p } = go(city()); expect(p).not.toBeNull();
    expect(p!.steps).toEqual(expect.arrayContaining(['Entrez dans le bâtiment par « Entrée A »', 'Prenez l’escalier du niveau 0 au niveau 2', 'Arrivée : Chambre 212']));
  });
  it('échoue si l’escalier du niveau 1 n’est pas enregistré (étage non relié)', () => { expect(go(city({ stairsL1: false })).p).toBeNull(); });
  it('échoue si l’entrée du bâtiment n’est pas enregistrée', () => { expect(go(city({ entree: false })).p).toBeNull(); });
  it('mode sans escalier : impossible sans ascenseur, possible avec', () => {
    expect(go(city(), true).p).toBeNull();
    expect(go(city({ elevator: true }), true).p!.steps.join('|')).toContain('ascenseur');
  });
  it('signale les éléments non reliés au réseau', () => {
    const pl = city(); pl.push({ id: 'pt', type: 'porte', kind: 'point', name: 'Porte égarée', points: [P(155, 55)], level: 1, parent_id: 'et1' });
    expect(buildNavGraph(pl).warnings.join()).toMatch(/Porte égarée/);
  });
  it('le coût d’un niveau pénalise l’escalier mais la distance affichée reste la marche réelle', () => {
    const { p } = go(city()); expect(p!.route.distance).toBeGreaterThan(100); expect(p!.route.seconds).toBeGreaterThan(p!.route.distance / 1.25);
  });
});

describe('tronçons par niveau', () => {
  it('découpe extérieur → niveau 0 → 1 → 2 pour l’affichage carte', () => {
    const { p } = go(city()); expect(p!.legs.map(l => l.tag)).toEqual(['x', '0', '1', '2']);
    expect(p!.legs.every(l => l.coords.length >= 1)).toBe(true);
  });
});
