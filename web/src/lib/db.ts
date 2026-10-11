import Dexie, { type Table } from 'dexie';
import type { Kind, LngLat, Status } from './geo';
import { rank, withParentNames } from './fuzzy';

export interface Survey {
  // `placeType` = code de type du lieu (ex. « batiment »). Le libellé affichable n'existe que sur un lieu PUBLIÉ (`type_label`, voir PublishedPlace).
  id: string; kind: Kind; name: string; placeType: string; notes: string;
  points: LngLat[]; accuracies: (number | null)[]; capturedAt: number[];
  orientation: { deg: number; source: 'manuelle' | 'cap_gps' | 'boussole' } | null;
  parentId?: string | null; level?: number | null; number?: string;
  status: Status; version: number; updatedAt: number;
  synced: boolean; syncError?: string; conflict?: boolean;
  rejectReason?: string;   // motif donné par l'expert quand le relevé est renvoyé « à corriger »
}
export interface PhotoRec { id: string; surveyId: string; blob: Blob; uploaded: boolean; error?: string }   // error : refus définitif du serveur (trop lourde, trop nombreuse…), inutile de réessayer
export interface OfflineMapRec { id: string; blob: Blob; size: number; savedAt: number; etag: string | null }
/** `type` = code de type (ex. « batiment ») ; `type_label` = libellé affichable (ex. « Bâtiment »), dérivé du code par le serveur. */
export interface PublishedPlace { number?: string | null; parent_name?: string | null; parent_id?: string | null; type?: string; level?: number | null; id: string; kind: Kind; name: string; type_label: string; points: LngLat[]; mapVersion: number }

export class MaCiteDB extends Dexie {
  surveys!: Table<Survey, string>;
  published!: Table<PublishedPlace, string>;
  photos!: Table<PhotoRec, string>;
  offlineMap!: Table<OfflineMapRec, string>;
  constructor(name = 'macite') {
    super(name);
    this.version(1).stores({ surveys: 'id, status, synced, updatedAt', published: 'id, name, category' });
    this.version(2).stores({ surveys: 'id, status, synced, updatedAt', published: 'id, name, category', photos: 'id, surveyId' });
    this.version(3).stores({ surveys: 'id, status, synced, updatedAt', published: 'id, name, category', photos: 'id, surveyId', offlineMap: 'id' });
    // v4 : `category` disparaît. Relevés locaux : category -> placeType (le code). Lieux publiés : category (libellé) -> type_label. Aucune donnée perdue.
    this.version(4).stores({ surveys: 'id, status, synced, updatedAt', published: 'id, name, type_label', photos: 'id, surveyId', offlineMap: 'id' }).upgrade(async tx => {
      await tx.table('surveys').toCollection().modify((s: Record<string, unknown>) => { if (s.placeType === undefined) s.placeType = s.category ?? ''; delete s.category; });
      await tx.table('published').toCollection().modify((p: Record<string, unknown>) => { if (p.type_label === undefined) p.type_label = p.category ?? p.type ?? ''; delete p.category; });
    });
  }
}
export const db = new MaCiteDB();

export const newId = () => crypto.randomUUID();
export async function saveDraft(s: Survey) { await db.surveys.put({ ...s, updatedAt: Date.now(), synced: false }); }
export const listSurveys = () => db.surveys.orderBy('updatedAt').reverse().toArray();
export const pendingSync = () => db.surveys.filter(s => !s.synced && s.status !== 'brouillon' && s.status !== 'en_cours').toArray();
export async function searchPublished(q: string) {
  const n = q.trim().toLowerCase(); if (!n) return [];
  const exact = await db.published.filter(p => p.name.toLowerCase().includes(n) || (p.type_label ?? '').toLowerCase().includes(n)).limit(8).toArray();
  if (exact.length >= 8) return exact;
  const seen = new Set(exact.map(p => p.id));   // complète avec la recherche approximative (fautes, accents, abréviations, « chambre 112 »)
  const fuzzy = rank(q, withParentNames(await db.published.toArray()), 8).filter(p => !seen.has(p.id));
  return [...exact, ...fuzzy].slice(0, 8) as PublishedPlace[];
}
