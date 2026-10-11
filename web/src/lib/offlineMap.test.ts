import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapInfo, tileFromBlob } from './offlineMap';
// Fixture SYNTHÉTIQUE : une tuile PNG verte z0, sans lien avec Kossodo.
const blob = new Blob([readFileSync(new URL('./test-fixture.pmtiles', import.meta.url))]);
describe('fond de carte hors ligne', () => {
  it('lit une tuile depuis le fichier local, sans réseau', async () => {
    const d = await tileFromBlob(blob, 0, 0, 0); expect(d).not.toBeNull();
    expect(new Uint8Array(d!)[1]).toBe(0x50); // signature PNG : \x89 P N G
  });
  it('retourne null hors couverture', async () => { expect(await tileFromBlob(blob, 3, 1, 1)).toBeNull(); });
  it('lit zooms et attribution du fichier (repli si absente)', async () => { const i = await mapInfo(blob); expect(i.min).toBe(0); expect(i.max).toBe(0); expect(typeof i.attribution).toBe('string'); });
});
