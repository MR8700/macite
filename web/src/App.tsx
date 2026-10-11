import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import { Map as MapIcon, PenLine, RefreshCw, ShieldCheck, Settings, Search, WifiOff, Navigation, Building2, Sparkles, Mountain, Box, Compass, Layers } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { MapView, type Feat } from './components/MapView';
import { SurveyPanel, emptySurvey } from './components/SurveyPanel';
import { db, searchPublished, type PublishedPlace, type Survey } from './lib/db';
import { STATUS_LABEL, haversine, pathLength, type LngLat } from './lib/geo';
import type { Route } from './lib/graph';
import { buildNavGraph, tagLabel, type Leg, type NavPlace } from './lib/nav';
import { computeItinerary, outcomeMessage, type NavOutcome } from './lib/itinerary';
import { detailOf, login, pullPublished, pullSurveyStatuses, pushSurveys, reviewApi, SESSION_EXPIRED } from './lib/sync';
import { QrScanner } from './components/QrScanner';
import { PlacesPanel } from './components/PlacesPanel';
import { AdminPanel } from './components/AdminPanel';
import { AssistantPanel } from './components/AssistantPanel';
import type { AiPlace } from './lib/aiClient';
import { ReviewPhotos } from './components/ReviewPhotos';
import { downloadOfflineMap, getOfflineMap, removeOfflineMap } from './lib/offlineMap';
import { useGps } from './lib/useGps';
import { useCompass } from './lib/compass';

