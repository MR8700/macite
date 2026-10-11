import type { Kind } from './geo';
/** Miroir de api/places.py (source de vérité = serveur, qui revalide tout). */
export interface PT { label: string; kinds: Kind[]; parents: string[]; parentRequired?: boolean; levelled?: boolean }
export const PLACE_TYPES: Record<string, PT> = {
  batiment: { label: 'Bâtiment', kinds: ['polygon'], parents: [] },
  aile: { label: 'Aile', kinds: ['polygon'], parents: ['batiment'], parentRequired: true },
  etage: { label: 'Étage', kinds: ['polygon'], parents: ['batiment', 'aile'], parentRequired: true, levelled: true },
  chambre: { label: 'Chambre', kinds: ['polygon', 'point'], parents: ['etage'], parentRequired: true, levelled: true },
  couloir: { label: 'Couloir', kinds: ['path'], parents: ['etage', 'aile', 'batiment'], levelled: true },
  escalier: { label: 'Escalier', kinds: ['point', 'path'], parents: ['batiment', 'aile', 'etage'], levelled: true },
  ascenseur: { label: 'Ascenseur', kinds: ['point'], parents: ['batiment', 'aile', 'etage'], levelled: true },
  porte: { label: 'Porte', kinds: ['point'], parents: ['batiment', 'aile', 'etage', 'chambre'], levelled: true },
  entree: { label: 'Entrée', kinds: ['point'], parents: ['batiment'] },
  terrain: { label: 'Terrain de sport', kinds: ['polygon'], parents: [] },
  espace: { label: 'Espace (cour, parking, zone verte)', kinds: ['polygon'], parents: [] },
  allee: { label: 'Allée / route', kinds: ['path'], parents: [] },
  cloture: { label: 'Clôture / mur', kinds: ['path', 'polygon'], parents: [] },
  service: { label: 'Service', kinds: ['point', 'polygon'], parents: ['batiment'] },
  point_eau: { label: 'Point d’eau', kinds: ['point'], parents: [] },
  qr: { label: 'Repère QR', kinds: ['point'], parents: ['batiment', 'etage'], levelled: true },
  repere: { label: 'Point de repère', kinds: ['point'], parents: [] },
  magasin: { label: 'Magasin / commerce (externe)', kinds: ['polygon', 'point'], parents: [] },
  ...Object.fromEntries(([['conciergerie', 'Conciergerie'], ['salle_etude', 'Salle d’étude'], ['salle_tv', 'Salle télé'], ['menage', 'Local ménage'], ['salle_conference', 'Salle de conférence'], ['sanitaires', 'Sanitaires'], ['cuisine', 'Cuisine / buanderie'], ['local_technique', 'Local technique'], ['infirmerie', 'Infirmerie']] as const)
    .map(([c, label]) => [c, { label, kinds: ['polygon', 'point'], parents: ['batiment', 'aile', 'etage'], parentRequired: true, levelled: true } as PT])),
};
export const typesForKind = (k: Kind) => Object.entries(PLACE_TYPES).filter(([, t]) => t.kinds.includes(k));
