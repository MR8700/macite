import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/api';
export function ReviewPhotos({ id, token }: { id: string; token: string }) {
  const [urls, setUrls] = useState<string[]>([]); const [state, setState] = useState<'chargement' | 'ok' | 'erreur'>('chargement');
  useEffect(() => {
    let dead = false; const made: string[] = []; const h = { Authorization: `Bearer ${token}` };
    (async () => {
      try {
        const ids: string[] = await (await fetch(`${API_BASE}/surveys/${id}/photos`, { headers: h })).json();
        for (const p of ids) { const r = await fetch(`${API_BASE}/surveys/${id}/photos/${p}`, { headers: h }); if (r.ok) made.push(URL.createObjectURL(await r.blob())); }
        if (!dead) { setUrls([...made]); setState('ok'); }
      } catch { if (!dead) setState('erreur'); }
    })();
    return () => { dead = true; made.forEach(URL.revokeObjectURL); };
  }, [id, token]);
  if (state === 'chargement') return <div className="meta">Chargement des photos…</div>;
  if (state === 'erreur') return <div className="err">Photos indisponibles (réseau).</div>;
  if (!urls.length) return <div className="meta">Aucune photo jointe.</div>;
  return <div className="row">{urls.map(u => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="Photo du relevé" style={{ height: 64, borderRadius: 8 }} /></a>)}</div>;
}
