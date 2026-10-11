import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startLive, describeLiveError, createLiveToggle, LiveError, LIVE_CONNECT_TIMEOUT_MS, LIVE_MAX_MS, type LiveDeps, type LiveState } from './liveSession';
import { pcm16ToBase64 } from './liveAudio';
import type { LiveCtx } from './liveTools';
import type { NavOutcome } from './itinerary';

// Tout est SIMULÉ (micro, audio, SDK, WebSocket) : ces tests prouvent le cycle de vie, PAS que Gemini Live fonctionne sur un appareil réel.
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = <T,>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const mkStream = () => { const t = { stop: vi.fn() }; return { stream: { getTracks: () => [t] } as unknown as MediaStream, track: t }; };
class FakeAC {
  currentTime = 0; sampleRate = 48000; destination = {}; sources: any[] = []; close = vi.fn(async () => {}); resume = vi.fn(async () => {});
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() }); lastProc: any; createScriptProcessor = () => (this.lastProc = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as any });
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }); createBuffer = (_c: number, n: number, r: number) => ({ duration: n / r, copyToChannel: vi.fn() });
  createBufferSource = () => { const s = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as any }; this.sources.push(s); return s; };
}
const READY: NavOutcome = { status: 'route_ready', plan: { route: {} as any, steps: ['a'], legs: [] }, distance_m: 50, minutes: 1 };
function setup(o: { media?: Promise<MediaStream>; token?: Promise<{ token: string; model: string; max_session_s?: number }>; connect?: Promise<any>; nav?: NavOutcome; onEnd?: (s: number) => void; createAc?: () => any; prep?: (ac: FakeAC) => void } = {}) {
  const m = mkStream(), ac = new FakeAC(), session = { close: vi.fn(), sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn() }; let cb: any;
  const states: LiveState[] = [], errors: string[] = [], notes: string[] = [];
  const getCtx = vi.fn((): LiveCtx => ({ places: [{ id: 'p1', name: 'Bâtiment D3', type_label: 'Bâtiment', type: 'batiment' }], onShowPlace: () => true, onNavigate: () => o.nav ?? READY }));
  const getToken = vi.fn(() => o.token ?? Promise.resolve({ token: 'auth_tokens/x', model: 'live-x' })); const createAudioContext = vi.fn(() => (o.createAc ? o.createAc() : ac) as unknown as AudioContext);
  const deps: LiveDeps = { getUserMedia: vi.fn(() => o.media ?? Promise.resolve(m.stream)), createAudioContext,
    loadSdk: async () => ({ Modality: { AUDIO: 'AUDIO' }, GoogleGenAI: class { live = { connect: (a: any) => { cb = a.callbacks; return o.connect ?? Promise.resolve(session); } }; } }) };
  o.prep?.(ac); const ctl = startLive({ getToken, getCtx, onState: (s) => states.push(s), onNote: (t) => notes.push(t), onError: (e) => errors.push(e), onEnd: o.onEnd, deps });
  return { ctl, m, ac, session, states, errors, notes, getCtx, getToken, createAudioContext, cb: () => cb };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());

