export type LngLat = [number, number];
export type Kind = 'point' | 'path' | 'polygon';
export type Status = 'brouillon' | 'en_cours' | 'a_verifier' | 'a_corriger' | 'valide' | 'publie' | 'archive';

export const STATUS_LABEL: Record<Status, string> = {
  brouillon: 'Brouillon', en_cours: 'En cours', a_verifier: 'À vérifier',
  a_corriger: 'À corriger', valide: 'Validé', publie: 'Publié', archive: 'Archivé',
};

/** Seuils configurables (indicatifs, à ajuster après essais terrain). */
export const ACCURACY_THRESHOLDS = { good: 5, medium: 15 };
export type AccuracyLevel = 'bonne' | 'moyenne' | 'faible' | 'indisponible';

export function accuracyLevel(m: number | null | undefined, t = ACCURACY_THRESHOLDS): AccuracyLevel {
  if (m == null || !Number.isFinite(m)) return 'indisponible';
  if (m <= t.good) return 'bonne';
  if (m <= t.medium) return 'moyenne';
  return 'faible';
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
export function cardinal(deg: number): 'N' | 'E' | 'S' | 'O' {
  const d = ((deg % 360) + 360) % 360;
  if (d >= 315 || d < 45) return 'N';
  if (d < 135) return 'E';
  if (d < 225) return 'S';
  return 'O';
}
export function pathLength(pts: LngLat[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += haversine(pts[i - 1], pts[i]);
  return s;
}

const validCoord = (p: LngLat) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

function segIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const o = (p: LngLat, q: LngLat, r: LngLat) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
export function selfIntersects(ring: LngLat[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
    if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
  }
  return false;
}
export function polygonArea(ring: LngLat[]): number {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const k = Math.cos(rad(lat0));
  const xy = ring.map(p => [rad(p[0]) * k * R, rad(p[1]) * R]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
/** Orientation du polygone : azimut (0-180°) de son plus long côté, calculé depuis les coordonnées. */
export function polygonOrientation(ring: LngLat[]): number {
  let best = 0, len = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], l = haversine(a, b);
    if (l > len) { len = l; best = bearing(a, b); }
  }
  return best % 180;
}

export function validateGeometry(kind: Kind, pts: LngLat[]): string[] {
  const err: string[] = [];
  if (!pts.every(validCoord)) err.push('Coordonnées invalides ou hors limites.');
  const min = kind === 'point' ? 1 : kind === 'path' ? 2 : 3;
  if (pts.length < min) err.push(`Il faut au moins ${min} point(s) pour ce type de relevé.`);
  if (kind === 'point' && pts.length > 1) err.push('Un relevé ponctuel ne contient qu’un point.');
  if (kind === 'polygon' && pts.length >= 3) {
    if (selfIntersects(pts)) err.push('Le contour se croise lui-même.');
    else if (polygonArea(pts) < 1) err.push('Surface quasi nulle : contour dégénéré.');
  }
  if (kind === 'path' && pts.length >= 2 && pathLength(pts) < 0.5) err.push('Chemin trop court (< 0,5 m).');
  return err;
}

export function shouldCapture(last: { p: LngLat; t: number } | null, p: LngLat, t: number, minDist = 2, minMs = 1500): boolean {
  if (!last) return true;
  return haversine(last.p, p) >= minDist && t - last.t >= minMs;
}