type Tab = 'carte' | 'releve' | 'sync' | 'valider' | 'lieux' | 'admin' | 'assistant';
/** Session stockée : une valeur corrompue ne doit pas empêcher l'application de démarrer. */
const readAuth = (): { token: string; role: string } | null => { try { const a = JSON.parse(localStorage.getItem('macite-auth') ?? 'null'); return a && typeof a.token === 'string' && typeof a.role === 'string' ? a : null; } catch { return null; } };
export function App() {
  const [tab, setTab] = useState<Tab>('carte');
  const [online, setOnline] = useState(navigator.onLine);
  const [q, setQ] = useState(''); const [sugg, setSugg] = useState<PublishedPlace[]>([]);
  const [sel, setSel] = useState<PublishedPlace | null>(null); const [focus, setFocus] = useState<LngLat | null>(null);
  const [route, setRoute] = useState<Route | null>(null); const [navMsg, setNavMsg] = useState('');
  const [survey, setSurvey] = useState<Survey>(emptySurvey()); const map = useRef<MLMap | undefined>(undefined);
  const [auth, setAuth] = useState<{ token: string; role: string } | null>(readAuth);
  const [terrain, setTerrain] = useState(true); const [threeD, setThreeD] = useState(false); const [gpsFollow, setGpsFollow] = useState(false);
  const [activeLevel, setActiveLevel] = useState<number | null>(null); const [activeFilter, setActiveFilter] = useState('Tous');
  const gps = useGps();
  const compass = useCompass();
  const published = useLiveQuery(() => db.published.toArray(), [], [] as PublishedPlace[]);
  const offline = useLiveQuery(async () => (await getOfflineMap()) ?? null, [], null);
  const [dl, setDl] = useState<number | null>(null); const [dlMsg, setDlMsg] = useState('');
  const surveys = useLiveQuery(() => db.surveys.orderBy('updatedAt').reverse().toArray(), [], [] as Survey[]);

  useEffect(() => { const u = () => setOnline(navigator.onLine); addEventListener('online', u); addEventListener('offline', u); return () => { removeEventListener('online', u); removeEventListener('offline', u); }; }, []);
  useEffect(() => { let live = true; searchPublished(q).then(r => { if (live) setSugg(r); }); return () => { live = false; }; }, [q, published]);   // une réponse tardive d'une frappe précédente n'écrase pas la dernière
  const [scan, setScan] = useState(false); const [legs, setLegs] = useState<Leg[]>([]); const [shownTag, setShownTag] = useState('all');
  const [accessible, setAccessible] = useState(false); const [startId, setStartId] = useState(''); const [steps, setSteps] = useState<string[]>([]);
  const navPlaces = published as unknown as NavPlace[];
  const graph = useMemo(() => buildNavGraph(navPlaces, { accessibleOnly: accessible }), [navPlaces, accessible]);
  const levelList = [...new Set(published.map(p => p.level).filter((n): n is number => typeof n === 'number'))].sort((a, b) => a - b);
  const filterTypes: Record<string, string[]> = { Tous: [], Bâtiments: ['batiment', 'aile'], Services: ['service', 'infirmerie', 'sanitaires', 'conciergerie'], Chambres: ['chambre', 'salle_etude', 'salle_conference'] };
  const visiblePlaces = activeFilter === 'Tous' ? published : published.filter(p => filterTypes[activeFilter]?.includes(p.type ?? ''));
  const feats: Feat[] = visiblePlaces.map(p => ({ id: p.id, kind: p.kind, name: p.name, points: p.points, type: p.type, level: p.level }));
  const draftFeat: Feat | null = tab === 'releve' ? { id: survey.id, kind: survey.kind, name: survey.name, points: survey.points } : null;

  // Déplacement (position manuelle → précision inconnue) ou suppression d'un sommet.
  const editPoint = (i: number, p: LngLat | null) => setSurvey(s => p
    ? { ...s, points: s.points.map((x, k) => (k === i ? p : x)), accuracies: s.accuracies.map((a, k) => (k === i ? null : a)) }
    : { ...s, points: s.points.filter((_, k) => k !== i), accuracies: s.accuracies.filter((_, k) => k !== i), capturedAt: s.capturedAt.filter((_, k) => k !== i) });
  const goTo = (p: PublishedPlace) => {
    setSel(p); setQ(''); setSugg([]); setRoute(null); setNavMsg('');
    setFocus(p.points[0]);
  };
  // Résultat d'itinéraire TYPÉ (lib/itinerary.ts) : l'écran et l'assistant vocal affichent/annoncent ce qui s'est réellement passé.
  const applyOutcome = (o: NavOutcome, name: string) => {
    if (o.status === 'route_ready') { setRoute(o.plan.route); setSteps(o.plan.steps); setLegs(o.plan.legs); setShownTag('all'); setNavMsg(''); return; }
    setRoute(null); setLegs([]); setSteps([]); setNavMsg(outcomeMessage(o, name));
  };
  const compute = (dest: PublishedPlace): NavOutcome => {
    if (!startId && !gps.fix) gps.start();
    return computeItinerary({ graph, places: navPlaces, dest: dest as unknown as NavPlace, startId, gpsFix: gps.fix, accessible });
  };
  const itinerary = () => { if (sel) applyOutcome(compute(sel), sel.name); };
  // Assistant : les lieux proposés sont retrouvés dans la carte LOCALE (jamais de coordonnées venues de l'IA).
  const aiShow = (p: AiPlace) => { const pl = published.find(x => x.id === p.id); if (!pl) return false; goTo(pl); setTab('carte'); return true; };
  const aiNavigate = (p: AiPlace): NavOutcome => {
    const pl = published.find(x => x.id === p.id); if (!pl) return { status: 'place_unavailable' };
    goTo(pl); setTab('carte'); const o = compute(pl); applyOutcome(o, pl.name); return o;
  };
  const doLogin = async (f: FormData) => {
    try { const a = await login(String(f.get('u')), String(f.get('p'))); setAuth(a); localStorage.setItem('macite-auth', JSON.stringify(a)); } catch (e) { alert((e as Error).message); }
  };
  const [status, setStatus] = useState(''); const [reviewMsg, setReviewMsg] = useState('');   // deux messages distincts : celui de « Synchro » ne doit pas apparaître dans « Valider »
  const expire = () => { setAuth(null); localStorage.removeItem('macite-auth'); };
  const failMsg = (e: unknown) => { const m = (e as Error).message; if (m === SESSION_EXPIRED) expire(); return m; };
  const sync = async () => {
    if (!auth) return setStatus('Connectez-vous pour synchroniser.');
    try {
      const r = await pushSurveys(auth.token); const m = await pullPublished(); const n = await pullSurveyStatuses(auth.token);
      setStatus(`Envoyés : ${r.pushed} · conflits : ${r.conflicts} · erreurs : ${r.errors}${r.photoErrors ? ` · photos non envoyées : ${r.photoErrors}` : ''} · statuts mis à jour : ${n} · carte v${m.version} (${m.count} lieux) téléchargée.`);
    } catch (e) { const m = failMsg(e); setStatus(m === SESSION_EXPIRED ? m : 'Échec de synchronisation : ' + m); }
  };
  const [queue, setQueue] = useState<Survey[]>([]);
  const loadQueue = async () => { if (!auth) return; try { setQueue(await reviewApi.list(auth.token)); } catch (e) { setReviewMsg(failMsg(e)); } };
  const publishVersion = async () => {
    if (!auth) return;
    try {
      const r = await reviewApi.publish(auth.token);
      if (r.status === 401) throw new Error(SESSION_EXPIRED);
      if (!r.ok) { setReviewMsg('Publication refusée : ' + await detailOf(r, 'droits insuffisants')); return; }
      const j = await r.json(); setReviewMsg(`Version v${j.version} publiée (${j.places} lieux).` + (j.warnings?.length ? ' ⚠ ' + j.warnings.join(' ') : ''));
    } catch (e) { setReviewMsg(failMsg(e)); }
  };
  const approve = async (s: Survey) => {
    if (!auth) return;
    try {
      let r = await reviewApi.act(auth.token, s.id, 'approve'); let detail = '';
      if (r.status === 422) {   // contrôle qualité : dérogation possible, tracée, avec motif obligatoire
        detail = await detailOf(r, 'Refusé');
        if (confirm(detail + '\n\nValider quand même (dérogation tracée) ?')) { const reason = prompt('Motif de la dérogation (obligatoire) :'); if (reason?.trim()) r = await reviewApi.act(auth.token, s.id, 'approve', reason.trim(), true); }
      } else if (!r.ok && r.status !== 401) detail = await detailOf(r);
      if (r.status === 401) throw new Error(SESSION_EXPIRED);
      setReviewMsg(r.ok ? 'Relevé validé : visible des utilisateurs après la prochaine publication.' : 'Validation refusée : ' + (detail || 'erreur'));
    } catch (e) { setReviewMsg(failMsg(e)); }
    loadQueue();
  };
  const rejectSurvey = async (s: Survey) => {
    if (!auth) return; const reason = prompt('Motif du rejet ?'); if (!reason?.trim()) return;
    try {
      const r = await reviewApi.act(auth.token, s.id, 'reject', reason.trim());
      if (r.status === 401) throw new Error(SESSION_EXPIRED);
      setReviewMsg(r.ok ? 'Relevé renvoyé pour correction.' : 'Rejet refusé : ' + await detailOf(r));   // avant : l'échec était silencieux
    } catch (e) { setReviewMsg(failMsg(e)); }
    loadQueue();
  };
  const canReview = auth && ['expert', 'admin'].includes(auth.role);

  return (<div className="app">
    <MapView published={feats} draft={draftFeat} route={route ? legs.map(l => ({ coords: l.coords, on: shownTag === 'all' || l.tag === shownTag })) : null} user={gps.fix?.p ?? null} heading={gps.fix?.heading ?? (compass.heading?.reliable ? compass.heading.deg : null)} followGps={gpsFollow} terrain={terrain} threeD={threeD} level={activeLevel} focus={focus} hasLocal={!!offline} onEditPoint={tab === 'releve' ? editPoint : undefined} onSelect={id => { const place = published.find(p => p.id === id); if (place) goTo(place); }} onReady={m => (map.current = m)} />
    {tab === 'releve' && <div className="cross" aria-hidden />}
    <div className="top">
      <img className="logo" src="/icon.svg" alt="MaCité" />
      <label className="search"><Search size={18} color="#6B7785" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Bâtiment, chambre, service, terrain…" aria-label="Rechercher un lieu" /></label>
      {!online && <span className="badge warn"><WifiOff size={14} />Hors ligne</span>}
    </div>
    {tab === 'carte' && <div className="map-filters" role="group" aria-label="Filtrer les lieux de la carte">{Object.keys(filterTypes).map(f => <button key={f} className={activeFilter === f ? 'selected' : ''} onClick={() => setActiveFilter(f)}>{f}</button>)}</div>}
    {tab === 'carte' && <div className="map-direction" aria-live="polite"><Compass size={14} />{gps.fix?.heading != null ? `Cap GPS ${Math.round(gps.fix.heading)}°` : compass.heading?.reliable ? `Cap téléphone ${Math.round(compass.heading.deg)}°` : gpsFollow ? 'Orientation en attente' : 'Nord en haut'}{threeD && <span> · volumes indicatifs</span>}</div>}
    {q && <div className="sugg" role="listbox">{sugg.length ? sugg.map(p => <button key={p.id} onClick={() => goTo(p)}><Building2 size={18} /><span><b>{p.name}</b><div className="meta">{p.type_label}</div></span></button>)
      : <div style={{ padding: 12 }} className="meta">{published.length ? 'Aucun résultat.' : 'Aucune donnée publiée sur cet appareil. Allez dans « Synchro » pour télécharger la carte.'}</div>}</div>}
    <div className="fab map-tools" style={{ top: 124 }}>
      <button className={'ic' + (gpsFollow ? ' active' : '')} aria-label={gpsFollow ? 'Arrêter le suivi GPS' : 'Activer la vision GPS'} title="Vision GPS" onClick={() => { const next = !gpsFollow; setGpsFollow(next); if (next) { gps.start(); compass.start(); if (gps.fix) setFocus([...gps.fix.p]); } }}><Navigation size={20} /></button>
      <button className={'ic' + (terrain ? ' active' : '')} aria-label="Activer ou désactiver le relief" title="Relief" onClick={() => setTerrain(v => !v)}><Mountain size={20} /></button>
      <button className={'ic' + (threeD ? ' active' : '')} aria-label="Activer ou désactiver la vue 3D" title="Vue 3D" onClick={() => { setThreeD(v => !v); setTerrain(true); }}><Box size={20} /></button>
    </div>
    {tab === 'carte' && levelList.length > 0 && <div className="floor-tools" role="group" aria-label="Niveau intérieur">
      <button className={activeLevel == null ? 'selected' : ''} onClick={() => setActiveLevel(null)} aria-pressed={activeLevel == null}><Layers size={14} />Tout</button>
      {levelList.map(n => <button key={n} className={activeLevel === n ? 'selected' : ''} onClick={() => setActiveLevel(n)} aria-pressed={activeLevel === n}>{n < 0 ? `SS${Math.abs(n)}` : n === 0 ? 'RDC' : `R+${n}`}</button>)}
    </div>}

    {tab === 'carte' && sel && <div className="sheet"><h2>{sel.name}</h2><div className="meta">{sel.type_label} · <span className="badge">Publié v{sel.mapVersion}</span></div>
      {sel.points[0] && <div className="meta">{sel.points[0][1].toFixed(6)}, {sel.points[0][0].toFixed(6)}</div>}
      {(sel.parent_name || sel.level != null || sel.number) && <div className="place-context">{sel.parent_name && <span>{sel.parent_name}</span>}{sel.level != null && <span>{sel.level < 0 ? `Sous-sol ${Math.abs(sel.level)}` : sel.level === 0 ? 'Rez-de-chaussée' : `Étage R+${sel.level}`}</span>}{sel.number && <span>Code {sel.number}</span>}</div>}
      <div className="row"><button className="btn pri" onClick={itinerary}><Navigation size={18} />Y aller</button><button className="btn" onClick={() => { setSel(null); setRoute(null); }}>Fermer</button></div>
      <div className="row"><select className="f" style={{ flex: 1 }} aria-label="Point de départ" value={startId} onChange={e => setStartId(e.target.value)}>
        <option value="">Départ : ma position GPS (extérieur)</option>{[...published].filter(x => x.id !== sel.id).sort((a, b) => a.name.localeCompare(b.name)).map(x => <option key={x.id} value={x.id}>Départ : {x.name}</option>)}</select>
        <label className="meta"><input type="checkbox" checked={accessible} onChange={e => setAccessible(e.target.checked)} /> Sans escalier</label></div>
      <div className="row"><button className="btn" onClick={() => setScan(true)}>Scanner un QR de départ</button></div>
      {scan && <QrScanner onClose={() => setScan(false)} onPlace={id => { const pl = published.find(x => x.id === id); setScan(false);
        if (!pl) { setNavMsg('Ce QR n’est pas dans la carte téléchargée : synchronisez, puis réessayez.'); return; } setStartId(id); setNavMsg(''); setSteps([]); setRoute(null); setFocus(pl.points[0]); }} />}
      {startId && <div className="meta">Départ recalé sur « {published.find(x => x.id === startId)?.name ?? startId} » (position connue, indépendante du GPS).</div>}
      {legs.length > 1 && <div className="row" role="group" aria-label="Niveau affiché sur la carte">{['all', ...Array.from(new Set(legs.map(l => l.tag)))].map(t =>
        <button key={t} className={'btn' + (shownTag === t ? ' pri' : '')} style={{ minHeight: 36 }} aria-pressed={shownTag === t}
          onClick={() => { setShownTag(t); const l = legs.find(x => x.tag === t); if (l) setFocus(l.coords[0]); }}>{t === 'all' ? 'Tout' : tagLabel(t)}</button>)}</div>}
      {steps.length > 0 && <><div className="nav-guidance"><span>PROCHAINE ÉTAPE</span><b>{steps[0]}</b><small>Guidage basé sur les cheminements publiés du campus.</small></div><details className="meta"><summary>Voir toutes les étapes ({steps.length})</summary><ol style={{ paddingLeft: 18 }}>{steps.map((t, i) => <li key={i}>{t}</li>)}</ol></details></>}
      {route && <div><b>{Math.round(route.distance)} m</b> · environ {Math.max(1, Math.round(route.seconds / 60))} min à pied <span className="meta">(estimation, vitesse de marche supposée)</span></div>}
      {navMsg && <div className="err" role="alert">{navMsg}</div>}
      {canReview && graph.warnings.length > 0 && <details className="meta"><summary>⚠ {graph.warnings.length} élément(s) non relié(s) au réseau : des itinéraires peuvent manquer</summary>
        <ul style={{ paddingLeft: 18 }}>{graph.warnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}</div>}
    {tab === 'carte' && !sel && !published.length && <div className="sheet campus-empty"><div className="campus-title"><div><span className="eyebrow">KOSSODO NAVIGATEUR</span><h2>Bienvenue sur MaCité</h2></div><span className="online-pill"><i className={online ? '' : 'offline'} />{online ? 'En ligne' : 'Hors ligne'}</span></div><div className="meta">Ma cité, je m’y retrouve. Aucune carte publiée n’est encore enregistrée sur cet appareil.</div><div className="row"><button className="btn pri" onClick={() => setTab('releve')}><PenLine size={16} />Faire un relevé</button><button className="btn" onClick={() => setTab('sync')}><RefreshCw size={16} />Synchroniser la carte</button></div><div className="map-attribution-note">Relief : Mapzen / AWS Open Data. Carte : OpenStreetMap.</div></div>}
    {tab === 'carte' && !sel && published.length > 0 && <div className="sheet campus-home"><div className="campus-title"><div><span className="eyebrow">KOSSODO CAMPUS</span><h2>Explorer le campus</h2></div><span className="online-pill"><i className={gps.fix ? '' : 'offline'} />{gps.fix ? `GPS ±${Math.round(gps.fix.acc)} m` : 'GPS prêt'}</span></div><div className="campus-stats"><div><b>{published.length}</b><span>lieux connus</span></div><div><b>{published.filter(p => ['batiment', 'aile'].includes(p.type ?? '')).length}</b><span>bâtiments</span></div><div><b>{published.filter(p => ['service', 'infirmerie', 'sanitaires'].includes(p.type ?? '')).length}</b><span>services</span></div></div><div className="home-places">{published.slice(0, 3).map(p => <button key={p.id} onClick={() => goTo(p)}><span className="place-symbol"><Building2 size={17} /></span><span><b>{p.name}</b><small>{p.type_label}{p.parent_name ? ` · ${p.parent_name}` : ''}</small></span><Navigation size={16} /></button>)}</div><div className="map-attribution-note">Terrain Mapzen / AWS Open Data · Carte OpenStreetMap</div></div>}
    {tab === 'releve' && <div className="sheet survey-sheet"><SurveyPanel s={survey} onChange={setSurvey} fix={gps.fix} gps={gps.state} startGps={gps.start}
      center={() => { const c = map.current!.getCenter(); return [c.lng, c.lat]; }} onDone={() => { setSurvey(emptySurvey()); setTab('sync'); }} /></div>}
    {tab === 'sync' && <div className="sheet"><div className="campus-title"><h2>Synchronisation</h2><span className="online-pill"><i className={online ? '' : 'offline'} />{online ? 'En ligne' : 'Hors ligne'}</span></div>
      <div className="meta">{online ? 'Connecté' : 'Hors ligne : les relevés restent sur l’appareil.'}</div>
      {!auth ? <form onSubmit={e => { e.preventDefault(); doLogin(new FormData(e.currentTarget)); }}><input className="f" name="u" placeholder="Identifiant" aria-label="Identifiant" /><input className="f" name="p" type="password" placeholder="Mot de passe" aria-label="Mot de passe" /><button className="btn pri">Se connecter</button></form>
        : <div className="row"><span className="badge">Rôle : {auth.role}</span><button className="btn pri" onClick={sync} disabled={!online}><RefreshCw size={16} />Synchroniser</button><button className="btn" onClick={expire}>Déconnexion</button></div>}
      {status && <div className="meta" aria-live="polite">{status}</div>}
      <h3 style={{ fontSize: 15, marginTop: 10 }}>Fond de carte hors ligne</h3>
      <div className="meta">{offline ? `Téléchargé : ${(offline.size / 1048576).toFixed(1)} Mo, le ${new Date(offline.savedAt).toLocaleDateString('fr-FR')}. Utilisé quand le réseau manque.` : 'Non téléchargé : sans réseau, seules les données déjà synchronisées s’affichent, sans fond de carte.'}</div>
      <div className="row"><button className="btn" disabled={!online || dl !== null} onClick={async () => { setDl(0); setDlMsg(''); try { await downloadOfflineMap(setDl); } catch (e) { setDlMsg((e as Error).message); } setDl(null); }}>{dl !== null ? `Téléchargement ${Math.round(dl * 100)} %` : offline ? 'Mettre à jour' : 'Télécharger la carte'}</button>
        {offline && <button className="btn" onClick={() => removeOfflineMap()}>Supprimer</button>}</div>
      {dl !== null && <progress value={dl} max={1} style={{ width: '100%' }} />}{dlMsg && <div className="err" role="alert">{dlMsg}</div>}
      <h3 style={{ fontSize: 15, marginTop: 10 }}>Mes relevés ({surveys.length})</h3>
      {surveys.map(s => <div key={s.id} className="gps" style={{ justifyContent: 'space-between' }}>
        <div><b>{s.name || '(sans nom)'}</b><div className="meta">{s.kind} · {s.points.length} pt · {s.kind === 'path' ? Math.round(pathLength(s.points)) + ' m' : ''}</div>
          {s.status === 'a_corriger' && <div className="err" role="alert">Renvoyé pour correction{s.rejectReason ? ' : ' + s.rejectReason : ''}</div>}
          {s.syncError && <div className="err">{s.syncError}</div>}</div>
        <div><span className={'badge ' + (s.status === 'a_corriger' ? 'warn' : '')}>{STATUS_LABEL[s.status]}</span><div className="meta">{s.synced ? 'Synchronisé' : 'Local seul'}</div>
          {['brouillon', 'en_cours', 'a_corriger'].includes(s.status) && <button className="btn" style={{ minHeight: 36 }} onClick={() => { setSurvey(s); setTab('releve'); }}>Reprendre</button>}</div></div>)}
      {!surveys.length && <div className="meta">Aucun relevé pour l’instant.</div>}</div>}
    {tab === 'valider' && canReview && <div className="sheet"><h2>Relevés à vérifier</h2>
      <div className="row"><button className="btn" onClick={loadQueue}>Actualiser</button>
        <button className="btn pri" onClick={publishVersion}>Publier une version</button></div>
      {reviewMsg && <div className="meta" role="status">{reviewMsg}</div>}
      {!queue.length && <div className="meta">Aucun relevé en attente de vérification.</div>}
      {queue.map(s => <div key={s.id} className="gps" style={{ justifyContent: 'space-between' }}><div><b>{s.name}</b><div className="meta">{s.kind} · {s.points.length} pt · {(() => { const a = s.accuracies.filter((x): x is number => x != null); return a.length ? `précision du pire point ± ${Math.max(...a).toFixed(0)} m` : 'précision inconnue (points posés à la main)'; })()}</div>
        {s.points.length > 1 && <div className="meta">{Math.round(haversine(s.points[0], s.points[s.points.length - 1]))} m entre 1er et dernier point</div>}
        <ReviewPhotos id={s.id} token={auth!.token} /></div>
        <div className="row"><button className="btn pri" onClick={() => approve(s)}>Valider</button>
          <button className="btn" onClick={() => rejectSurvey(s)}>Corriger</button></div></div>)}</div>}

    {tab === 'lieux' && canReview && <div className="sheet"><PlacesPanel token={auth!.token} role={auth!.role} onFocus={p => { setFocus([...p]); setTab('carte'); }} /></div>}
    {tab === 'assistant' && auth && <div className="sheet"><AssistantPanel places={published} position={gps.fix ? { lat: gps.fix.p[1], lon: gps.fix.p[0] } : undefined} onShowPlace={aiShow} onNavigate={aiNavigate} /></div>}
    {tab === 'admin' && auth?.role === 'admin' && <div className="sheet"><AdminPanel token={auth.token} /></div>}
    <nav className="nav" aria-label="Navigation principale">
      {([['carte', MapIcon, 'Carte'], ['releve', PenLine, 'Relevé'], ['sync', RefreshCw, 'Synchro'], ...(canReview ? [['valider', ShieldCheck, 'Valider'], ['lieux', Building2, 'Lieux']] : []), ...(auth ? [['assistant', Sparkles, 'Assistant']] : []), ...(auth?.role === 'admin' ? [['admin', Settings, 'Admin']] : [])] as [Tab, typeof MapIcon, string][]).map(([t, I, l]) =>
        <button key={t} className={tab === t ? 'on' : ''} onClick={() => { setTab(t); if (t === 'valider') loadQueue(); }} aria-current={tab === t}><I size={22} />{l}</button>)}
    </nav>
  </div>);
}
