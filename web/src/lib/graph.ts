import { pathLength, type LngLat } from './geo';

export interface Edge { to: string; w: number; via?: 'stairs' | 'elevator' | 'door' }
export interface Graph { nodes: Map<string, LngLat>; adj: Map<string, Edge[]> }
export const WALK_SPEED_MS = 1.25; // hypothèse configurable (~4,5 km/h), estimation et non mesure

export const SNAP_TOLERANCE_M = 3; // distance max de rattachement entre chemins (configurable)

function toXY(p: LngLat, lat0: number): [number, number] { return [p[0] * Math.cos((lat0 * Math.PI) / 180) * 111320, p[1] * 111320]; }
/** Projection d'un point sur un segment : point projeté (lng/lat), distance (m), paramètre t. */
function project(p: LngLat, a: LngLat, b: LngLat): { q: LngLat; d: number; t: number } {
  const lat0 = a[1]; const [px, py] = toXY(p, lat0), [ax, ay] = toXY(a, lat0), [bx, by] = toXY(b, lat0);
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
  return { q: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}
/** Rattache chaque extrémité de chemin au chemin voisin le plus proche (≤ tol m) : jonctions en T et petits écarts compris.
 *  Les chemins d'origine ne sont pas modifiés ; retourne des copies. */
export function snapPaths(paths: LngLat[][], tol = SNAP_TOLERANCE_M): LngLat[][] {
  const P = paths.map(p => p.map(c => [...c] as LngLat));
  P.forEach((path, i) => {
    for (const end of [0, path.length - 1]) {
      let best: { d: number; q: LngLat; j: number; k: number; t: number } | null = null;
      P.forEach((other, j) => { if (j === i) return; for (let k = 0; k < other.length - 1; k++) { const r = project(path[end], other[k], other[k + 1]); if (r.d <= tol && (!best || r.d < best.d)) best = { ...r, j, k }; } });
      if (!best) continue; const b = best as { d: number; q: LngLat; j: number; k: number; t: number };
      const seg = P[b.j]; const target = b.t < 0.02 ? seg[b.k] : b.t > 0.98 ? seg[b.k + 1] : (seg.splice(b.k + 1, 0, b.q), b.q);
      path[end] = [...target] as LngLat;
    }
  });
  return P;
}

export interface Route { coords: LngLat[]; keys: string[]; distance: number; seconds: number }
/** File de priorité (tas binaire min) : O(log n) par insertion/extraction, au lieu d'un tri du tableau à chaque itération. */
class MinHeap {
  private a: [number, string][] = [];
  get size() { return this.a.length; }
  push(x: [number, string]) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop(): [number, string] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}
/** Dijkstra (tas binaire). null si aucun chemin praticable connu. */
export function shortestPath(g: Graph, from: string, to: string): Route | null {
  const dist = new Map<string, number>([[from, 0]]), prev = new Map<string, string>(), done = new Set<string>();
  const q = new MinHeap(); q.push([0, from]);
  while (q.size) {
    const [d, u] = q.pop();
    if (done.has(u)) continue; done.add(u);
    if (u === to) break;
    for (const e of g.adj.get(u) ?? []) {
      const nd = d + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, u); q.push([nd, e.to]); }
    }
  }
  if (!dist.has(to)) return null;
  const keys = [to]; while (keys[0] !== from) keys.unshift(prev.get(keys[0])!);
  const coords = keys.map(k => g.nodes.get(k)!);
  // distance = marche réelle ; durée = coût pondéré (pénalités d'escalier/ascenseur incluses), en estimation
  return { coords, keys, distance: pathLength(coords), seconds: dist.get(to)! / WALK_SPEED_MS };
}
