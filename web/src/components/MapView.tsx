import { useEffect, useRef, useState } from 'react';
import { Map as GLMap, Marker, type GeoJSONSource } from 'maplibre-gl';
import { getOfflineMap, registerLocalTiles, mapInfo } from '../lib/offlineMap';
import type { Feature, FeatureCollection } from 'geojson';
type MLMap = GLMap;
import type { Kind, LngLat } from '../lib/geo';

export interface Feat { id: string; kind: Kind; name: string; points: LngLat[]; type?: string; level?: number | null; draft?: boolean }
const fc = (fs: Feat[]) => ({
  type: 'FeatureCollection' as const,
  features: fs.filter(f => f.points.length).flatMap(f => {
    const p = { name: f.name, id: f.id, type: f.type ?? '', level: f.level ?? null,
      // Volumétrie indicative pour les empreintes validées du campus, pas une mesure cadastrale.
      height: f.type === 'batiment' ? 9 : f.type === 'aile' ? 4 : 0 };
    const geom = f.kind === 'point' || f.points.length === 1 ? { type: 'Point' as const, coordinates: f.points[0] }
      : f.kind === 'path' || f.points.length === 2 ? { type: 'LineString' as const, coordinates: f.points }
      : { type: 'Polygon' as const, coordinates: [[...f.points, f.points[0]]] };
    const out: Feature[] = [{ type: 'Feature', properties: p, geometry: geom }];
    if (f.draft) f.points.forEach((c, i) => out.push({ type: 'Feature', properties: { v: i + 1 }, geometry: { type: 'Point', coordinates: c } }));
    return out;
  }),
});
// Centre par défaut = Ouagadougou (vue approximative, ce n'est PAS une donnée de relevé).
const DEFAULT: LngLat = [-1.5197, 12.3714];
const TERRAIN_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];

