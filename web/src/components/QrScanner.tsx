import { useEffect, useRef, useState } from 'react';
import { parseQr } from '../lib/qr';

interface Detector { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> }
declare global { interface Window { BarcodeDetector?: new (o: { formats: string[] }) => Detector } }

/** Scanne un QR MaCité avec la caméra (BarcodeDetector). Sans support : saisie manuelle du contenu. */
export function QrScanner({ onPlace, onClose }: { onPlace: (id: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const [err, setErr] = useState(''); const [manual, setManual] = useState('');
  const supported = !!window.BarcodeDetector && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => {
    if (!supported) return; let stop = false; let stream: MediaStream | undefined; let timer: number | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); if (stop) return stream.getTracks().forEach(t => t.stop());
        video.current!.srcObject = stream; await video.current!.play(); const det = new window.BarcodeDetector!({ formats: ['qr_code'] });
        const tick = async () => { try { for (const c of await det.detect(video.current!)) { const id = parseQr(c.rawValue); if (id) { onPlace(id); return; } } } catch { /* image pas prête */ } if (!stop) timer = window.setTimeout(tick, 300); };
        tick();
      } catch { setErr('Caméra indisponible ou refusée : saisissez le code à la main.'); }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);
  return (<div className="gps" style={{ display: 'block' }} role="dialog" aria-label="Scanner un QR">
    {supported && !err && <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12, maxHeight: 220, objectFit: 'cover' }} />}
    {(!supported || err) && <div className="meta">{err || 'Scan caméra non pris en charge par ce navigateur.'}</div>}
    <div className="row"><input className="f" style={{ flex: 1 }} placeholder="Contenu du QR (macite://p/…)" aria-label="Contenu du QR" value={manual} onChange={e => setManual(e.target.value)} />
      <button className="btn" onClick={() => { const id = parseQr(manual); id ? onPlace(id) : setErr('Code non reconnu : ce n’est pas un QR MaCité.'); }}>Valider</button>
      <button className="btn" onClick={onClose}>Fermer</button></div></div>);
}