describe('cycle de vie Live', () => {
  it('le contrôleur est rendu immédiatement, état « connecting »', () => { const h = setup(); expect(h.ctl.isClosed()).toBe(false); expect(h.states).toEqual(['connecting']); });
  it('arrêt PENDANT l’invite micro : pistes libérées à l’arrivée, aucun jeton demandé, contexte audio refermé', async () => {
    const media = deferred<MediaStream>(), h = setup({ media: media.p }); h.ctl.stop(); expect(h.states.at(-1)).toBe('closed');
    media.res(h.m.stream); await flush(); expect(h.m.track.stop).toHaveBeenCalled(); expect(h.getToken).not.toHaveBeenCalled(); expect(h.ac.close).toHaveBeenCalled(); expect(h.errors).toEqual([]);   // le contexte audio (créé dans le geste utilisateur, pour iOS) est refermé
  });
  it('arrêt pendant l’obtention du jeton : tout est nettoyé, aucune connexion', async () => {
    const tok = deferred<{ token: string; model: string }>(), h = setup({ token: tok.p }); await flush(); h.ctl.stop(); tok.res({ token: 't', model: 'm' }); await flush();
    expect(h.m.track.stop).toHaveBeenCalled(); expect(h.ac.close).toHaveBeenCalled(); expect(h.cb()).toBeUndefined();
  });
  it('arrêt pendant la connexion : une session qui s’ouvre TARD est refermée aussitôt', async () => {
    const conn = deferred<any>(), h = setup({ connect: conn.p }); await flush(); h.ctl.stop(); conn.res(h.session); await flush();
    expect(h.session.close).toHaveBeenCalled(); expect(h.m.track.stop).toHaveBeenCalled(); expect(h.ac.close).toHaveBeenCalled(); expect(h.states.at(-1)).toBe('closed'); expect(h.session.sendRealtimeInput).not.toHaveBeenCalled();
  });
  it('démontage du panneau = stop() : même effet, état « closed » une seule fois (double stop inoffensif)', async () => {
    const h = setup(); await flush(); expect(h.states.at(-1)).toBe('listening'); h.ctl.stop(); h.ctl.stop(); expect(h.states.filter((s) => s === 'closed')).toHaveLength(1); expect(h.session.close).toHaveBeenCalledOnce(); expect(h.m.track.stop).toHaveBeenCalled();
  });
  it('permission micro refusée : message clair, état fermé', async () => {
    const h = setup({ media: Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) }); await flush();
    expect(h.errors[0]).toMatch(/microphone refusé/i); expect(h.states.at(-1)).toBe('closed'); expect(h.getToken).not.toHaveBeenCalled();
  });
  it('jeton refusé (quota, consentement) : le motif du serveur est affiché, micro libéré', async () => {
    const h = setup({ token: Promise.reject({ status: 429, message: 'Limite quotidienne atteinte.' }) }); await flush();
    expect(h.errors).toEqual(['Limite quotidienne atteinte.']); expect(h.m.track.stop).toHaveBeenCalled(); expect(h.states.at(-1)).toBe('closed');
  });
  it('délai de connexion dépassé : erreur compréhensible, tout est libéré', async () => {
    const h = setup({ token: new Promise(() => {}) }); await flush(); await vi.advanceTimersByTimeAsync(LIVE_CONNECT_TIMEOUT_MS + 10);
    expect(h.errors[0]).toMatch(/trop de temps/); expect(h.ctl.isClosed()).toBe(true); expect(h.m.track.stop).toHaveBeenCalled();
  });
  it('erreur WebSocket en cours de session : fermeture propre + message', async () => {
    const h = setup(); await flush(); h.cb().onerror(new Error('boom')); expect(h.errors).toHaveLength(1); expect(h.errors[0]).not.toMatch(/boom/); expect(h.session.close).toHaveBeenCalled(); expect(h.ctl.isClosed()).toBe(true);
  });
  it('expiration de session (durée maximale) : arrêt automatique et note', async () => {
    const h = setup(); await flush(); await vi.advanceTimersByTimeAsync(LIVE_MAX_MS + 10); expect(h.ctl.isClosed()).toBe(true); expect(h.notes.at(-1)).toMatch(/durée maximale/);
  });
});

describe('audio et outils pendant la session', () => {
  const audio = { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm16ToBase64(Int16Array.from([0, 1000, -1000])), mimeType: 'audio/pcm;rate=24000' } }] } } };
  it('interruption signalée par Google : lecture coupée immédiatement, retour à l’écoute', async () => {
    const h = setup(); await flush(); h.cb().onmessage(audio); expect(h.states.at(-1)).toBe('speaking'); expect(h.ac.sources).toHaveLength(1);
    h.cb().onmessage({ serverContent: { interrupted: true } }); expect(h.ac.sources[0].stop).toHaveBeenCalled(); expect(h.states.at(-1)).toBe('listening');
  });
  it('blocs audio mis bout à bout dans l’ordre d’arrivée', async () => {
    const h = setup(); await flush(); h.cb().onmessage(audio); h.cb().onmessage(audio); const [a, b] = h.ac.sources; expect(b.start.mock.calls[0][0]).toBeGreaterThan(a.start.mock.calls[0][0]);
  });
  it('appel d’outil : contexte RELU à chaque appel, réponse renvoyée à la session', async () => {
    const h = setup(); await flush(); const call = (id: string) => h.cb().onmessage({ toolCall: { functionCalls: [{ id, name: 'start_navigation', args: { place_id: 'p1' } }] } });
    call('1'); call('2'); expect(h.getCtx).toHaveBeenCalledTimes(2); expect(h.session.sendToolResponse).toHaveBeenCalledTimes(2);
    expect(h.session.sendToolResponse.mock.calls[0][0].functionResponses[0]).toMatchObject({ id: '1', name: 'start_navigation', response: { result: { ok: true, status: 'route_ready' } } });
  });
  it('GPS indisponible : le modèle reçoit gps_needed (pas d’itinéraire annoncé)', async () => {
    const h = setup({ nav: { status: 'gps_needed' } }); await flush(); h.cb().onmessage({ toolCall: { functionCalls: [{ id: '1', name: 'start_navigation', args: { place_id: 'p1' } }] } });
    expect(h.session.sendToolResponse.mock.calls[0][0].functionResponses[0].response.result).toMatchObject({ ok: false, status: 'gps_needed' }); expect(h.notes.join()).not.toMatch(/Itinéraire prêt/);
  });
  it('identifiant de lieu inconnu : refusé, rien n’est exécuté', async () => {
    const h = setup(); await flush(); h.cb().onmessage({ toolCall: { functionCalls: [{ id: '1', name: 'start_navigation', args: { place_id: 'inventé' } }] } });
    expect(h.session.sendToolResponse.mock.calls[0][0].functionResponses[0].response.result).toMatchObject({ ok: false, status: 'unknown_place' });
  });
  it('message ou outil reçu APRÈS fermeture : ignoré (ni exécution, ni réponse, ni audio)', async () => {
    const h = setup(); await flush(); const cb = h.cb(); h.ctl.stop(); h.getCtx.mockClear();
    cb.onmessage({ toolCall: { functionCalls: [{ id: '1', name: 'start_navigation', args: { place_id: 'p1' } }] } }); cb.onmessage(audio);
    expect(h.getCtx).not.toHaveBeenCalled(); expect(h.session.sendToolResponse).not.toHaveBeenCalled(); expect(h.ac.sources).toHaveLength(0);
  });
});

