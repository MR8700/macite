// Capture du micro. Une seule implémentation BRANCHÉE : ScriptProcessorNode (déprécié mais présent partout).
// L'AudioWorklet est PRÉPARÉ (source du processeur + chargeur) mais NON branché et NON testé : l'interface `Capture` permet de l'échanger
// en une ligne dans liveSession.ts une fois validé sur Android Chrome et iOS Safari (ne pas mélanger avec les correctifs de fiabilité).
export interface Capture { stop(): void }
const quiet = (f: () => void) => { try { f(); } catch { /* déjà libéré */ } };
export const CAPTURE_BLOCK = 4096;

export function captureScriptProcessor(ac: AudioContext, stream: MediaStream, onChunk: (samples: Float32Array) => void): Capture {
  const mic = ac.createMediaStreamSource(stream), proc = ac.createScriptProcessor(CAPTURE_BLOCK, 1, 1), mute = ac.createGain();
  let on = true;
  proc.onaudioprocess = (e) => { if (on) onChunk(e.inputBuffer.getChannelData(0)); };
  mute.gain.value = 0; mic.connect(proc); proc.connect(mute); mute.connect(ac.destination);   // le processeur doit être relié pour tourner ; rien n'est réémis
  return { stop() { on = false; proc.onaudioprocess = null; quiet(() => proc.disconnect()); quiet(() => mic.disconnect()); quiet(() => mute.disconnect()); } };
}

/** Processeur AudioWorklet : regroupe les blocs de 128 échantillons en blocs de 2048 avant envoi au fil principal. */
export const WORKLET_NAME = 'macite-capture';
export const WORKLET_SOURCE = `class MaCiteCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', MaCiteCapture);`;
export const supportsWorklet = (ac: AudioContext) => typeof AudioWorkletNode !== 'undefined' && !!ac.audioWorklet;

/** NON BRANCHÉ. À valider sur appareil avant usage. */
export async function captureWorklet(ac: AudioContext, stream: MediaStream, onChunk: (s: Float32Array) => void): Promise<Capture> {
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try { await ac.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const mic = ac.createMediaStreamSource(stream), node = new AudioWorkletNode(ac, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
  let on = true; node.port.onmessage = (e) => { if (on) onChunk(e.data as Float32Array); };
  mic.connect(node);
  return { stop() { on = false; node.port.onmessage = null; quiet(() => mic.disconnect()); quiet(() => node.disconnect()); } };
}
