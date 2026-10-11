import { describe, it, expect } from 'vitest';
import { parseQr, qrDataUrl, qrPayload } from './qr';
describe('QR de recalage', () => {
  it('aller-retour identifiant ↔ contenu', () => { expect(parseQr(qrPayload('abc-123_X'))).toBe('abc-123_X'); });
  it('refuse tout contenu hors format (URL externe, injection, id trop long, vide)', () => {
    for (const bad of ['https://evil.example/p/abc', 'macite://p/', 'macite://p/a/b', 'macite://p/<script>', 'macite://p/' + 'a'.repeat(65), '', 'macite://x/abc']) expect(parseQr(bad)).toBeNull();
  });
  it('génère une image PNG', async () => { expect((await qrDataUrl('abc')).startsWith('data:image/png;base64,')).toBe(true); });
});
