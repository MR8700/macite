import { useEffect, useRef, useState } from 'react';
import { Mic, Sparkles } from 'lucide-react';
import { aiStatus, aiSurveyDraft, hasAiConsent, hasAiSession, AiError, type SurveyDraft } from '../lib/aiClient';
import { isSttSupported, parseCommand, startListening, type Command } from '../lib/voice';
import { ConsentNotice } from './AssistantPanel';

/** Décrire un lieu (texte ou voix) → PROPOSITION de fiche à vérifier. Les commandes vocales de la liste fermée sont exécutées par le relevé. */
export function AiDescribe({ onDraft, onCommand }: { onDraft: (d: SurveyDraft) => string; onCommand: (c: Command) => void }) {
  const [enabled, setEnabled] = useState(false); const [consent, setConsent] = useState(hasAiConsent());
  const [text, setText] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false); const [listening, setListening] = useState(false);
  const stop = useRef<() => void>(() => {}); const cmd = useRef(onCommand); cmd.current = onCommand;
  useEffect(() => { aiStatus().then(setEnabled); return () => stop.current(); }, []);
  const ai = enabled && hasAiSession(); const stt = isSttSupported();
  if (!ai && !stt) return null;
  const mic = () => {
    if (listening) return stop.current(); setListening(true); setMsg('');
    stop.current = startListening({ onInterim: setText, onError: setMsg, onEnd: () => setListening(false),
      onFinal: t => { const c = parseCommand(t); if (c) { setText(''); cmd.current(c); } else setText(t); } });
  };
  const propose = async () => {
    setBusy(true); setMsg('');
    try { const r = await aiSurveyDraft(text); setMsg(onDraft(r.draft) + (r.degraded ? ' (assistant indisponible : seule la remarque est remplie)' : '')); setText(''); }
    catch (e) { setMsg(e instanceof AiError ? (e.status === 401 ? 'Session expirée : reconnectez-vous (onglet Synchro).' : e.message) : 'Réseau indisponible : saisissez la fiche à la main.'); }
    finally { setBusy(false); }
  };
  return (<div>
    <h3 style={{ fontSize: 15, marginTop: 10 }}><Sparkles size={14} /> Décrire le lieu</h3>
    <textarea className="f" value={text} maxLength={800} onChange={e => setText(e.target.value)} aria-label="Description du lieu"
      placeholder="Ex. : Chambre 113, étage 1, porte bleue côté est" />
    <div className="row">
      {stt && <button className={'btn' + (listening ? ' pri' : '')} onClick={mic} aria-pressed={listening}><Mic size={16} />{listening ? 'Arrêter' : 'Dicter / commande vocale'}</button>}
      {ai && consent && <button className="btn pri" disabled={busy || !text.trim()} onClick={propose}>{busy ? '…' : 'Proposer une fiche'}</button>}</div>
    {ai && !consent && <ConsentNotice onAccept={() => setConsent(true)} />}
    {stt && <div className="meta">Commandes : « ajouter un point », « annuler le dernier point », « enregistrer comme brouillon ».</div>}
    {msg && <div className="meta" role="status">{msg}</div>}</div>);
}
