// Recherche approximative hors ligne : MÊME algorithme que api/macite_ai/search.py (parité vérifiée par test).
export interface Place { id: string; name: string; type_label?: string | null; type?: string | null; level?: number | null; number?: string | null; parent_id?: string | null; parent_name?: string | null; points?: number[][] }
export type Scored<T> = T & { score: number }

const ABBR: Record<string, string> = { bat: "batiment", batt: "batiment", ch: "chambre", cham: "chambre", wc: "sanitaires", toilette: "sanitaires", toilettes: "sanitaires", foot: "terrain", football: "terrain" };
const STOP = new Set("le la les de du des un une au aux ou se je ma mon sur pour comment aller vers en dans quel quels quelle quelles trouve trouver cherche chercher rejoindre situe sont afficher affiche pres moi qui que est y et".split(" "));
const PARENT_WEIGHT = 0.6;

export function norm(s: string): string {
  return s.toLowerCase().replace(/\b([dlcjmnst])['’]/g, "").normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
}
export function tokens(s: string): string[] {
  return norm(s).split(" ").filter(Boolean).map((t) => ABBR[t] ?? t).filter((t) => !STOP.has(t));
}
const bi = (w: string) => { const x = ` ${w} `; const o = new Set<string>(); for (let i = 0; i < x.length - 1; i++) o.add(x.slice(i, i + 2)); return o; };
function dice(a: string, b: string): number {
  const A = bi(a), B = bi(b); if (!A.size || !B.size) return 0;
  let n = 0; A.forEach((g) => { if (B.has(g)) n++; }); return (2 * n) / (A.size + B.size);
}
const hasDigit = (s: string) => /\d/.test(s);

function tokScore(q: string, hay: [string, number][]): number {
  let best = 0;
  for (const [h, w] of hay) {
    if (q === h) { best = Math.max(best, w); continue; }
    if (hasDigit(q) || hasDigit(h)) continue;           // « D3 » ne ressemble jamais à « D4 »
    if (q.length >= 3 && h.startsWith(q)) best = Math.max(best, 0.9 * w);
    else { const s = dice(q, h); if (s >= 0.6) best = Math.max(best, 0.8 * s * w); }
  }
  return best;
}
function haystack(p: Place): [string, number][] {
  const own = tokens([p.name, p.number, p.type_label].filter(Boolean).join(" "));
  return [...own.map((t) => [t, 1] as [string, number]), ...tokens(p.parent_name ?? "").map((t) => [t, PARENT_WEIGHT] as [string, number])];
}
function score(qt: string[], ht: [string, number][]): number {
  if (!qt.length) return 0;
  const parts = qt.map((q) => tokScore(q, ht));
  if (qt.some((q, i) => hasDigit(q) && parts[i] === 0)) return 0;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;
export function rank<T extends Place>(query: string, places: T[], limit = 8, minScore = 0.45): Scored<T>[] {
  const qt = tokens(query);
  return places.map((p) => ({ ...p, score: round3(score(qt, haystack(p))) })).filter((p) => p.score >= minScore)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, limit);
}

/** Ajoute `parent_name` = nom de la RACINE (le bâtiment) pour lever les ambiguïtés (« chambre 112 »). Miroir de published_places() côté serveur. */
export function withParentNames<T extends Place>(places: T[]): (T & { parent_name?: string | null })[] {
  const by = new Map(places.map((p) => [p.id, p]));
  return places.map((p) => {
    let top: Place = p, hops = 0;
    while (top.parent_id && by.has(top.parent_id) && hops++ < 8) top = by.get(top.parent_id)!;
    return { ...p, parent_name: top === p ? null : top.name };
  });
}

/** Mots qui expriment une INTENTION (itinéraire, distance, recherche d'une catégorie) : seul le modèle sait la traiter, on ne répond pas localement. */
const INTENT = new Set("aller va vais allons allez itineraire chemin trajet route rejoindre emmene emmener conduis conduire guide guider direction naviguer navigation distance combien temps trouver".split(" "));
/** Lieu désigné SANS AMBIGUÏTÉ par une simple désignation (« bâtiment D3 », « D3 ») : renvoyé sans appel d'IA, donc sans consommer de quota.
 *  Renvoie null dès qu'il y a un doute (plusieurs candidats proches, intention de trajet, score insuffisant) : la demande part alors au serveur.
 *  La règle des chiffres de `rank` s'applique : « D3 » ne désigne jamais « D4 ». */
export function confidentLocalMatch<T extends Place>(query: string, places: T[]): Scored<T> | null {
  if (norm(query).split(" ").some((w) => INTENT.has(w)) || !tokens(query).length) return null;
  const hits = rank(query, withParentNames(places), 3);
  return hits.length && hits[0].score >= 0.95 && (hits.length === 1 || hits[0].score - hits[1].score >= 0.3) ? hits[0] : null;
}
