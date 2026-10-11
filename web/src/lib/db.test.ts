import { describe, it, expect } from 'vitest';
import { db, saveDraft, newId, pendingSync, type Survey } from './db';
const base = (o: Partial<Survey> = {}): Survey => ({ id: newId(), kind: 'point', name: 'Test (jeu synthétique)', placeType: 'entrée', notes: '', points: [[0, 0]], accuracies: [4], capturedAt: [1], orientation: null, status: 'brouillon', version: 1, updatedAt: 0, synced: false, ...o });
describe('stockage local', () => {
  it('reprend un brouillon après « fermeture » (relecture en base)', async () => {
    const s = base(); await saveDraft(s);
    expect((await db.surveys.get(s.id))?.name).toBe('Test (jeu synthétique)');
  });
  it('seuls les relevés soumis et non synchronisés sont en file', async () => {
    await db.surveys.clear();
    await saveDraft(base()); await saveDraft(base({ status: 'a_verifier' }));
    expect((await pendingSync()).length).toBe(1);
  });
});
