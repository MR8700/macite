import { db, pendingSync, type Survey } from './db';
import type { Status } from './geo';
import { API_BASE } from './api';

const API = API_BASE;
const hdr = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

export const SESSION_EXPIRED = 'Session expirée : reconnectez-vous (vos relevés restent sur l’appareil).';
/** Texte d'erreur lisible d'une réponse API (le `detail` de FastAPI peut aussi être une liste : on ne l'affiche pas brut). */
export async function detailOf(r: Response, fallback = `Erreur ${r.status}`): Promise<string> {
  const j = await r.json().catch(() => null); return typeof j?.detail === 'string' ? j.detail : fallback;
}
export interface SyncResult { pushed: number; conflicts: number; errors: number; photoErrors: number }
/** Envoie les relevés soumis. En cas de conflit de version, rien n'est écrasé : marqué pour résolution humaine. */
export async function pushSurveys(token: string): Promise<SyncResult> {
  const items = await pendingSync(); const r: SyncResult = { pushed: 0, conflicts: 0, errors: 0, photoErrors: 0 };
  if (!items.length) return r;
  const res = await fetch(`${API}/sync`, { method: 'POST', headers: hdr(token), body: JSON.stringify({ surveys: items.map(x => ({ ...x, place_type: x.placeType || undefined, parent_id: x.parentId ?? undefined, level: x.level ?? undefined, number: x.number || undefined })) }) });
  if (res.status === 401) throw new Error(SESSION_EXPIRED);
  if (!res.ok) { for (const s of items) await db.surveys.update(s.id, { syncError: `HTTP ${res.status}` }); return { ...r, errors: items.length }; }
  const { results } = (await res.json()) as { results: { id: string; ok: boolean; version?: number; conflict?: boolean; error?: string }[] };
  for (const x of results) {
    // Le serveur incrémente la version : on la reprend, sinon une resoumission après correction serait refusée comme « conflit ».
    if (x.ok) { await db.surveys.update(x.id, { synced: true, syncError: undefined, conflict: false, rejectReason: undefined, ...(x.version != null ? { version: x.version } : {}) }); r.pushed++; }
    else if (x.conflict) { await db.surveys.update(x.id, { conflict: true, syncError: 'Conflit de version : à résoudre' }); r.conflicts++; }
    else { await db.surveys.update(x.id, { syncError: x.error ?? 'Erreur' }); r.errors++; }
  }
  // Photos : envoyées seulement pour les relevés acceptés par le serveur.
  for (const ph of await db.photos.filter(x => !x.uploaded && !x.error).toArray()) {
    const sv = await db.surveys.get(ph.surveyId); if (!sv?.synced) continue;
    const fd = new FormData(); fd.append('file', ph.blob, ph.id + '.jpg');
    try {
      const up = await fetch(`${API}/surveys/${ph.surveyId}/photos/${ph.id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      if (up.ok) await db.photos.update(ph.id, { uploaded: true });
      else if (up.status === 401) throw new Error(SESSION_EXPIRED);
      else if ([409, 413, 415, 422].includes(up.status)) { await db.photos.update(ph.id, { error: await detailOf(up) }); r.photoErrors++; }   // refus définitif : ne pas réessayer à chaque synchro
      else r.photoErrors++;                                                                                                                      // erreur serveur passagère : réessayée à la prochaine synchro
    } catch (e) { if ((e as Error).message === SESSION_EXPIRED) throw e; r.photoErrors++; break; }                                                   // réseau coupé : inutile d'insister sur les suivantes
  }
  return r;
}
/** Rapatrie le statut des relevés déjà envoyés (validé, publié, « à corriger » + motif) : sans cela, le releveur ne savait jamais qu'un relevé était rejeté.
 *  Un relevé modifié localement depuis (non synchronisé) n'est jamais écrasé. */
export async function pullSurveyStatuses(token: string): Promise<number> {
  let changed = 0;
  // Pagination : l'API est limitée à 200 relevés par page ; on lit toutes les pages (plafond de sécurité : 50 pages).
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`${API}/surveys?limit=200&offset=${page * 200}`, { headers: hdr(token) });
    if (res.status === 401) throw new Error(SESSION_EXPIRED);
    if (!res.ok) return changed;
    const rows = await res.json(); if (!Array.isArray(rows)) return changed;
    for (const r of rows as { id: string; status: Status; version: number; reject_reason?: string | null }[]) {
      const local = await db.surveys.get(r.id); if (!local?.synced) continue;
      const reason = r.status === 'a_corriger' ? r.reject_reason ?? undefined : undefined;
      if (local.status === r.status && local.version === r.version && local.rejectReason === reason) continue;
      await db.surveys.update(r.id, { status: r.status, version: r.version, rejectReason: reason }); changed++;
    }
    if (rows.length < 200) break;
  }
  return changed;
}
/** Télécharge la dernière version PUBLIÉE de la carte et la stocke localement pour usage hors ligne. */
export async function pullPublished(siteId = 'kossodo') {
  const res = await fetch(`${API}/sites/${siteId}/map`); if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { version, places } = await res.json();
  // `category` = ancien nom de type_label (alias transitoire du serveur) : on ne le stocke pas.
  await db.transaction('rw', db.published, async () => { await db.published.clear(); await db.published.bulkPut(places.map(({ category, ...p }: { category?: string; type_label?: string }) => ({ ...p, type_label: p.type_label ?? category ?? '', mapVersion: version }))); });
  return { version: version as number, count: places.length as number };
}
export async function login(username: string, password: string) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (res.status === 429) throw new Error('Trop d’essais : patientez quelques minutes.');
  if (!res.ok) throw new Error('Identifiants invalides');
  return (await res.json()) as { token: string; role: string };
}
export const reviewApi = {
  /** File de validation. Avant : une session expirée (401) renvoyait {detail} et l'écran plantait sur `queue.map`. */
  list: async (t: string): Promise<Survey[]> => {
    const r = await fetch(`${API}/surveys?status=a_verifier&limit=200`, { headers: hdr(t) });
    if (r.status === 401) throw new Error(SESSION_EXPIRED);
    if (!r.ok) throw new Error(await detailOf(r));
    const j = await r.json(); return Array.isArray(j) ? j : [];
  },
  act: (t: string, id: string, action: 'approve' | 'reject', reason?: string, force?: boolean) => fetch(`${API}/surveys/${id}/${action}`, { method: 'POST', headers: hdr(t), body: JSON.stringify({ reason, force }) }),
  publish: (t: string) => fetch(`${API}/map-versions/publish`, { method: 'POST', headers: hdr(t) }),
};
