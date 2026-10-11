import { useEffect, useRef, useState } from 'react';
import { AudioLines, Mic, Send, Sparkles, Square } from 'lucide-react';
import { aiChat, aiLiveStatus, aiLiveToken, aiStatus, aiUsage, type AiQuota, giveAiConsent, giveLiveConsent, revokeLiveConsent, aiLiveReport, hasAiConsent, hasAiSession, hasLiveConsent, AiError, type AiPlace, type ChatReply } from '../lib/aiClient';
import { confidentLocalMatch, rank, withParentNames, type Place } from '../lib/fuzzy';
import { isSttSupported, speak, startListening } from '../lib/voice';
import { createLiveToggle, isLiveSupported, startLive, type LiveState } from '../lib/liveSession';
import type { LiveCtx } from '../lib/liveTools';
import { outcomeMessage, type NavOutcome } from '../lib/itinerary';

/** Consentement explicite avant tout envoi à un service d'IA externe (Google). Réutilisé par le relevé. */
export function ConsentNotice({ onAccept }: { onAccept: () => void }) {
  return (<div role="group" aria-label="Consentement assistant IA">
    <div className="meta">L’assistant envoie votre texte à un service d’IA externe (Google AI Studio). Ne saisissez aucune information personnelle. Selon le navigateur, la dictée vocale peut aussi passer par un service distant. Votre position GPS n’est jamais transmise à ce service.</div>
    <div className="row"><button className="btn pri" onClick={() => { giveAiConsent(); onAccept(); }}>J’accepte</button></div></div>);
}

export function LiveConsentNotice({ onAccept }: { onAccept: () => void }) {
  return (<div role="group" aria-label="Consentement conversation vocale">
    <div className="meta">La conversation vocale envoie votre voix directement à Google (Gemini Live), sans passer par notre serveur. Ne dites aucune information personnelle. Utilisez de préférence un casque. Chaque conversation compte dans votre quota quotidien et s'arrête seule après 5 minutes.</div>
    <div className="row"><button className="btn pri" onClick={() => { giveLiveConsent(); onAccept(); }}>J’accepte la conversation vocale</button></div></div>);
}

interface Props { places: Place[]; position?: { lat: number; lon: number }; onShowPlace(p: AiPlace): boolean; onNavigate(p: AiPlace): NavOutcome; onLogin(): void }
interface Msg { who: 'me' | 'ai'; text: string; options?: AiPlace[]; note?: string }
const label = (o: AiPlace) => o.name + (o.parent_name ? ` (${o.parent_name})` : '');

