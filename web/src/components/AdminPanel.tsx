import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../lib/api';
interface U { username: string; role: string; active: boolean }
interface V { version: number; by: string; at: number; places: number }
interface A { at: number; who: string; what: string }

export function AdminPanel({ token }: { token: string }) {
  const [users, setUsers] = useState<U[]>([]); const [vers, setVers] = useState<V[]>([]); const [audit, setAudit] = useState<A[]>([]);
  const [msg, setMsg] = useState(''); const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const call = useCallback(async (path: string, method = 'GET', body?: object) => {
    const r = await fetch(API_BASE + '/admin' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(typeof d.detail === 'string' ? d.detail : `Erreur ${r.status}`); }
    return r.json();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const load = useCallback(async () => {
    try { setUsers(await call('/users')); setVers(await call('/map-versions')); setAudit(await call('/audit?limit=30')); setMsg(''); } catch (e) { setMsg((e as Error).message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  const act = async (f: () => Promise<unknown>, ok: string) => { try { await f(); setMsg(ok); await load(); } catch (e) { setMsg((e as Error).message); } };

  return (<div>
    <h2>Administration</h2>
    {msg && <div className="meta" role="status">{msg}</div>}
    <h3 style={{ fontSize: 15, marginTop: 10 }}>Comptes</h3>
    {users.map(u => <div key={u.username} className="gps" style={{ justifyContent: 'space-between' }}>
      <div><b>{u.username}</b> <span className={'badge ' + (u.active ? '' : 'err')}>{u.active ? 'Actif' : 'Désactivé'}</span></div>
      <div className="row" style={{ margin: 0 }}>
        <select className="f" style={{ width: 120 }} aria-label={`Rôle de ${u.username}`} value={u.role} onChange={e => act(() => call('/users/' + u.username, 'PATCH', { role: e.target.value }), 'Rôle modifié.')}>
          {['utilisateur', 'releveur', 'expert', 'admin'].map(r => <option key={r}>{r}</option>)}</select>
        <button className="btn" onClick={() => act(() => call('/users/' + u.username, 'PATCH', { active: !u.active }), u.active ? 'Compte désactivé.' : 'Compte réactivé.')}>{u.active ? 'Désactiver' : 'Réactiver'}</button></div></div>)}
    <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget;
      act(async () => { await call('/users', 'POST', { username: f.get('u'), password: f.get('p'), role: f.get('r') }); form.reset(); }, 'Compte créé.'); }}>
      <div className="row"><input className="f" style={{ flex: 1 }} name="u" placeholder="Identifiant" aria-label="Nouvel identifiant" required />
        <input className="f" style={{ flex: 1 }} name="p" type="password" placeholder="Mot de passe (10 car. min.)" aria-label="Mot de passe du nouveau compte" minLength={10} required />
        <select className="f" style={{ width: 120 }} name="r" aria-label="Rôle du nouveau compte"><option>utilisateur</option><option>releveur</option><option>expert</option><option>admin</option></select>
        <button className="btn pri">Créer le compte</button></div></form>
    <h3 style={{ fontSize: 15, marginTop: 10 }}>Versions de la carte</h3>
    {!vers.length && <div className="meta">Aucune version publiée.</div>}
    {vers.map((v, i) => <div key={v.version} className="gps" style={{ justifyContent: 'space-between' }}>
      <div><b>v{v.version}</b>{i === 0 && <> <span className="badge">Courante</span></>}<div className="meta">{v.places} lieu(x) · {v.by} · {new Date(v.at * 1000).toLocaleString('fr-FR')}</div></div>
      {i > 0 && <button className="btn" onClick={() => { if (confirm(`Restaurer la v${v.version} ? Une nouvelle version sera créée, l'historique est conservé.`)) act(() => call(`/map-versions/${v.version}/rollback`, 'POST'), `Version v${v.version} restaurée.`); }}>Restaurer</button>}</div>)}
    <h3 style={{ fontSize: 15, marginTop: 10 }}>Journal d’audit</h3>
    {audit.map((a, i) => <div key={i} className="meta">{new Date(a.at * 1000).toLocaleString('fr-FR')} · {a.who} · {a.what}</div>)}
  </div>);
}
