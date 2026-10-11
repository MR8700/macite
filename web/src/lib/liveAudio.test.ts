import { describe, it, expect } from 'vitest';
import { Downsampler, downsampleToPcm16, base64ToFloat32, pcm16ToBase64 } from './liveAudio';

const tone = (hz: number, rate: number, n: number, amp = 0.8) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (a: Int16Array, skip = 200) => { let s = 0, c = 0; for (let i = skip; i < a.length - skip; i++) { s += (a[i] / 0x8000) ** 2; c++; } return Math.sqrt(s / c); };

describe('sous-échantillonnage avec filtre anti-repliement', () => {
  it('bande passante conservée : 1 kHz et 3 kHz presque intacts (48 → 16 kHz)', () => {
    for (const hz of [1000, 3000]) { const out = downsampleToPcm16(tone(hz, 48000, 9600), 48000); expect(rms(out)).toBeGreaterThan(0.8 * Math.SQRT1_2 * 0.97); expect(rms(out)).toBeLessThan(0.8 * Math.SQRT1_2 * 1.03); }
  });
  it('repliement supprimé : un son à 10 kHz (qui retomberait à 6 kHz) est atténué de plus de 40 dB', () => {
    const out = downsampleToPcm16(tone(10000, 48000, 9600), 48000), ref = 0.8 * Math.SQRT1_2;
    expect(rms(out) / ref).toBeLessThan(0.01);
    // l'ancien filtre (moyenne par bloc) laissait passer ~50 % de ce son : preuve que le test détecte bien le défaut
    const src = tone(10000, 48000, 9600), boxcar = Float32Array.from({ length: 3200 }, (_, i) => (src[3 * i] + src[3 * i + 1] + src[3 * i + 2]) / 3);
    expect(Math.sqrt(boxcar.reduce((s, v) => s + v * v, 0) / boxcar.length) / ref).toBeGreaterThan(0.3);
  });
  it('rapport non entier (44,1 → 16 kHz) : même résultat, longueur correcte', () => {
    const out = downsampleToPcm16(tone(1000, 44100, 8820), 44100); expect(out.length).toBe(Math.floor(8820 / (44100 / 16000))); expect(rms(out)).toBeGreaterThan(0.8 * Math.SQRT1_2 * 0.95);
    expect(rms(downsampleToPcm16(tone(11000, 44100, 8820), 44100)) / (0.8 * Math.SQRT1_2)).toBeLessThan(0.02);
  });
  it('flux : découper le signal en blocs donne le même son qu’un seul bloc (pas de coupure audible)', () => {
    const x = tone(1500, 48000, 12288), whole = new Downsampler(48000).process(x, true), d = new Downsampler(48000), parts: number[] = [];
    for (let i = 0; i < x.length; i += 4096) parts.push(...d.process(x.subarray(i, i + 4096)));
    const n = Math.min(parts.length, whole.length); expect(n).toBeGreaterThan(4000); let maxDiff = 0; for (let i = 100; i < n - 100; i++) maxDiff = Math.max(maxDiff, Math.abs(parts[i] - whole[i]));
    expect(maxDiff).toBeLessThan(40);   // < 0,2 % de la pleine échelle
  });
  it('16 kHz → 16 kHz : conversion seule, valeurs bornées, silence = silence', () => {
    expect(Array.from(downsampleToPcm16(Float32Array.from([0, 0.5, -0.5, 1, -1, 3]), 16000))).toEqual([0, 16383, -16384, 32767, -32768, 32767]);
    expect(Math.max(...downsampleToPcm16(new Float32Array(480), 48000).map(Math.abs))).toBe(0);
  });
  it('sortie : PCM 16 bits little-endian, aller-retour base64 fidèle', () => {
    const pcm = downsampleToPcm16(Float32Array.from([0, 0.25, -0.25]), 16000), back = base64ToFloat32(pcm16ToBase64(pcm)); [0, 0.25, -0.25].forEach((v, i) => expect(Math.abs(back[i] - v)).toBeLessThan(0.001));
  });
});