describe('messages d’erreur', () => {
  it('jamais de détail technique', () => {
    expect(describeLiveError({ name: 'NotFoundError' })).toMatch(/Aucun microphone/); expect(describeLiveError({ name: 'NotReadableError' })).toMatch(/autre application/);
    expect(describeLiveError({ status: 401 })).toMatch(/Session expirée/); expect(describeLiveError(new Error('wss://google/?key=SECRET'))).not.toMatch(/SECRET/);
  });
});

// ---- lots 2, 5 et 6 : audio, durée, erreurs, double clic (tout est simulé)
describe('contexte audio et erreurs lisibles', () => {
  it('le contexte audio est créé SYNCHRONE dans le geste utilisateur (avant l’invite micro), puis démarré', async () => {
    const media = deferred<MediaStream>(), h = setup({ media: media.p });
    expect(h.createAudioContext).toHaveBeenCalledOnce(); expect(h.ac.resume).toHaveBeenCalled();   // avant toute attente
    media.res(h.m.stream); await flush(); h.ctl.stop();
  });
  it('lecture audio bloquée (resume refusé) : message dédié, tout libéré', async () => {
    const h = setup({ prep: (a) => a.resume.mockRejectedValue(new Error('x')) }); await flush();
    expect(h.errors).toEqual([expect.stringMatching(/bloque le son/)]); expect(h.ctl.isClosed()).toBe(true); expect(h.getToken).not.toHaveBeenCalled(); expect(h.m.track.stop).toHaveBeenCalled();
  });
  it('contexte audio indisponible : navigateur non pris en charge', async () => {
    const h = setup({ createAc: () => { throw new Error('no AudioContext'); } }); await flush();
    expect(h.errors).toEqual([expect.stringMatching(/ne permet pas la conversation vocale/)]); expect(h.ctl.isClosed()).toBe(true);
  });
  it('jeton MaCité expiré (401) : invite à se reconnecter ; jeton Google refusé à la connexion : message générique sans détail', async () => {
    const a = setup({ token: Promise.reject(Object.assign(new Error('x'), { status: 401 })) }); await flush(); expect(a.errors).toEqual([expect.stringMatching(/Session expirée/)]);
    const b = setup({ connect: Promise.reject(Object.assign(new Error('wss://g/?key=SECRET expired'), { status: 400 })) }); await flush();
    expect(b.errors).toHaveLength(1); expect(b.errors[0]).not.toMatch(/SECRET|wss/); expect(b.ctl.isClosed()).toBe(true);
  });
  it('réseau coupé : message réseau (échec de fetch ET socket en erreur)', async () => {
    const a = setup({ token: Promise.reject(new TypeError('Failed to fetch')) }); await flush(); expect(a.errors).toEqual([expect.stringMatching(/Pas de réseau/)]);
    const b = setup(); await flush(); b.cb().onerror(new Event('error')); expect(b.errors.at(-1)).toMatch(/interrompue/); expect(b.ctl.isClosed()).toBe(true);
  });
  it('messages : navigateur, HTTPS, jamais de détail technique', () => {
    expect(describeLiveError(new LiveError('insecure', 'Le micro n’est disponible qu’en connexion sécurisée (HTTPS).'))).toMatch(/HTTPS/);
    expect(describeLiveError(new TypeError('Failed to fetch https://x?key=SECRET'))).not.toMatch(/SECRET/);
  });
  it('échec de lecture d’un bloc audio : coupe, repasse en écoute, une seule note même si cela se répète', async () => {
    const h = setup(); await flush(); h.ac.createBuffer = () => { throw new Error('decode'); };
    const chunk = { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm16ToBase64(Int16Array.from([1, 2])), mimeType: 'audio/pcm;rate=24000' } }] } } };
    h.cb().onmessage(chunk); h.cb().onmessage(chunk);
    expect(h.states.at(-1)).toBe('listening'); expect(h.notes.filter((n) => /Lecture audio impossible/.test(n))).toHaveLength(1);
  });
});

