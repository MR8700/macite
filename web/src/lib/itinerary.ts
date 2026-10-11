// Calcul d'itinéraire à résultat TYPÉ : l'interface et l'assistant vocal n'annoncent « itinéraire prêt » que si une route existe réellement.
import { locate, locateXY, plan, type NavGraph, type NavPlace, type Plan } from './nav';
import type { LngLat } from './geo';

export type NoRouteReason = 'start_unlinked' | 'dest_unlinked' | 'no_path' | 'no_step_free_path';
export type NavOutcome =
  | { status: 'route_ready'; plan: Plan; distance_m: number; minutes: number }
  | { status: 'gps_needed' }                                  // pas de position, ni de départ choisi : le calcul reprendra à la prochaine demande
  | { status: 'no_route'; reason: NoRouteReason }              // lieu connu mais aucun chemin praticable
  | { status: 'place_unavailable' }                            // lieu absent de la carte téléchargée sur l'appareil
  | { status: 'error' };

export interface ItineraryIn { graph: NavGraph; places: NavPlace[]; dest: NavPlace | null | undefined; startId?: string; gpsFix?: { p: LngLat } | null; accessible: boolean }

export function computeItinerary(i: ItineraryIn): NavOutcome {
  try {
    if (!i.dest) return { status: 'place_unavailable' };
    let from: string | null;
    if (i.startId) { const sp = i.places.find((x) => x.id === i.startId); if (!sp) return { status: 'no_route', reason: 'start_unlinked' }; from = locate(i.graph, sp, i.places); }
    else if (!i.gpsFix) return { status: 'gps_needed' };
    else from = locateXY(i.graph, i.gpsFix.p);
    if (!from) return { status: 'no_route', reason: 'start_unlinked' };
    const to = locate(i.graph, i.dest, i.places);
    if (!to) return { status: 'no_route', reason: 'dest_unlinked' };
    const startName = i.startId ? i.places.find((x) => x.id === i.startId)?.name : undefined;
    const r = plan(i.graph, from, to, i.dest.name, startName);
    if (!r || !r.route || !r.legs.length) return { status: 'no_route', reason: i.accessible ? 'no_step_free_path' : 'no_path' };
    return { status: 'route_ready', plan: r, distance_m: Math.round(r.route.distance), minutes: Math.max(1, Math.round(r.route.seconds / 60)) };
  } catch { return { status: 'error' }; }
}

const NO_ROUTE: Record<NoRouteReason, string> = {
  start_unlinked: 'Départ non relié au réseau connu : choisissez un autre point de départ.',
  dest_unlinked: 'Ce lieu n’est pas relié au réseau de chemins connu.',
  no_step_free_path: 'Aucun chemin sans escalier connu (ascenseur non enregistré ?).',
  no_path: 'Aucun chemin praticable connu entre le départ et ce lieu (escalier, couloir ou entrée manquant ?).',
};
/** Message honnête et lisible (écran ET voix) pour chaque résultat. */
export function outcomeMessage(o: NavOutcome, destName: string): string {
  switch (o.status) {
    case 'route_ready': return `Itinéraire prêt vers ${destName} : ${o.distance_m} m, environ ${o.minutes} min à pied.`;
    case 'gps_needed': return 'Position en cours d’acquisition : autorisez la localisation, patientez quelques secondes, puis redemandez l’itinéraire.';
    case 'no_route': return NO_ROUTE[o.reason];
    case 'place_unavailable': return 'Ce lieu n’est pas dans la carte téléchargée sur cet appareil : synchronisez (onglet Synchro), puis réessayez.';
    default: return 'Le calcul de l’itinéraire a échoué. Réessayez.';
  }
}
