import { haversine, type Kind, type LngLat } from './geo';
import { snapPaths, shortestPath, type Graph, type Route } from './graph';

/** Navigation multi-niveaux. Chaque nœud porte une étiquette de niveau : 'x' = extérieur, sinon le niveau d'étage ('0' = RDC).
 *  Escaliers et ascenseurs sont reliés d'un niveau à l'autre quand ils se superposent (≤ V_TOL m) dans le même bâtiment. */
export interface NavPlace { id: string; type?: string; kind: Kind; name: string; points: LngLat[]; level?: number | null; parent_id?: string | null }
export interface NavOpts { accessibleOnly?: boolean; indoorAttachM?: number; outdoorAttachM?: number; verticalTolM?: number }
export interface Meta { tag: string; name?: string; via?: 'stairs' | 'elevator' }
export interface NavGraph extends Graph { meta: Map<string, Meta>; warnings: string[] }
const PENALTY = { stairs: 25, elevator: 15 }; // coût (m équivalents) par niveau, estimation configurable
const INDOOR_PATHS = ['couloir', 'escalier'];
const key = (p: LngLat, tag: string) => `${p[0].toFixed(6)},${p[1].toFixed(6)}|${tag}`;
const lvl = (p: NavPlace) => String(p.level ?? 0);

export function buildNavGraph(places: NavPlace[], o: NavOpts = {}): NavGraph {
  const inT = o.indoorAttachM ?? 6, outT = o.outdoorAttachM ?? 15, vT = o.verticalTolM ?? 5;
  const nodes = new Map<string, LngLat>(), adj = new Map<string, Graph['adj'] extends Map<string, infer E> ? E : never>(), meta = new Map<string, Meta>(), warnings: string[] = [];
  const node = (p: LngLat, tag: string, m: Partial<Meta> = {}) => { const k = key(p, tag); nodes.set(k, p); if (!adj.has(k)) adj.set(k, []); meta.set(k, { ...meta.get(k), tag, ...m }); return k; };
  const link = (a: string, b: string, w: number, via?: 'stairs' | 'elevator' | 'door') => { adj.get(a)!.push({ to: b, w, via }); adj.get(b)!.push({ to: a, w, via }); };
  const byTag = new Map<string, LngLat[][]>();
  for (const p of places) if (p.kind === 'path') {
    if (p.type === 'allee') (byTag.get('x') ?? byTag.set('x', []).get('x')!).push(p.points);
    else if (p.type && INDOOR_PATHS.includes(p.type)) (byTag.get(lvl(p)) ?? byTag.set(lvl(p), []).get(lvl(p))!).push(p.points);
  }
  const pathNodes = new Map<string, string[]>();
  for (const [tag, paths] of byTag) {
    const ks: string[] = [];
    for (const path of snapPaths(paths)) path.forEach((pt, i) => { const k = node(pt, tag); ks.push(k); if (i) link(key(path[i - 1], tag), k, haversine(path[i - 1], pt)); });
    pathNodes.set(tag, ks);
  }
  const nearest = (p: LngLat, tag: string, max: number) => { let b: string | null = null, d = max; for (const k of pathNodes.get(tag) ?? []) { const x = haversine(p, nodes.get(k)!); if (x <= d) { d = x; b = k; } } return b ? { k: b, d } : null; };
  const attach = (k: string, tag: string, max: number, what: string) => { const n = nearest(nodes.get(k)!, tag, max); if (n) link(k, n.k, n.d); else warnings.push(`${what} non relié(e) au réseau (${tag === 'x' ? 'extérieur' : 'niveau ' + tag}).`); };
  const root = (id?: string | null): string | null => { let c = places.find(x => x.id === id), g = 0; while (c && g++ < 10) { if (c.type === 'batiment') return c.id; c = places.find(x => x.id === c!.parent_id); } return null; };
  const verts: { k: string; tag: number; b: string | null; t: 'stairs' | 'elevator'; p: LngLat }[] = [];
  for (const p of places) {
    const pt = p.points[0]; if (!pt) continue;
    if (p.type === 'entree') { const o1 = node(pt, 'x', { name: p.name }), i1 = node(pt, '0', { name: p.name }); link(o1, i1, 1, 'door'); attach(o1, 'x', outT, `Entrée « ${p.name} »`); attach(i1, '0', inT, `Entrée « ${p.name} » (intérieur)`); }
    else if (p.type === 'porte') attach(node(pt, lvl(p), { name: p.name }), lvl(p), inT, `Porte « ${p.name} »`);
    else if ((p.type === 'escalier' || p.type === 'ascenseur') && Number.isFinite(Number(lvl(p)))) {
      const t = p.type === 'escalier' ? 'stairs' : 'elevator'; let k: string;
      if (p.kind === 'point') { k = node(pt, lvl(p), { name: p.name }); attach(k, lvl(p), inT, `${p.name}`); }
      else { const n = nearest(pt, lvl(p), 1); if (!n) continue; k = n.k; meta.set(k, { ...meta.get(k)!, name: p.name }); }
      verts.push({ k, tag: Number(lvl(p)), b: root(p.parent_id), t, p: pt });
    }
  }
  for (const a of verts) for (const b of verts) {
    if (a.t !== b.t || b.tag !== a.tag + 1 || a.b !== b.b || haversine(a.p, b.p) > vT) continue;
    if (o.accessibleOnly && a.t === 'stairs') continue;
    link(a.k, b.k, PENALTY[a.t], a.t);
  }
  return { nodes, adj, meta, warnings };
}