describe('durée, coût et expiration', () => {
  it('onEnd : durée réelle appelée UNE fois, uniquement si la session s’est ouverte', async () => {
    const onEnd = vi.fn(); const h = setup({ onEnd }); await flush(); await vi.advanceTimersByTimeAsync(42_000); h.ctl.stop(); h.ctl.stop();
    expect(onEnd).toHaveBeenCalledOnce(); expect(onEnd.mock.calls[0][0]).toBeGreaterThanOrEqual(41); expect(onEnd.mock.calls[0][0]).toBeLessThanOrEqual(43);
    const never = vi.fn(); const media = deferred<MediaStream>(), g = setup({ media: media.p, onEnd: never }); g.ctl.stop(); media.res(g.m.stream); await flush(); expect(never).not.toHaveBeenCalled();
    const failed = vi.fn(); setup({ token: Promise.reject(new Error('x')), onEnd: failed }); await flush(); expect(failed).not.toHaveBeenCalled();
  });
  it('la durée autorisée par le serveur (max_session_s) prime, sans jamais dépasser le plafond du client', async () => {
    const h = setup({ token: Promise.resolve({ token: 't', model: 'm', max_session_s: 30 }) }); await flush();
    await vi.advanceTimersByTimeAsync(29_000); expect(h.ctl.isClosed()).toBe(false); await vi.advanceTimersByTimeAsync(2_000); expect(h.ctl.isClosed()).toBe(true); expect(h.notes.at(-1)).toMatch(/durée maximale/);
    const g = setup({ token: Promise.resolve({ token: 't', model: 'm', max_session_s: 99_999 }) }); await flush(); await vi.advanceTimersByTimeAsync(LIVE_MAX_MS + 10); expect(g.ctl.isClosed()).toBe(true);
  });
  it('audio d’entrée : PCM 16 bits mono envoyé à 16 kHz (mimeType), par blocs filtrés', async () => {
    const h = setup(); await flush(); const proc = (h.ac as any).lastProc; expect(proc).toBeTruthy();
    proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) } }); proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) } });
    const calls = h.session.sendRealtimeInput.mock.calls; expect(calls.length).toBe(2); expect(calls[0][0].audio.mimeType).toBe('audio/pcm;rate=16000');
    const total = calls.reduce((n: number, c: any) => n + atob(c[0].audio.data).length / 2, 0); expect(total).toBeGreaterThan(3100); expect(total).toBeLessThanOrEqual(3200);   // 9600 échantillons à 48 kHz → ~3200 à 16 kHz
  });
});

describe('double clic et itinéraire impossible', () => {
  it('un double clic ne laisse jamais deux sessions : le 2e clic arrête la 1re, SANS demander de jeton (donc sans consommer de quota)', async () => {
    const started: any[] = []; const t = createLiveToggle(() => { const h = setup(); started.push(h); return h.ctl; });
    expect(t.toggle()).toBe('started'); expect(t.active()).toBe(true); expect(t.toggle()).toBe('stopped'); expect(t.active()).toBe(false);
    await flush(); expect(started).toHaveLength(1); expect(started[0].getToken).not.toHaveBeenCalled();   // arrêtée avant le jeton : aucun quota consommé
    expect(t.toggle()).toBe('started'); expect(started).toHaveLength(2); t.stop(); expect(t.active()).toBe(false);
  });
  it('une session déjà fermée (expirée, erreur) permet d’en relancer une', async () => {
    const t = createLiveToggle(() => setup({ token: Promise.reject(new Error('x')) }).ctl); t.toggle(); await flush(); expect(t.active()).toBe(false); expect(t.toggle()).toBe('started');
  });
  it('aucun chemin praticable : le modèle reçoit no_route, jamais « itinéraire prêt »', async () => {
    const h = setup({ nav: { status: 'no_route', reason: 'no_path' } }); await flush();
    h.cb().onmessage({ toolCall: { functionCalls: [{ id: 'a', name: 'start_navigation', args: { place_id: 'p1' } }] } });
    const r = h.session.sendToolResponse.mock.calls[0][0].functionResponses[0].response.result; expect(r).toMatchObject({ ok: false, status: 'no_route_no_path' }); expect(JSON.stringify(r)).not.toMatch(/Itinéraire prêt/); expect(h.notes.at(-1)).toMatch(/Aucun chemin/);
  });
});