interface Props { published: Feat[]; draft: Feat | null; route: { coords: LngLat[]; on: boolean }[] | null; user: LngLat | null; heading?: number | null; followGps?: boolean; terrain?: boolean; threeD?: boolean; level?: number | null; focus: LngLat | null; hasLocal?: boolean; onEditPoint?: (i: number, p: LngLat | null) => void; onSelect?: (id: string) => void; onReady: (m: MLMap) => void }
export function MapView({ published, draft, route, user, heading, followGps, terrain, threeD, level, focus, hasLocal, onEditPoint, onSelect, onReady }: Props) {
  const markers = useRef<Marker[]>([]);
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const el = useRef<HTMLDivElement>(null); const map = useRef<MLMap | undefined>(undefined); const [ready, setReady] = useState(false);
  const set = (id: string, d: FeatureCollection) => (map.current?.getSource(id) as GeoJSONSource | undefined)?.setData(d);
  useEffect(() => {
    const m = new GLMap({ container: el.current!, center: DEFAULT, zoom: 15, attributionControl: { compact: true },
      style: { version: 8, sources: { osm: { type: 'raster', tileSize: 256, attribution: '© OpenStreetMap contributors', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'] } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] } });
    map.current = m;
    m.on('load', () => {
      const empty = { type: 'FeatureCollection' as const, features: [] };
      for (const s of ['pub', 'draft', 'route', 'user']) m.addSource(s, { type: 'geojson', data: empty });
      m.addLayer({ id: 'pub-fill', type: 'fill', source: 'pub', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#16845B', 'fill-opacity': 0.25 } });
      m.addLayer({ id: 'pub-line', type: 'line', source: 'pub', filter: ['!=', '$type', 'Point'], paint: { 'line-color': '#0D5B40', 'line-width': 3 } });
      m.addLayer({ id: 'pub-pt', type: 'circle', source: 'pub', filter: ['==', '$type', 'Point'], paint: { 'circle-color': '#16845B', 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      m.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#E9A23B', 'fill-opacity': 0.25 } });
      m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', '$type', 'Point'], paint: { 'line-color': '#E9A23B', 'line-width': 3, 'line-dasharray': [2, 1] } });
      m.addLayer({ id: 'draft-pt', type: 'circle', source: 'draft', filter: ['==', '$type', 'Point'], paint: { 'circle-color': '#fff', 'circle-radius': 6, 'circle-stroke-color': '#E9A23B', 'circle-stroke-width': 3 } });
      m.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#3478F6', 'line-width': 5, 'line-opacity': ['case', ['get', 'on'], 1, 0.22] } });
      m.addLayer({ id: 'user-halo', type: 'circle', source: 'user', paint: { 'circle-color': '#3478F6', 'circle-opacity': 0.2, 'circle-radius': 18 } });
      m.addLayer({ id: 'user', type: 'circle', source: 'user', paint: { 'circle-color': '#3478F6', 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
      m.addSource('terrain-dem', { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: 'Terrain : Mapzen / AWS Open Data' });
      // MapLibre déconseille de partager la même source entre hillshade et le maillage 3D.
      m.addSource('terrain-shading-dem', { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: 'Terrain : Mapzen / AWS Open Data' });
      m.addLayer({ id: 'terrain-hillshade', type: 'hillshade', source: 'terrain-shading-dem', layout: { visibility: 'visible' }, paint: { 'hillshade-exaggeration': 0.24, 'hillshade-shadow-color': '#43566b', 'hillshade-highlight-color': '#ffffff' } }, 'pub-fill');
      m.addLayer({ id: 'published-buildings-3d', type: 'fill-extrusion', source: 'pub', filter: ['all', ['==', '$type', 'Polygon'], ['in', ['get', 'type'], ['literal', ['batiment', 'aile']]]], paint: {
        'fill-extrusion-color': '#397c68', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.82, 'fill-extrusion-vertical-gradient': true,
      }, layout: { visibility: 'none' } }, 'draft-fill');
      m.on('click', e => {
        const hit = m.queryRenderedFeatures(e.point, { layers: ['pub-fill', 'pub-line', 'pub-pt'] })[0];
        const id = hit?.properties?.id;
        if (typeof id === 'string') onSelectRef.current?.(id);
      });
      m.on('mousemove', e => { m.getCanvas().style.cursor = m.queryRenderedFeatures(e.point, { layers: ['pub-fill', 'pub-line', 'pub-pt'] }).length ? 'pointer' : ''; });
      onReady(m); setReady(true);
    });
    return () => m.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (ready) set('pub', fc(published)); }, [published, ready]);
  useEffect(() => { if (ready) set('draft', fc(draft ? [{ ...draft, draft: true }] : [])); }, [draft, ready]);
  useEffect(() => { if (ready) set('route', { type: 'FeatureCollection', features: (route ?? []).filter(l => l.coords.length > 1).map(l => ({ type: 'Feature' as const, properties: { on: l.on }, geometry: { type: 'LineString' as const, coordinates: l.coords } })) }); }, [route, ready]);
  useEffect(() => { if (ready) set('user', { type: 'FeatureCollection', features: user ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: user } }] : [] }); }, [user, ready]);
  useEffect(() => {
    const m = map.current; if (!ready || !m) return;
    if (m.getLayer('terrain-hillshade')) m.setLayoutProperty('terrain-hillshade', 'visibility', terrain ? 'visible' : 'none');
    if (m.getLayer('published-buildings-3d')) m.setLayoutProperty('published-buildings-3d', 'visibility', threeD ? 'visible' : 'none');
    if (terrain || threeD) m.setTerrain({ source: 'terrain-dem', exaggeration: threeD ? 1.15 : 0.75 }); else m.setTerrain(null);
    m.easeTo({ pitch: threeD ? 55 : 0, duration: 500 });
  }, [terrain, threeD, ready]);
  useEffect(() => {
    const m = map.current; if (!ready || !m) return;
    if (level == null) { m.setFilter('pub-fill', ['==', '$type', 'Polygon']); m.setFilter('pub-line', ['!=', '$type', 'Point']); m.setFilter('pub-pt', ['==', '$type', 'Point']); return; }
    m.setFilter('pub-fill', ['all', ['==', '$type', 'Polygon'], ['==', ['get', 'level'], level]]);
    m.setFilter('pub-line', ['all', ['!=', '$type', 'Point'], ['==', ['get', 'level'], level]]);
    m.setFilter('pub-pt', ['all', ['==', '$type', 'Point'], ['==', ['get', 'level'], level]]);
  }, [level, ready]);
  useEffect(() => {
    if (!ready || !followGps || !user) return;
    map.current?.easeTo({ center: user, bearing: heading ?? map.current.getBearing(), pitch: threeD ? 55 : 48, duration: 350 });
  }, [user, heading, followGps, threeD, ready]);
  // Fond de carte local (téléchargé) : placé SOUS la couche en ligne, visible dès que le réseau manque.
  useEffect(() => {
    const m = map.current; if (!ready || !m) return;
    if (!hasLocal) { if (m.getLayer('local')) m.removeLayer('local'); if (m.getSource('local')) m.removeSource('local'); return; }
    registerLocalTiles();
    (async () => {  // limite les requêtes aux zooms réellement présents dans le fichier ; au-delà, la carte sur-zoome au lieu de disparaître
      const rec = await getOfflineMap(); if (!rec || m.getSource('local')) return; const z = await mapInfo(rec.blob);
      m.addSource('local', { type: 'raster', tileSize: 256, minzoom: z.min, maxzoom: z.max, tiles: ['local://{z}/{x}/{y}'], attribution: z.attribution });
      m.addLayer({ id: 'local', type: 'raster', source: 'local' }, 'osm');
    })();
  }, [ready, hasLocal]);
  // Sommets modifiables : glisser = déplacer, double-tap = supprimer.
  useEffect(() => {
    markers.current.forEach(m => m.remove()); markers.current = [];
    if (!ready || !draft || !onEditPoint || !map.current) return;
    draft.points.forEach((pt, i) => {
      const el = document.createElement('button'); el.setAttribute('aria-label', `Sommet ${i + 1} : glisser pour déplacer, double-appui pour supprimer`);
      el.style.cssText = 'width:28px;height:28px;border-radius:50%;border:3px solid #E9A23B;background:#fff;padding:0;font:600 11px Inter,sans-serif;color:#172B4D';
      el.textContent = String(i + 1);
      el.addEventListener('dblclick', e => { e.stopPropagation(); onEditPoint(i, null); });
      const m = new Marker({ element: el, draggable: true }).setLngLat(pt).addTo(map.current!);
      m.on('dragend', () => { const l = m.getLngLat(); onEditPoint(i, [l.lng, l.lat]); });
      markers.current.push(m);
    });
    return () => { markers.current.forEach(m => m.remove()); markers.current = []; };
  }, [draft, ready, onEditPoint]);
  useEffect(() => { if (focus) map.current?.easeTo({ center: focus, zoom: 18, duration: 600 }); }, [focus]);
  return <div className="map" ref={el} role="application" aria-label="Carte de la cité" />;
}
