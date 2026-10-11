import { describe, it, expect } from 'vitest';
import { accuracyLevel, validateGeometry, shouldCapture, cardinal, polygonOrientation, type LngLat } from './geo';
import { shortestPath } from './graph';
import { buildNavGraph, locateXY } from './nav';
// Les tests de navigation passent par le constructeur de production (buildNavGraph) : un seul graphe à maintenir.
const buildGraph = (paths: LngLat[][]) => buildNavGraph(paths.map((points, i) => ({ id: `a${i}`, type: 'allee', kind: 'path' as const, name: `allée ${i}`, points })));
const nearestNode = (g: ReturnType<typeof buildGraph>, p: LngLat) => locateXY(g, p);

// Jeu de test SYNTHÉTIQUE : coordonnées arbitraires, ne représentent pas Kossodo.
const sq: LngLat[] = [[0, 0], [0.0002, 0], [0.0002, 0.0002], [0, 0.0002]];
describe('géométrie', () => {
  it('accepte un contour valide, refuse auto-sécant / trop court / hors limites', () => {
    expect(validateGeometry('polygon', sq)).toEqual([]);
    expect(validateGeometry('polygon', [[0, 0], [0.0002, 0.0002], [0.0002, 0], [0, 0.0002]]).join()).toMatch(/croise/);
    expect(validateGeometry('polygon', sq.slice(0, 2)).length).toBe(1);
    expect(validateGeometry('point', [[200, 0]]).length).toBe(1);
  });
  it('précision GPS', () => {
    expect(accuracyLevel(3)).toBe('bonne'); expect(accuracyLevel(10)).toBe('moyenne');
    expect(accuracyLevel(40)).toBe('faible'); expect(accuracyLevel(null)).toBe('indisponible');
  });
  it('filtre les captures redondantes', () => {
    const last = { p: [0, 0] as LngLat, t: 0 };
    expect(shouldCapture(last, [0, 0], 5000)).toBe(false);
    expect(shouldCapture(last, [0.0001, 0], 5000)).toBe(true);
  });
  it('cardinaux et orientation calculée depuis les coordonnées', () => {
    expect(cardinal(10)).toBe('N'); expect(cardinal(100)).toBe('E'); expect(cardinal(200)).toBe('S'); expect(cardinal(300)).toBe('O');
    expect(polygonOrientation([[0, 0], [0.0004, 0], [0.0004, 0.0001], [0, 0.0001]])).toBeCloseTo(90, 0);
  });
});
describe('navigation', () => {
  const g = buildGraph([[[0, 0], [0.001, 0]], [[0.001, 0], [0.001, 0.001]], [[0.01, 0.01], [0.011, 0.01]]]);
  it('trouve un itinéraire sur chemins connectés', () => {
    const r = shortestPath(g, nearestNode(g, [0, 0])!, nearestNode(g, [0.001, 0.001])!);
    expect(r?.coords.length).toBe(3); expect(r!.distance).toBeGreaterThan(200);
  });
  it('null si aucun chemin praticable', () => {
    expect(shortestPath(g, nearestNode(g, [0, 0])!, nearestNode(g, [0.01, 0.01])!)).toBeNull();
  });
});

import { scaleDims } from './photo';
describe('photo', () => { it('réduit sans agrandir', () => { expect(scaleDims(4000, 3000)).toEqual([1280, 960]); expect(scaleDims(800, 600)).toEqual([800, 600]); }); });

describe('rattachement des chemins', () => {
  const o = (m: number) => m / 111320;
  const route = (paths: LngLat[][], to: LngLat) => { const g = buildGraph(paths); return shortestPath(g, nearestNode(g, [0, 0])!, nearestNode(g, to)!); };
  it('relie deux allées séparées de 1,5 m (avant : aucun itinéraire)', () => {
    expect(route([[[0, 0], [o(100), 0]], [[o(101.5), 0], [o(200), 0]]], [o(200), 0])).not.toBeNull();
  });
  it('relie une jonction en T (extrémité posée près du milieu d’une allée)', () => {
    expect(route([[[0, 0], [o(200), 0]], [[o(100), o(2)], [o(100), o(80)]]], [o(100), o(80)])).not.toBeNull();
  });
  it('ne relie PAS deux allées séparées de 20 m', () => {
    expect(route([[[0, 0], [o(100), 0]], [[o(120), 0], [o(200), 0]]], [o(200), 0])).toBeNull();
  });
  it('ne modifie pas les données d’entrée', () => {
    const a: LngLat[][] = [[[0, 0], [o(100), 0]], [[o(101.5), 0], [o(200), 0]]]; const copie = JSON.stringify(a); buildGraph(a); expect(JSON.stringify(a)).toBe(copie);
  });
});
