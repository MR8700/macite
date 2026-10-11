// Conversation vocale avec Gemini Live : micro → WebSocket Google (jeton éphémère fourni par NOTRE serveur) → haut-parleur.
// NON TESTÉ sur appareil ni avec une vraie clé : voir docs/ASSISTANT_IA.md. Le SDK est chargé à la demande.
// Cycle de vie : startLive() renvoie IMMÉDIATEMENT un contrôleur ; stop() est valable à toute phase (autorisation micro, jeton, connexion, session).
import { base64ToFloat32, Downsampler, IN_RATE, pcm16ToBase64, rateFromMime } from './liveAudio';
import { captureScriptProcessor, type Capture } from './liveCapture';
import { runLiveTool, type LiveCtx } from './liveTools';

export type LiveState = 'connecting' | 'listening' | 'speaking' | 'closed';
export const LIVE_MAX_MS = 5 * 60_000;            // plafond de coût : une session s'arrête seule
export const LIVE_CONNECT_TIMEOUT_MS = 15_000;    // micro accordé → session ouverte ; le jeton ne laisse de toute façon qu'une minute
export interface LiveController { stop(): void; isClosed(): boolean }
export interface LiveDeps {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  loadSdk(): Promise<{ GoogleGenAI: any; Modality: any }>;
}
const G = globalThis as any;
const realDeps: LiveDeps = {
  getUserMedia: (c) => { if (!navigator.mediaDevices?.getUserMedia) throw new LiveError(G.isSecureContext === false ? 'insecure' : 'unsupported', G.isSecureContext === false ? MSG.insecure : MSG.unsupported); return navigator.mediaDevices.getUserMedia(c); },
  createAudioContext: () => new (G.AudioContext ?? G.webkitAudioContext)() as AudioContext,
  loadSdk: () => import('@google/genai') as Promise<any>,
};
export interface LiveOpts {
  getToken(): Promise<{ token: string; model: string; max_session_s?: number }>;   // appelé APRÈS l'accord du micro (le jeton ne laisse qu'1 minute pour démarrer)
  getCtx(): LiveCtx;                                         // relu à CHAQUE appel d'outil : lieux, GPS et graphe toujours à jour
  onState(s: LiveState): void; onNote(t: string): void; onError(m: string): void; deps?: Partial<LiveDeps>;
  onEnd?(seconds: number): void;   // une seule fois, si la session s'est réellement ouverte : durée écoutée (mesure du coût pendant le pilote)
}
export const isLiveSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof WebSocket !== 'undefined' && !!(G.AudioContext ?? G.webkitAudioContext);

class Cancelled extends Error {}
class Timeout extends Error {}
/** Erreur renvoyée par NOTRE serveur lors de la demande de jeton : son message (français, sans secret) peut être affiché. */
class TokenError extends Error { constructor(public status?: number, m = '') { super(m); } }
class ConnectError extends Error {}
/** Erreur dont le message est déjà lisible par l'utilisateur. */
export class LiveError extends Error { constructor(public code: 'unsupported' | 'insecure' | 'audio' | 'network', m: string) { super(m); } }
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
/** Message compréhensible pour l'utilisateur ; jamais le détail technique (il peut contenir une URL ou un jeton). */
export function describeLiveError(e: any): string {
  const n = e?.name, st = e?.status;
  if (e instanceof LiveError) return e.message;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Accès au microphone refusé : autorisez-le dans les réglages du navigateur.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Aucun microphone disponible sur cet appareil.';
  if (n === 'NotReadableError') return 'Le microphone est utilisé par une autre application.';
  if (e instanceof Timeout) return 'La connexion vocale a pris trop de temps. Vérifiez votre réseau et réessayez.';
  if (e instanceof ConnectError) return offline() ? MSG.network : 'Le service vocal a refusé ou interrompu la connexion (jeton expiré ou refusé). Réessayez.';   // jamais le message du SDK : il peut contenir l'URL ou le jeton
  if (e instanceof TokenError && e.status !== 401 && typeof e.status === 'number' && e.status >= 400 && e.status < 600 && e.message) return e.message;   // motif de NOTRE serveur (quota, consentement…)
  if (st === 401) return 'Session expirée : reconnectez-vous (onglet Synchro).';
  if (offline() || (n === 'TypeError' && /fetch|network|load failed/i.test(String(e?.message)))) return MSG.offline;
  return 'Impossible de démarrer la conversation vocale.';
}
const MSG = {
  offline: 'Pas de réseau : vérifiez votre connexion puis réessayez.',
  unsupported: 'Ce navigateur ne permet pas la conversation vocale (micro ou audio indisponible).',
  insecure: 'Le micro n’est disponible qu’en connexion sécurisée (HTTPS).',
  audio: 'Le navigateur bloque le son : touchez l’écran puis relancez la conversation vocale.',
  network: 'La connexion vocale a été interrompue : vérifiez votre réseau et réessayez.',
};

