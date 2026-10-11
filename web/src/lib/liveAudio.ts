// Audio pour Gemini Live : entrée = PCM 16 bits, 16 kHz, mono, little-endian ; sortie = PCM 16 bits (cadence lue dans le mimeType, 24 kHz par défaut).
export const IN_RATE = 16000;
export const DEFAULT_OUT_RATE = 24000;

const PHASES = 64;                      // finesse de l'interpolation de phase (rapports non entiers, ex. 44,1 kHz → 16 kHz)
const HALF_WIDTH_RATIO = 16;            // demi-largeur du filtre, en périodes de sortie : ~97 coefficients pour 48 → 16 kHz
const CUTOFF = 0.8;                     // coupure à 80 % de Nyquist de sortie : bande passante ~6,4 kHz, zone de transition avant 8 kHz
const blackman = (x: number) => 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);   // x ∈ [-1, 1]
const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const toPcm = (v: number) => { const c = Math.max(-1, Math.min(1, v)); return c < 0 ? c * 0x8000 : c * 0x7fff; };

/** Sous-échantillonneur EN FLUX : filtre passe-bas (sinc fenêtré de Blackman) AVANT décimation, pour éviter le repliement
 *  (un son à 10 kHz capté à 48 kHz ne doit pas réapparaître à 6 kHz). L'état est conservé d'un bloc à l'autre : aucune coupure audible.
 *  Latence ajoutée : quelques dizaines d'échantillons d'entrée (< 1 ms). Si le rapport est ≤ 1, aucun filtrage (simple conversion). */
export class Downsampler {
  readonly ratio: number; private H: number; private table: Float32Array[] = [];
  private carry = new Float32Array(0); private base = 0; private tau = 0;   // base = indice absolu de carry[0] ; tau = position absolue de la prochaine sortie
  constructor(inRate: number, outRate = IN_RATE) {
    this.ratio = inRate / outRate; this.H = this.ratio <= 1 ? 0 : Math.ceil(HALF_WIDTH_RATIO * this.ratio);
    if (this.H) {
      const fc = CUTOFF / (2 * this.ratio);   // fréquence de coupure en cycles par échantillon d'entrée
      for (let p = 0; p < PHASES; p++) {
        const frac = p / PHASES, w = new Float32Array(2 * this.H); let sum = 0;
        for (let m = 0; m < 2 * this.H; m++) { const d = (m - this.H + 1) - frac; w[m] = Math.abs(d) >= this.H ? 0 : 2 * fc * sinc(2 * fc * d) * blackman(d / this.H); sum += w[m]; }
        for (let m = 0; m < w.length; m++) w[m] /= sum;   // gain continu = 1
        this.table.push(w);
      }
    }
  }
  /** final=true : traite aussi la fin du signal (sans attendre la suite) ; limit borne le nombre de sorties. */
  process(input: Float32Array, final = false, limit = Infinity): Int16Array {
    if (!this.H) { const o = new Int16Array(Math.min(input.length, limit)); for (let i = 0; i < o.length; i++) o[i] = toPcm(input[i]); return o; }
    const b = new Float32Array(this.carry.length + input.length); b.set(this.carry); b.set(input, this.carry.length);
    const end = this.base + b.length, out: number[] = [];
    while (out.length < limit && (final ? this.tau < end : this.tau + this.H < end)) {
      let n0 = Math.floor(this.tau), p = Math.round((this.tau - n0) * PHASES); if (p === PHASES) { p = 0; n0++; }
      const w = this.table[p]; let acc = 0, ws = 0;
      for (let m = 0; m < w.length; m++) { const idx = n0 - this.H + 1 + m - this.base; if (idx < 0 || idx >= b.length) continue; acc += b[idx] * w[m]; ws += w[m]; }
      out.push(ws > 1e-6 ? toPcm(acc / ws) : 0);   // bords : on renormalise sur les coefficients disponibles
      this.tau += this.ratio;
    }
    const keep = Math.max(0, Math.min(b.length, Math.floor(this.tau) - this.H + 1 - this.base));
    this.carry = b.slice(keep); this.base += keep;
    return Int16Array.from(out);
  }
}
/** Version sans état (un seul bloc) : même filtre, nombre de sorties = floor(n / rapport). */
export function downsampleToPcm16(input: Float32Array, inRate: number, outRate = IN_RATE): Int16Array {
  const d = new Downsampler(inRate, outRate); return d.process(input, true, Math.floor(input.length / d.ratio));
}
export function pcm16ToBase64(p: Int16Array): string {
  const u = new Uint8Array(p.buffer, p.byteOffset, p.byteLength); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = (bin.charCodeAt(2 * i + 1) << 8) | bin.charCodeAt(2 * i); if (v >= 0x8000) v -= 0x10000; out[i] = v / 0x8000; }
  return out;
}
export const rateFromMime = (m?: string): number => Number(/rate=(\d+)/.exec(m ?? '')?.[1]) || DEFAULT_OUT_RATE;