/** Nœud d'un lieu : tag selon son niveau (lieu intérieur) ou l'extérieur ; chambre/polygone → centre. */
export function locate(g: NavGraph, p: NavPlace, places: NavPlace[], maxIn = 15, maxOut = 60): string | null {
  const c: LngLat = p.points.length > 1 && p.kind === 'polygon' ? [p.points.reduce((s, q) => s + q[0], 0) / p.points.length, p.points.reduce((s, q) => s + q[1], 0) / p.points.length] : p.points[0];
  const indoor = p.level != null || (p.parent_id != null && places.some(x => x.id === p.parent_id && x.type !== undefined));
  const tag = indoor ? String(p.level ?? 0) : 'x'; let best: string | null = null, d = tag === 'x' ? maxOut : maxIn;
  for (const [k, q] of g.nodes) if (g.meta.get(k)?.tag === tag) { const x = haversine(c, q); if (x <= d) { d = x; best = k; } }
  return best;
}
export function locateXY(g: NavGraph, p: LngLat, max = 60): string | null { let b: string | null = null, d = max; for (const [k, q] of g.nodes) if (g.meta.get(k)?.tag === 'x') { const x = haversine(p, q); if (x <= d) { d = x; b = k; } } return b; }

export interface Leg { tag: string; coords: LngLat[] }
export interface Plan { route: Route; steps: string[]; legs: Leg[] }
export const tagLabel = (t: string) => (t === 'x' ? 'Extérieur' : `Niveau ${t}`);
/** Découpe le trajet en tronçons d'un même niveau (extérieur / niveau n). */
function splitLegs(g: NavGraph, keys: string[]): Leg[] {
  const legs: Leg[] = [];
  for (const k of keys) { const tag = g.meta.get(k)!.tag, last = legs[legs.length - 1]; if (last && last.tag === tag) last.coords.push(g.nodes.get(k)!); else legs.push({ tag, coords: [g.nodes.get(k)!] }); }
  return legs;
}
export function plan(g: NavGraph, from: string, to: string, destName: string, startName?: string): Plan | null {
  const r = shortestPath(g, from, to); if (!r) return null;
  const steps: string[] = []; const start = g.meta.get(r.keys[0]); const sn = startName ?? start?.name; steps.push(`Départ${sn ? ' : ' + sn : ''}`);
  let acc = 0, tag = start?.tag ?? 'x'; const where = (t: string) => (t === 'x' ? 'à l’extérieur' : `au niveau ${t}`);
  const flush = () => { if (acc >= 1) steps.push(`Marchez ${Math.round(acc)} m ${where(tag)}`); acc = 0; };
  for (let i = 1; i < r.keys.length; i++) {
    const a = r.keys[i - 1], b = r.keys[i], ta = g.meta.get(a)!.tag, tb = g.meta.get(b)!.tag; const e = g.adj.get(a)!.find(x => x.to === b)!;
    if (ta === tb) { acc += haversine(g.nodes.get(a)!, g.nodes.get(b)!); continue; }
    flush();
    if (e.via === 'door') steps.push(tb === 'x' ? 'Sortez du bâtiment' : `Entrez dans le bâtiment${g.meta.get(b)?.name ? ' par « ' + g.meta.get(b)!.name + ' »' : ''}`);
    else {
      let j = i; while (j + 1 < r.keys.length && g.adj.get(r.keys[j])!.find(x => x.to === r.keys[j + 1])?.via === e.via && g.meta.get(r.keys[j + 1])!.tag !== g.meta.get(r.keys[j])!.tag) j++;
      steps.push(`Prenez ${e.via === 'elevator' ? 'l’ascenseur' : 'l’escalier'} du niveau ${ta} au niveau ${g.meta.get(r.keys[j])!.tag}`); i = j; tag = g.meta.get(r.keys[j])!.tag; continue;
    }
    tag = tb;
  }
  flush(); steps.push(`Arrivée : ${destName}`); return { route: r, steps, legs: splitLegs(g, r.keys) };
}
