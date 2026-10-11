import { useState } from 'react';
import { Crosshair, Undo2, Redo2, Check, Send, Save, LocateFixed, Trash2 } from 'lucide-react';
import { accuracyLevel, cardinal, pathLength, polygonOrientation, shouldCapture, validateGeometry, type Kind, type LngLat } from '../lib/geo';
import { db, newId, saveDraft, type Survey } from '../lib/db';
import { resizeToJpeg } from '../lib/photo';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Fix, GpsState } from '../lib/useGps';
import { PLACE_TYPES, typesForKind } from '../lib/placeTypes';
import { useCompass } from '../lib/compass';
import { AiDescribe } from './AiDescribe';
import type { SurveyDraft } from '../lib/aiClient';
import { NEEDS_CONFIRMATION, type Command } from '../lib/voice';

export const emptySurvey = (kind: Kind = 'point'): Survey => ({ id: newId(), kind, name: '', placeType: '', notes: '', points: [], accuracies: [], capturedAt: [], orientation: null, status: 'brouillon', version: 1, updatedAt: Date.now(), synced: false });
const KINDS: [Kind, string][] = [['point', 'Point'], ['path', 'Chemin'], ['polygon', 'Contour']];
const LVL = { bonne: ['Précision satisfaisante', ''], moyenne: ['Précision moyenne', 'warn'], faible: ['Précision insuffisante', 'err'], indisponible: ['Précision inconnue', 'warn'] } as const;