export function AssistantPanel({ places, position, onShowPlace, onNavigate, onLogin }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null); const [consent, setConsent] = useState(hasAiConsent());
  const [msgs, setMsgs] = useState<Msg[]>([]); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false); const [aloud, setAloud] = useState(false); const [quota, setQuota] = useState<AiQuota | null>(null);
  const refreshQuota = () => { aiUsage().then(setQuota).catch(() => {}); };
  const [liveOn, setLiveOn] = useState(false); const [liveConsent, setLiveConsent] = useState(hasLiveConsent()); const [live, setLive] = useState<LiveState>('closed');
  const pushRef = useRef<(m: Msg) => void>(() => {});   // `push` change à chaque rendu ; le bouton vocal lit toujours la dernière version
  const toggler = useRef<ReturnType<typeof createLiveToggle> | null>(null);
  toggler.current ??= createLiveToggle(() => startLive({ getToken: aiLiveToken, getCtx: () => ctxRef.current, onState: setLive, onNote: t => pushRef.current({ who: 'ai', text: t }), onError: m => pushRef.current({ who: 'ai', text: m }), onEnd: s => { void aiLiveReport(s); } }));
  const ctxRef = useRef<LiveCtx>({ places, onShowPlace, onNavigate }); ctxRef.current = { places, onShowPlace, onNavigate };   // relu à chaque appel d'outil
  const stop = useRef<() => void>(() => {}); const end = useRef<HTMLDivElement>(null);
  useEffect(() => { aiStatus().then(setEnabled); if (isLiveSupported()) aiLiveStatus().then(setLiveOn); return () => { stop.current(); toggler.current?.stop(); }; }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: 'smooth' }); }, [msgs]);
  useEffect(() => { if (enabled && consent && hasAiSession()) refreshQuota(); }, [enabled, consent]);
  const push = (m: Msg) => setMsgs(x => [...x, m]); pushRef.current = push;
  const say = (t: string) => { if (aloud) speak(t); };
  const missing = () => push({ who: 'ai', text: 'Ce lieu n’est pas dans la carte téléchargée sur cet appareil : synchronisez (onglet Synchro), puis réessayez.' });

  function apply(r: ChatReply) {
    let text = r.message;
    if (r.action === 'show_place' && r.place && !onShowPlace(r.place)) return missing();
    if (r.action === 'navigate' && r.place) {   // on n'annonce « itinéraire prêt » que si une route a réellement été calculée
      const o = onNavigate(r.place); if (o.status === 'place_unavailable') return missing();
      if (o.status !== 'route_ready') text = `${r.place.name} : ${outcomeMessage(o, r.place.name)}`;
    }
    push({ who: 'ai', text, options: r.action === 'clarify' ? r.options : r.action === 'list' ? r.places : undefined, note: r.degraded ? 'Mode simplifié (IA indisponible).' : undefined });
    say(text);
  }
  function local(q: string, note = 'Hors ligne : recherche locale.') {      // sans réseau ni IA : recherche approximative locale (même algorithme que le serveur)
    const hits = rank(q, withParentNames(places), 4);
    if (!hits.length) return push({ who: 'ai', text: 'Je ne trouve pas ce lieu dans les données de MaCité.', note });
    if (hits.length === 1 || hits[0].score - hits[1].score >= 0.15) { if (!onShowPlace(hits[0])) missing(); else push({ who: 'ai', text: `${label(hits[0])}. Je l’affiche sur la carte.`, note }); return; }
    push({ who: 'ai', text: 'Vouliez-vous dire :', options: hits, note });
  }
  async function send(q: string) {
    q = q.trim(); if (!q || busy) return; setText(''); push({ who: 'me', text: q });
    // 1) Désignation sans ambiguïté (« bâtiment D3 ») : réponse locale, aucun appel d'IA, aucun quota consommé.
    const sure = confidentLocalMatch(q, places);
    if (sure && onShowPlace(sure)) { const t = `${label(sure)}. Je l’affiche sur la carte.`; push({ who: 'ai', text: t, note: 'Réponse locale : aucune requête IA utilisée.' }); say(t); return; }
    if (!hasAiSession()) { local(q, 'Mode local : connectez-vous dans Synchro pour activer les réponses IA.'); return; }
    if (!enabled) { local(q, 'IA distante indisponible : recherche locale.'); return; }
    // 2) Quota du jour épuisé : inutile d'envoyer une requête qui sera refusée (429), on bascule directement sur la recherche locale.
    if (quota && quota.remaining <= 0) { push({ who: 'ai', text: 'Quota quotidien de l’assistant atteint : recherche locale uniquement.' }); local(q); return; }
    setBusy(true);
    try { apply(await aiChat(q, position)); refreshQuota(); }
    catch (e) {
      if (e instanceof AiError && e.status !== 503) push({ who: 'ai', text: e.status === 401 ? 'Session expirée : reconnectez-vous (onglet Synchro).' : e.message });  // 422 / 429 : motif affiché
      else local(q);                                                                                                                                              // 503 ou réseau : repli local
      refreshQuota();
    } finally { setBusy(false); }
  }
  function mic() {
    if (listening) return stop.current(); setListening(true);
    stop.current = startListening({ onInterim: setText, onFinal: t => setText(t), onError: m => push({ who: 'ai', text: m }), onEnd: () => setListening(false) });
  }

  function liveToggle() { toggler.current?.toggle(); }   // « Arrêter » marche à toutes les phases ; un double clic arrête la session au lieu d'en ouvrir une seconde
  function revokeLive() { toggler.current?.stop(); revokeLiveConsent(); setLiveConsent(false); }   // retire le consentement vocal ET coupe toute session

  const signedIn = hasAiSession();
  if (enabled === null) return <div className="meta">Chargement…</div>;
  if (signedIn && enabled && !consent) return <div><h2 style={{ fontSize: 18 }}><Sparkles size={16} /> Assistant</h2><ConsentNotice onAccept={() => setConsent(true)} /></div>;
  return (<section aria-label="MaCité Assistant">
    <h2 style={{ fontSize: 18 }}><Sparkles size={16} /> MaCité Assistant</h2>
    {!signedIn && <div className="gps" role="status"><div><b>Assistant MaCité</b><div className="meta">{places.length ? 'Mode visiteur : recherche locale dans les lieux synchronisés.' : 'Téléchargez d’abord la carte dans Synchro pour rechercher des lieux hors ligne.'} Connectez-vous pour activer Gemini texte et la conversation vocale.</div></div><button className="btn" type="button" onClick={onLogin}>Connexion / carte</button></div>}
    {signedIn && !enabled && <div className="meta" role="status">L’IA distante est désactivée ou injoignable. La recherche locale reste disponible.</div>}
    <div style={{ maxHeight: '38vh', overflowY: 'auto' }} aria-live="polite">
      {!msgs.length && <div className="meta">Exemples : « Où se trouve le bâtiment D3 ? », « Où trouver un point d’eau ? », « Comment aller au terrain de foot ? »</div>}
      {msgs.map((m, i) => <div key={i} style={{ margin: '6px 0', textAlign: m.who === 'me' ? 'right' : 'left' }}>
        <div className={m.who === 'me' ? 'badge' : 'meta'} style={{ display: 'inline-block', padding: '6px 10px', maxWidth: '90%' }}>{m.text}</div>
        {m.note && <div className="meta"><small>{m.note}</small></div>}
        {m.options && <div className="row">{m.options.map(o => <button key={o.id} className="btn" style={{ minHeight: 36 }} onClick={() => { if (!onShowPlace(o)) missing(); }}>{label(o)}</button>)}</div>}</div>)}
      <div ref={end} /></div>
    <form className="row" onSubmit={e => { e.preventDefault(); send(text); }}>
      <input className="f" style={{ flex: 1 }} value={text} maxLength={500} onChange={e => setText(e.target.value)} placeholder="Où se trouve le bâtiment D3 ?" aria-label="Votre question" />
      {signedIn && isSttSupported() && <button type="button" className={'btn' + (listening ? ' pri' : '')} onClick={mic} aria-pressed={listening} aria-label={listening ? 'Arrêter la dictée' : 'Dicter'}><Mic size={16} /></button>}
      <button className="btn pri" disabled={busy || !text.trim()} aria-label="Envoyer"><Send size={16} /></button></form>
    {signedIn && liveOn && (liveConsent ? <div className="row"><button type="button" className={'btn' + (live !== 'closed' ? ' pri' : '')} onClick={liveToggle} aria-pressed={live !== 'closed'}>
        {live === 'closed' ? <><AudioLines size={16} /> Conversation vocale</> : <><Square size={16} /> Arrêter</>}</button>
        <span className="meta" aria-live="polite">{live === 'connecting' ? 'Connexion…' : live === 'listening' ? 'Je vous écoute.' : live === 'speaking' ? 'Je réponds…' : ''}</span>
        <button type="button" className="btn" onClick={revokeLive} title="Retirer mon consentement à la conversation vocale">Retirer mon consentement</button></div>
      : <LiveConsentNotice onAccept={() => setLiveConsent(true)} />)}
    {signedIn && quota && <div className="meta" aria-live="polite">Requêtes IA restantes aujourd’hui : {quota.remaining} / {quota.limit}{quota.remaining <= 0 ? ' — recherche locale uniquement.' : ''}</div>}
    <label className="meta"><input type="checkbox" checked={aloud} onChange={e => setAloud(e.target.checked)} /> Lire les réponses à voix haute</label>
  </section>);
}