/** Bascule du bouton : s'il existe une session non fermée, la ferme ; sinon en démarre UNE. Un double clic ne peut donc jamais en ouvrir deux. */
export function createLiveToggle(start: () => LiveController) {
  let ctl: LiveController | null = null;
  return { toggle(): 'started' | 'stopped' { if (ctl && !ctl.isClosed()) { ctl.stop(); return 'stopped'; } ctl = start(); return 'started'; }, stop() { ctl?.stop(); }, active: () => !!ctl && !ctl.isClosed() };
}

export function startLive(o: LiveOpts): LiveController {
  const d: LiveDeps = { ...realDeps, ...o.deps };
  let closed = false, opened = false, openedAt = 0, state: LiveState = 'connecting', rejectAbort!: (e: Error) => void, nextAt = 0, playbackWarned = false;
  let stream: MediaStream | undefined, ac: AudioContext | undefined, session: any, cap: Capture | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined, maxTimer: ReturnType<typeof setTimeout> | undefined;
  const playing = new Set<AudioBufferSourceNode>();
  const aborted = new Promise<never>((_, rej) => { rejectAbort = rej; }); aborted.catch(() => {});
  const emit = (s: LiveState) => { if (s === state) return; state = s; o.onState(s); };
  const setState = (s: LiveState) => { if (!closed) emit(s); };
  const quiet = (f: () => void) => { try { f(); } catch { /* déjà libéré */ } };
  const flush = () => { playing.forEach((s) => quiet(() => s.stop())); playing.clear(); nextAt = 0; };
  const cleanup = () => {   // idempotent : libère tout ce qui existe à cet instant
    clearTimeout(connectTimer); clearTimeout(maxTimer); flush();
    quiet(() => cap?.stop()); quiet(() => session?.close()); stream?.getTracks().forEach((t) => quiet(() => t.stop()));
    const c = ac; if (c) quiet(() => { void Promise.resolve(c.close()).catch(() => {}); });
    cap = session = stream = ac = undefined;
  };
  const stop = () => {
    if (closed) return; closed = true; cleanup(); rejectAbort(new Cancelled());
    if (opened) quiet(() => o.onEnd?.(Math.max(0, Math.round((Date.now() - openedAt) / 1000))));   // une seule fois, jamais si la session ne s'est pas ouverte
    emit('closed');
  };
  const fail = (e: unknown) => { if (closed || e instanceof Cancelled) return; o.onError(describeLiveError(e)); stop(); };
  /** Attend p, mais abandonne si stop() est appelé ; une valeur arrivée APRÈS l'arrêt est libérée par `late` (une seule fois).
   *  Le contrôle `closed` après l'attente est indispensable : une promesse DÉJÀ résolue gagne la course contre `aborted`. */
  const step = async <T,>(p: Promise<T>, late?: (v: T) => void): Promise<T> => {
    p.then((v) => { if (closed) late?.(v); }, () => {});
    const v = await Promise.race([p, aborted]);
    if (closed) { late?.(v); throw new Cancelled(); }
    return v;
  };

  const play = (pcm: Float32Array, rate: number) => {
    if (closed || !ac || !pcm.length) return;
    const buf = ac.createBuffer(1, pcm.length, rate); buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
    nextAt = Math.max(nextAt, ac.currentTime + 0.02); src.start(nextAt); nextAt += buf.duration; playing.add(src);   // blocs mis bout à bout, dans l'ordre d'arrivée ; cadence = celle du mimeType
    src.onended = () => { playing.delete(src); if (!playing.size) setState('listening'); };
  };
  const onMessage = (m: any) => {
    if (closed) return;                                  // ni lecture ni outil après fermeture
    const c = m?.serverContent;
    if (c?.interrupted) { flush(); setState('listening'); }   // l'utilisateur a repris la parole : on coupe tout de suite
    for (const part of c?.modelTurn?.parts ?? []) if (part?.inlineData?.data) {
      setState('speaking');
      try { play(base64ToFloat32(part.inlineData.data), rateFromMime(part.inlineData.mimeType)); }
      catch { flush(); setState('listening'); if (!playbackWarned) { playbackWarned = true; o.onNote('Lecture audio impossible sur cet appareil.'); } }
    }
    const calls = m?.toolCall?.functionCalls;
    if (Array.isArray(calls) && calls.length) {
      const functionResponses = calls.map((fc: any) => {
        const result = runLiveTool(String(fc?.name), fc?.args, o.getCtx());   // contexte relu : jamais celui du démarrage
        const r = result as any;
        if (fc?.name === 'start_navigation' && typeof r.message === 'string') o.onNote(r.message);   // ce que l'écran affiche = ce que le modèle a reçu
        else if (fc?.name === 'show_place' && r.ok) o.onNote(`Affichage de ${r.place?.name}`);
        return { id: fc?.id, name: fc?.name, response: { result } };
      });
      if (!closed && session) quiet(() => session.sendToolResponse({ functionResponses }));
    }
  };

  (async () => {
    // Le contexte audio est créé ICI, de façon synchrone, dans le geste de l'utilisateur : iOS Safari refuse de le démarrer après une invite micro asynchrone.
    try { ac = d.createAudioContext(); } catch { throw new LiveError('unsupported', MSG.unsupported); }
    const resumed = Promise.resolve(ac.resume()); resumed.catch(() => {});
    stream = await step(d.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }), (s) => s.getTracks().forEach((t) => quiet(() => t.stop())));
    connectTimer = setTimeout(() => fail(new Timeout()), LIVE_CONNECT_TIMEOUT_MS);   // démarre une fois le micro accordé (l'invite peut durer)
    try { await step(resumed); } catch (e) { if (e instanceof Cancelled) throw e; throw new LiveError('audio', MSG.audio); }
    if (ac && (ac as any).state === 'suspended') { try { await step(Promise.resolve(ac.resume())); } catch (e) { if (e instanceof Cancelled) throw e; } if ((ac as any)?.state === 'suspended') throw new LiveError('audio', MSG.audio); }
    const t = await step(o.getToken().catch((e: any) => { if (e?.name === 'TypeError' || offline()) throw new LiveError('network', MSG.offline); throw new TokenError(typeof e?.status === 'number' ? e.status : undefined, typeof e?.message === 'string' ? e.message : ''); }));
    const sdk = await step(d.loadSdk());
    const ai = new sdk.GoogleGenAI({ apiKey: t.token, httpOptions: { apiVersion: 'v1beta' } });   // un jeton éphémère s'utilise comme une clé, en v1beta
    session = await step(Promise.resolve(ai.live.connect({
      model: t.model, config: { responseModalities: [sdk.Modality.AUDIO] },   // le reste (outils, consignes) est verrouillé côté serveur dans le jeton
      callbacks: { onopen: () => {}, onmessage: onMessage, onerror: () => fail(new LiveError('network', MSG.network)), onclose: () => { if (!closed) { o.onError(offline() ? MSG.network : 'La session vocale est terminée.'); stop(); } } },
    })).catch((e: unknown) => { throw new ConnectError(String((e as any)?.name ?? '')); }), (s: any) => quiet(() => s.close()));
    if (closed) return;
    const A = ac!, S = session, down = new Downsampler(A.sampleRate);   // filtre anti-repliement avec état conservé d'un bloc à l'autre
    cap = captureScriptProcessor(A, stream!, (samples) => {
      if (closed) return;
      const pcm = down.process(samples); if (pcm.length) quiet(() => S.sendRealtimeInput({ audio: { data: pcm16ToBase64(pcm), mimeType: `audio/pcm;rate=${IN_RATE}` } }));
    });
    clearTimeout(connectTimer); opened = true; openedAt = Date.now(); setState('listening');
    const limit = typeof t.max_session_s === 'number' && t.max_session_s > 0 ? Math.min(LIVE_MAX_MS, t.max_session_s * 1000) : LIVE_MAX_MS;   // jamais plus long que ce que le serveur a autorisé
    maxTimer = setTimeout(() => { o.onNote('Session vocale terminée (durée maximale atteinte).'); stop(); }, limit);
  })().catch(fail);
  o.onState('connecting');
  return { stop, isClosed: () => closed };
}