interface Props { s: Survey; onChange: (s: Survey) => void; fix: Fix | null; gps: GpsState; startGps: () => void; center: () => LngLat; onDone: () => void }
export function SurveyPanel({ s, onChange, fix, gps, startGps, center, onDone }: Props) {
  const [redo, setRedo] = useState<{ p: LngLat; a: number | null; t: number }[]>([]);
  const [errs, setErrs] = useState<string[]>([]); const [msg, setMsg] = useState('');
  const photos = useLiveQuery(() => db.photos.where('surveyId').equals(s.id).toArray(), [s.id], []);
  const addPhoto = async (f?: File) => { if (!f) return; if (photos.length >= 6) return setMsg('6 photos maximum.'); try { await db.photos.put({ id: newId(), surveyId: s.id, blob: await resizeToJpeg(f), uploaded: false }); } catch { setMsg('Photo illisible.'); } };
  const pt = PLACE_TYPES[s.placeType]; const allPub = useLiveQuery(() => db.published.toArray(), [], []);
  const parents = pt ? allPub.filter(p => pt.parents.includes(p.type ?? '')) : [];
  const lvl = accuracyLevel(fix?.acc); const compass = useCompass();
  const add = (p: LngLat, a: number | null) => {
    if (s.kind === 'point') { onChange({ ...s, points: [p], accuracies: [a], capturedAt: [Date.now()] }); return; }
    const last = s.points.length ? { p: s.points[s.points.length - 1], t: s.capturedAt[s.capturedAt.length - 1] } : null;
    if (a != null && !shouldCapture(last, p, Date.now())) { setMsg('Point ignoré : trop proche du précédent.'); return; }
    setMsg(''); setRedo([]); onChange({ ...s, points: [...s.points, p], accuracies: [...s.accuracies, a], capturedAt: [...s.capturedAt, Date.now()] });
  };
  const undo = () => { if (!s.points.length) return; const i = s.points.length - 1; setRedo([...redo, { p: s.points[i], a: s.accuracies[i], t: s.capturedAt[i] }]); onChange({ ...s, points: s.points.slice(0, i), accuracies: s.accuracies.slice(0, i), capturedAt: s.capturedAt.slice(0, i) }); };
  const redoOp = () => { const r = redo[redo.length - 1]; if (!r) return; setRedo(redo.slice(0, -1)); onChange({ ...s, points: [...s.points, r.p], accuracies: [...s.accuracies, r.a], capturedAt: [...s.capturedAt, r.t] }); };
  const save = async (submit: boolean) => {
    const geo = validateGeometry(s.kind, s.points); const e = [...geo]; if (!s.name.trim()) e.push('Le nom est obligatoire.');
    // Mêmes règles que le serveur : sinon l'erreur n'apparaissait qu'après la synchro, dans la liste des relevés.
    if (pt?.parentRequired && !s.parentId) e.push(`« ${pt.label} » doit avoir un parent.`);
    if (pt?.levelled && s.level == null) e.push('Le niveau d’étage est obligatoire (0 = rez-de-chaussée).');
    if (submit && e.length) { setErrs(e); return; }
    if (!submit && s.points.length && geo.length) setMsg('Brouillon enregistré (géométrie encore incomplète).');
    setErrs([]); await saveDraft({ ...s, status: submit ? 'a_verifier' : 'en_cours' });
    if (submit) onDone(); else setMsg(m => m || 'Brouillon enregistré sur cet appareil.');
  };
  // Proposition de l'assistant : appliquée seulement si valide pour CE type de relevé ; rien n'est soumis sans action de l'utilisateur.
  const applyDraft = (d: SurveyDraft): string => {
    const cat = d.type && typesForKind(s.kind).some(([c]) => c === d.type) ? d.type : s.placeType; const t = PLACE_TYPES[cat];
    const parent = d.parent_id && t && allPub.some(p => p.id === d.parent_id && t.parents.includes(p.type ?? '')) ? d.parent_id : (cat === s.placeType ? s.parentId ?? null : null);
    onChange({ ...s, name: d.name || s.name, placeType: cat, parentId: parent, notes: d.notes ? (s.notes ? s.notes + '\n' : '') + d.notes : s.notes });
    return 'Proposition appliquée : vérifiez le nom, le type et le parent avant de soumettre.';
  };
  const runCommand = (c: Command) => {   // liste fermée ; les actions sensibles demandent confirmation
    if (NEEDS_CONFIRMATION.has(c) && !confirm('Enregistrer le brouillon ?')) return;
    if (c === 'add_point') { if (fix) add(fix.p, fix.acc); else setMsg('Position GPS indisponible : activez le GPS.'); }
    else if (c === 'undo_last') undo();
    else if (c === 'save_draft') save(false);
    else if (c === 'finish_outline') setMsg(s.kind === 'polygon' ? 'Le contour se ferme automatiquement : vérifiez-le puis enregistrez.' : 'Cette commande ne concerne que les contours.');
    else setMsg('Un relevé est déjà en cours.');
  };
  const orient = s.kind === 'polygon' && s.points.length >= 3 ? polygonOrientation(s.points) : null;
  const heading = fix?.heading != null && !Number.isNaN(fix.heading) ? fix.heading : null;
  return (<div className="survey-editor">
    <div className="survey-brand"><div><span className="eyebrow">KOSSODO NAVIGATOR / RELEVE</span><h2>Nouveau relevé</h2></div><span className="online-pill"><i className={gps === 'ok' ? '' : 'offline'} />{gps === 'ok' ? 'GPS actif' : gps === 'acquisition' ? 'Recherche GPS' : 'GPS prêt'}</span></div>
    <div className="survey-metrics"><div><b>{fix ? `± ${fix.acc.toFixed(1)} m` : '—'}</b><small>{fix ? LVL[lvl][0] : 'Précision GPS'}</small></div><div><b>{s.points.length}</b><small>Sommets</small></div><div><b>{s.kind === 'path' ? `${Math.round(pathLength(s.points))} m` : s.kind === 'polygon' && s.points.length >= 3 ? `${s.points.length} pts` : '—'}</b><small>{s.kind === 'path' ? 'Distance' : 'Contour'}</small></div><div><b>{heading != null ? `${Math.round(heading)}°` : '—'}</b><small>Cap GPS</small></div></div>
    <h2 style={{ fontSize: 18 }}>Nouveau relevé</h2>
    <div className="row seg" role="group" aria-label="Type de relevé">{KINDS.map(([k, l]) => <button key={k} className={'btn' + (s.kind === k ? ' on' : '')} onClick={() => onChange({ ...s, kind: k, placeType: '', parentId: null, level: null, points: [], accuracies: [], capturedAt: [] })}>{l}</button>)}</div>
    <input className="f" placeholder="Nom du lieu" value={s.name} onChange={e => onChange({ ...s, name: e.target.value })} aria-label="Nom du lieu" />
    <select className="f" value={s.placeType} onChange={e => onChange({ ...s, placeType: e.target.value, parentId: null, level: null })} aria-label="Type de lieu">
      <option value="">Type de lieu… (par défaut selon la géométrie)</option>{typesForKind(s.kind).map(([c, t]) => <option key={c} value={c}>{t.label}</option>)}</select>
    {pt && pt.parents.length > 0 && <select className="f" value={s.parentId ?? ''} onChange={e => onChange({ ...s, parentId: e.target.value || null })} aria-label="Lieu parent">
      <option value="">{pt.parentRequired ? 'Parent (obligatoire)…' : 'Parent (facultatif)…'}</option>{parents.map(p => <option key={p.id} value={p.id}>{p.name} ({PLACE_TYPES[p.type ?? '']?.label ?? p.type})</option>)}</select>}
    {pt?.parentRequired && !parents.length && <div className="meta">Aucun parent publié disponible : relevez d’abord le parent (ex. bâtiment, étage) et attendez sa publication.</div>}
    {pt?.levelled && <input className="f" type="number" min={-5} max={30} placeholder="Niveau (0 = RDC)" aria-label="Niveau d’étage" value={s.level ?? ''} onChange={e => onChange({ ...s, level: e.target.value === '' ? null : +e.target.value })} />}
    <input className="f" placeholder="Numéro / code (ex. 112)" aria-label="Numéro" value={s.number ?? ''} onChange={e => onChange({ ...s, number: e.target.value })} />
    <div className="gps" aria-live="polite">
      <LocateFixed size={20} color="#3478F6" />
      <div>{gps === 'inactif' && <span>GPS arrêté</span>}{gps === 'acquisition' && <span>Acquisition de la position…</span>}
        {gps === 'refuse' && <span className="badge err">Autorisation refusée — placez les points manuellement</span>}
        {gps === 'indisponible' && <span className="badge err">GPS indisponible — mode manuel</span>}
        {gps === 'ok' && fix && <><b>± {fix.acc.toFixed(1)} m</b> <span className={'badge ' + LVL[lvl][1]}>{LVL[lvl][0]}</span>
          <div className="meta">Précision estimée par l’appareil, non garantie.</div></>}</div>
      {gps === 'inactif' && <button className="btn" onClick={startGps}>Activer</button>}
    </div>
    <div className="row">
      <button className="btn pri" disabled={!fix} onClick={() => fix && add(fix.p, fix.acc)}><Crosshair size={18} />Capturer ma position</button>
      <button className="btn" onClick={() => add(center(), null)}>Poser au centre de la carte</button>
    </div>
    <div className="row"><button className="btn" onClick={undo} disabled={!s.points.length}><Undo2 size={16} />Annuler</button>
      <button className="btn" onClick={redoOp} disabled={!redo.length}><Redo2 size={16} />Refaire</button>
      <button className="btn" onClick={() => onChange({ ...s, points: [], accuracies: [], capturedAt: [] })} disabled={!s.points.length}><Trash2 size={16} />Vider</button></div>
    <div className="meta">{s.points.length} point(s){s.kind === 'polygon' && s.points.length >= 3 ? ' — contour fermé automatiquement' : ''}. Points sans GPS : « position manuelle ».</div>
    <h3 style={{ fontSize: 15, marginTop: 10 }}>Orientation</h3>
    <div className="meta">{heading != null ? `Cap de déplacement GPS : ${heading.toFixed(0)}° (${cardinal(heading)}) — différent de l’orientation du bâtiment.` : 'Orientation non fiable : saisissez-la manuellement.'}</div>
    <div className="row">{compass.state === 'inactive' && <button className="btn" onClick={compass.start}>Activer la boussole</button>}
      {compass.state === 'refusee' && <span className="badge err">Boussole refusée — saisie manuelle</span>}
      {compass.state === 'indisponible' && <span className="badge warn">Boussole indisponible — saisie manuelle</span>}
      {compass.state === 'active' && !compass.heading && <span className="meta">Boussole : en attente de données…</span>}
      {compass.heading && <><span className={'badge ' + (compass.heading.reliable ? '' : 'warn')}>Téléphone : {compass.heading.deg.toFixed(0)}° ({cardinal(compass.heading.deg)}) · {compass.heading.reliable ? 'fiable' : 'Orientation non fiable'}</span>
        <button className="btn" disabled={!compass.heading.reliable} onClick={() => onChange({ ...s, orientation: { deg: compass.heading!.deg, source: 'boussole' } })}>Utiliser la boussole</button></>}</div>
    {compass.heading && <div className="meta">Cap du téléphone, pas orientation du bâtiment : visez le côté du bâtiment avant de l’utiliser. Éloignez-vous des masses métalliques.</div>}
    {orient != null && <div className="meta">Orientation du contour (calculée) : {orient.toFixed(0)}° (axe {cardinal(orient)}/{cardinal(orient + 180)})</div>}
    <div className="row"><input className="f" style={{ width: 110 }} type="number" min={0} max={359} placeholder="Angle °" aria-label="Orientation manuelle en degrés"
      value={s.orientation?.deg ?? ''} onChange={e => onChange({ ...s, orientation: e.target.value === '' ? null : { deg: ((+e.target.value % 360) + 360) % 360, source: 'manuelle' } })} />
      {(['N', 'E', 'S', 'O'] as const).map((c, i) => <button key={c} className="btn" aria-label={'Orienter ' + c} onClick={() => onChange({ ...s, orientation: { deg: i * 90, source: 'manuelle' } })}>{c}</button>)}
      {heading != null && <button className="btn" onClick={() => onChange({ ...s, orientation: { deg: heading, source: 'cap_gps' } })}>Utiliser le cap GPS</button>}</div>
    {s.orientation && <div className="meta">Orientation enregistrée : {s.orientation.deg.toFixed(0)}° ({cardinal(s.orientation.deg)}), source : {s.orientation.source}.</div>}
    <div className="row"><label className="btn">Ajouter une photo<input type="file" accept="image/*" capture="environment" hidden onChange={e => { addPhoto(e.target.files?.[0]); e.target.value = ''; }} /></label>
      {photos.map(p => <button key={p.id} className="btn" aria-label="Supprimer cette photo" onClick={() => db.photos.delete(p.id)}>🖼 ×</button>)}</div>
    <AiDescribe onDraft={applyDraft} onCommand={runCommand} />
    <textarea className="f" placeholder="Notes de terrain" value={s.notes} onChange={e => onChange({ ...s, notes: e.target.value })} aria-label="Notes de terrain" />
    {errs.map(e => <div className="err" role="alert" key={e}>{e}</div>)}{msg && <div className="meta">{msg}</div>}
    <div className="row"><button className="btn" onClick={() => save(false)}><Save size={16} />Enregistrer le brouillon</button>
      <button className="btn pri" onClick={() => save(true)}><Send size={16} />Soumettre à vérification</button></div>
    <div className="meta"><Check size={12} /> Un relevé soumis n’est pas une donnée officielle tant qu’il n’est pas validé puis publié.</div>
  </div>);
}
