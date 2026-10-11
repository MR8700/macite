/** Réduit une photo (≤1280 px) en JPEG qualité 0,7 pour tenir sous la limite serveur de 2 Mo. */
export function scaleDims(w: number, h: number, max = 1280): [number, number] {
  const k = Math.min(1, max / Math.max(w, h)); return [Math.round(w * k), Math.round(h * k)];
}
export async function resizeToJpeg(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file); const [w, h] = scaleDims(bmp.width, bmp.height);
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encodage'))), 'image/jpeg', 0.7));
}
