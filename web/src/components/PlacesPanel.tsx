import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { PLACE_TYPES } from '../lib/placeTypes';
import type { LngLat } from '../lib/geo';
import { qrDataUrl } from '../lib/qr';
import { API_BASE } from '../lib/api';

interface Pl { id: string; type: string; name: string; number?: string | null; kind: string; points: LngLat[]; parent_id: string | null; level: number | null; pos_source?: string; acc_m?: number | null; version: number; state?: string }
interface Comp { building: string; levels: number[]; counts: Record<string, number>; optional_rooms: Record<string, 'present' | 'absent_declare' | 'inconnu'>; issues: string[]; complete: boolean }
const MAX_OK_ACC = 15;

export function PlacesPanel({ token, role, onFocus }: { token: string; role: string; onFocus: (p: LngLat) => void }) {
  const [items, setItems] = useState<Pl[]>([]); const [open, setOpen] = useState<Set<string>>(new Set()); const [q, setQ] = useState('');
  const [qr, setQr] = useState<{ id: string; url: string } | null>(null); const [msg, setMsg] = useState(''); const [comp, setComp] = useState<{ id: string; c: Comp } | null>(null); const [busy, setBusy] = useState(false);
  const h = useMemo(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }), [token]);
  const api = useCallback(async (path: string, method = 'GET', body?: object) => {
    const r = await fetch(API_BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(typeof d.detail === 'string' ? d.detail : `Erreur ${r.status}`); }
    return r.json();
  }, [h]);
  const load = useCallback(async () => {
    setBusy(true);
    try { const all: Pl[] = []; for (let off = 0; off < 2000; off += 200) { const page: Pl[] = await api(`/places?limit=200&offset=${off}`); all.push(...page); if (page.length < 200) break; } setItems(all); setMsg(''); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const kids = useMemo(() => { const m = new Map<string | null, Pl[]>(); for (const p of items) (m.get(p.parent_id) ?? m.set(p.parent_id, []).get(p.parent_id)!).push(p); return m; }, [items]);
  const ids = useMemo(() => new Set(items.map(p => p.id)), [items]);
  const match = (p: Pl) => !q.trim() || p.name.toLowerCase().includes(q.toLowerCase()) || (p.number ?? '').toLowerCase().includes(q.toLowerCase());
  const act = async (f: () => Promise<unknown>, ok: string) => { try { await f(); setMsg(ok); await load(); } catch (e) { setMsg((e as Error).message); } };
  const showComp = async (id: string) => { try { setComp({ id, c: await api(`/places/${id}/completeness`) }); } catch (e) { setMsg((e as Error).message); } };

  const row = (p: Pl, depth: number): ReactElement => {
    const ch = (kids.get(p.id) ?? []); const isOpen = open.has(p.id) || !!q.trim();
    const weak = p.pos_source !== 'gps' || (p.acc_m ?? 0) > MAX_OK_ACC;
    return (<div key={p.id}>
      <div className="gps" style={{ marginLeft: depth * 14, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          {ch.length > 0 && <button className="btn" style={{ minHeight: 32, padding: '0 8px', marginRight: 6 }} aria-label={isOpen ? 'Replier' : 'Déplier'} aria-expanded={isOpen}
            onClick={() => setOpen(s => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>{isOpen ? '▾' : '▸'} {ch.length}</button>}
          <b>{p.name}</b>{p.number ? ` · ${p.number}` : ''}
          <div className="meta">{PLACE_TYPES[p.type]?.label ?? p.type}{p.level != null ? ` · niveau ${p.level}` : ''} · v{p.version}</div>
          <span className={'badge ' + (weak ? 'warn' : '')}>{p.pos_source === 'gps' ? `GPS ± ${p.acc_m ?? '?'} m` : p.pos_source === 'estimee' ? 'Position estimée' : 'Position pointée sur la carte'}</span>
        </div>
        <div className="row" style={{ margin: 0 }}>
          <button className="btn" style={{ minHeight: 36 }} onClick={() => p.points[0] && onFocus(p.points[0])}>Voir</button>
          {p.type === 'qr' && <button className="btn" style={{ minHeight: 36 }} onClick={async () => setQr({ id: p.id, url: await qrDataUrl(p.id) })}>QR à imprimer</button>}
          {p.type === 'batiment' && <button className="btn" style={{ minHeight: 36 }} onClick={() => showComp(p.id)}>Complétude</button>}
          <button className="btn" style={{ minHeight: 36 }} onClick={() => { const n = prompt('Nouveau nom :', p.name); if (n?.trim() && n !== p.name) act(() => api('/places/' + p.id, 'PATCH', { name: n.trim() }), 'Nom modifié (à republier).'); }}>Renommer</button>
          {role === 'admin' && <button className="btn" style={{ minHeight: 36 }} onClick={() => { if (confirm(`Archiver « ${p.name} » ? Il disparaîtra de la prochaine version publiée (historique conservé).`)) act(() => api('/places/' + p.id, 'DELETE'), 'Lieu archivé (à republier).'); }}>Archiver</button>}
        </div></div>
      {qr?.id === p.id && <div className="gps" style={{ display: 'block', marginLeft: depth * 14 }}><img src={qr.url} alt={`QR de ${p.name}`} style={{ width: 160, height: 160 }} />
        <div className="meta">À coller à l’emplacement EXACT relevé ({p.name}{p.level != null ? `, niveau ${p.level}` : ''}). Si vous le déplacez, mettez à jour la position du lieu.</div>
        <a className="btn" href={qr.url} download={`qr-${p.id}.png`}>Télécharger</a> <button className="btn" onClick={() => setQr(null)}>Fermer</button></div>}
      {comp?.id === p.id && <CompBox c={comp.c} onClose={() => setComp(null)} onToggle={(t, absent) => act(async () => { await api(`/places/${p.id}/declare-absent`, 'POST', { type: t, absent }); await showComp(p.id); }, absent ? 'Déclaré « n’existe pas ».' : 'Déclaration retirée.')} />}
      {isOpen && ch.filter(c => match(c) || (kids.get(c.id) ?? []).length).map(c => row(c, depth + 1))}
    </div>);
  };
  const roots = items.filter(p => !p.parent_id || !ids.has(p.parent_id));
  return (<div>
    <h2>Lieux</h2>
    <div className="row"><input className="f" style={{ flex: 1 }} placeholder="Rechercher (nom, numéro)…" aria-label="Rechercher un lieu" value={q} onChange={e => setQ(e.target.value)} />
      <button className="btn" onClick={load} disabled={busy}>{busy ? 'Chargement…' : 'Actualiser'}</button></div>
    {msg && <div className="meta" role="status">{msg}</div>}
    <div className="meta">{items.length} lieu(x). Un lieu modifié ou archivé n’est visible des utilisateurs qu’après une nouvelle publication.</div>
    {!items.length && !busy && <div className="meta">Aucun lieu. Ils apparaissent après validation des relevés.</div>}
    {roots.filter(r => !q.trim() || match(r) || (kids.get(r.id) ?? []).length).map(r => row(r, 0))}
  </div>);
}

function CompBox({ c, onClose, onToggle }: { c: Comp; onClose: () => void; onToggle: (t: string, absent: boolean) => void }) {
  return (<div className="gps" style={{ display: 'block' }} role="region" aria-label={`Complétude de ${c.building}`}>
    <b>{c.building}</b> <span className={'badge ' + (c.complete ? '' : 'warn')}>{c.complete ? 'Complet' : `${c.issues.length} point(s) à traiter`}</span>
    <div className="meta">Niveaux : {c.levels.length ? c.levels.join(', ') : 'aucun'} · {Object.entries(c.counts).map(([k, v]) => `${PLACE_TYPES[k]?.label ?? k} : ${v}`).join(' · ')}</div>
    {c.issues.map((i, k) => <div key={k} className="err" style={{ color: 'var(--warn)' }}>⚠ {i}</div>)}
    <h3 style={{ fontSize: 14, marginTop: 8 }}>Pièces facultatives</h3>
    <div className="row">{Object.entries(c.optional_rooms).map(([t, st]) => <span key={t} className={'badge ' + (st === 'inconnu' ? 'warn' : '')}>
      {PLACE_TYPES[t]?.label ?? t} : {st === 'present' ? 'présent(e)' : st === 'absent_declare' ? 'n’existe pas' : 'non renseigné'}
      {st === 'inconnu' && <button className="btn" style={{ minHeight: 28, padding: '0 8px', marginLeft: 6 }} onClick={() => onToggle(t, true)}>N’existe pas</button>}
      {st === 'absent_declare' && <button className="btn" style={{ minHeight: 28, padding: '0 8px', marginLeft: 6 }} onClick={() => onToggle(t, false)}>Annuler</button>}</span>)}</div>
    <button className="btn" onClick={onClose}>Fermer</button></div>);
}
