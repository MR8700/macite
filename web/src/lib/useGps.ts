import { useCallback, useRef, useState } from 'react';
import type { LngLat } from './geo';
export interface Fix { p: LngLat; acc: number; heading: number | null; t: number }
export type GpsState = 'inactif' | 'acquisition' | 'ok' | 'indisponible' | 'refuse';
export function useGps() {
  const [fix, setFix] = useState<Fix | null>(null); const [state, setState] = useState<GpsState>('inactif'); const w = useRef<number | undefined>(undefined);
  const start = useCallback(() => {
    if (!navigator.geolocation) return setState('indisponible');
    if (w.current != null) return; setState('acquisition');
    w.current = navigator.geolocation.watchPosition(
      g => { setFix({ p: [g.coords.longitude, g.coords.latitude], acc: g.coords.accuracy, heading: g.coords.heading, t: g.timestamp }); setState('ok'); },
      e => {
        if (e.code === 1) { if (w.current != null) navigator.geolocation.clearWatch(w.current); w.current = undefined; setState('refuse'); }   // permission refusée : la veille est morte, on la libère pour pouvoir réessayer (avant : « Activer » restait sans effet)
        else setState('indisponible');   // signal perdu / délai : la veille continue seule et repasse à « ok » dès qu'une position arrive
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }, []);
  const stop = useCallback(() => { if (w.current != null) navigator.geolocation.clearWatch(w.current); w.current = undefined; setState('inactif'); }, []);
  return { fix, state, start, stop };
}
