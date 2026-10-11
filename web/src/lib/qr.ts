import QRCode from 'qrcode';
const PREFIX = 'macite://p/';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const qrPayload = (placeId: string) => PREFIX + placeId;
/** Un QR est une donnée NON FIABLE : on n'accepte que notre format strict, jamais une URL quelconque. */
export function parseQr(text: string): string | null {
  const t = text.trim(); if (!t.startsWith(PREFIX)) return null;
  const id = t.slice(PREFIX.length); return ID.test(id) ? id : null;
}
export const qrDataUrl = (placeId: string) => QRCode.toDataURL(qrPayload(placeId), { errorCorrectionLevel: 'M', margin: 2, width: 512 });
