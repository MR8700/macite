import { PMTiles, Protocol, type RangeResponse, type Source } from 'pmtiles';
import { addProtocol } from 'maplibre-gl';
import { db } from './db';
import { API_BASE } from './api';

/** Lit un PMTiles depuis un Blob stocké localement (aucun réseau). */
export class BlobSource implements Source {
  constructor(private blob: Blob, private key = 'local') {}
  getKey() { return this.key; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
  }
}
export async function tileFromBlob(blob: Blob, z: number, x: number, y: number): Promise<ArrayBuffer | null> {
  const r = await new PMTiles(new BlobSource(blob)).getZxy(z, x, y); return r ? r.data : null;
}

// PNG transparent 1×1 : renvoyé pour une tuile absente du fichier (sinon le décodage échoue et la carte clignote).
export const TRANSPARENT_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
/** Zooms disponibles + mention de licence portée par le fichier (affichée à l'écran : obligatoire pour les données OSM). */
export async function mapInfo(blob: Blob): Promise<{ min: number; max: number; attribution: string }> {
  const pm = new PMTiles(new BlobSource(blob)); const h = await pm.getHeader(); const md = (await pm.getMetadata()) as { attribution?: string };
  return { min: h.minZoom, max: h.maxZoom, attribution: md.attribution || 'Fond hors ligne MaCité' };
}
export interface OfflineMapInfo { size: number; savedAt: number; etag: string | null }
export const getOfflineMap = () => db.offlineMap.get('kossodo');
export const removeOfflineMap = () => db.offlineMap.delete('kossodo');

/** Téléchargement réel avec progression (0..1). Le fichier est fourni par NOTRE serveur. */
export async function downloadOfflineMap(onProgress: (p: number) => void, signal?: AbortSignal): Promise<OfflineMapInfo> {
  const res = await fetch(`${API_BASE}/sites/kossodo/offline-map`, { signal });
  if (res.status === 404) throw new Error('Aucun fond de carte hors ligne n’est publié sur le serveur.');
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0; const parts: Uint8Array[] = []; let got = 0;
  const rd = res.body.getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (total) onProgress(got / total); }
  const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
  if (total && blob.size !== total) throw new Error('Téléchargement incomplet : réessayez.');
  await new PMTiles(new BlobSource(blob)).getHeader(); // refuse un fichier corrompu avant de l'enregistrer
  const info = { id: 'kossodo', blob, size: blob.size, savedAt: Date.now(), etag: res.headers.get('etag') };
  await db.offlineMap.put(info); onProgress(1); return info;
}

let registered = false;
/** Enregistre le protocole local:// : les tuiles sont lues dans IndexedDB. */
export function registerLocalTiles() {
  if (registered) return; registered = true;
  addProtocol('local', async (p) => {
    const m = p.url.match(/local:\/\/(\d+)\/(\d+)\/(\d+)/); const rec = await getOfflineMap();
    if (!m || !rec) throw new Error('carte hors ligne absente');
    const data = await tileFromBlob(rec.blob, +m[1], +m[2], +m[3]);
    return { data: data ?? TRANSPARENT_PNG.buffer.slice(0) };
  });
}
export { Protocol };
