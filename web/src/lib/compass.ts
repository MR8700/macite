import { useCallback, useEffect, useState } from 'react';

export interface Heading { deg: number; reliable: boolean }
interface OrientEvt { alpha: number | null; absolute?: boolean; webkitCompassHeading?: number; webkitCompassAccuracy?: number }

/** Cap du TÉLÉPHONE (0=Nord) depuis un évènement d'orientation. null si non exploitable. */
export function headingFromEvent(e: OrientEvt): Heading | null {
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) { // iOS
    const acc = e.webkitCompassAccuracy;
    return { deg: (e.webkitCompassHeading + 360) % 360, reliable: acc != null && acc >= 0 && acc <= 20 };
  }
  if (e.alpha == null || !Number.isFinite(e.alpha)) return null;
  return { deg: (360 - e.alpha + 360) % 360, reliable: e.absolute === true }; // Android : fiable seulement si absolu (Nord magnétique)
}

export type CompassState = 'inactive' | 'active' | 'refusee' | 'indisponible';
export function useCompass() {
  const [h, setH] = useState<Heading | null>(null); const [state, setState] = useState<CompassState>('inactive');
  const start = useCallback(async () => {
    if (typeof DeviceOrientationEvent === 'undefined') return setState('indisponible');
    const req = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (req) { try { if ((await req()) !== 'granted') return setState('refusee'); } catch { return setState('refusee'); } }
    setState('active');
  }, []);
  useEffect(() => {
    if (state !== 'active') return;
    const on = (e: Event) => { const r = headingFromEvent(e as unknown as OrientEvt); if (r) setH(r); };
    addEventListener('deviceorientationabsolute', on); addEventListener('deviceorientation', on);
    return () => { removeEventListener('deviceorientationabsolute', on); removeEventListener('deviceorientation', on); };
  }, [state]);
  return { heading: h, state, start };
}
