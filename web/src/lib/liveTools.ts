// Outils que le modèle Live peut appeler. Ils s'exécutent ICI, sur les lieux PUBLIÉS déjà téléchargés (fonctionne hors ligne).
// Le modèle ne reçoit que des lieux de la carte ; tout identifiant qu'il renvoie est revérifié avant d'agir.
import { rank, withParentNames, type Place } from './fuzzy';
import { outcomeMessage, type NavOutcome } from './itinerary';
export interface LiveCtx { places: Place[]; onShowPlace(p: Place): boolean; onNavigate(p: Place): NavOutcome }
const clean = (s: string | null | undefined) => (s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').slice(0, 80);
const pub = (p: Place & { parent_name?: string | null }) => ({ id: p.id, name: clean(p.name), type: clean(p.type_label ?? p.type), level: p.level ?? null, inside: p.parent_name ? clean(p.parent_name) : null });

export function runLiveTool(name: string, args: unknown, ctx: LiveCtx): Record<string, unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  try {
    if (name === 'find_place') {
      const q = typeof a.query === 'string' ? a.query.slice(0, 200).trim() : '';
      return q ? { places: rank(q, withParentNames(ctx.places), 5).map(pub) } : { error: 'requête vide' };
    }
    if (name === 'show_place' || name === 'start_navigation') {
      const p = typeof a.place_id === 'string' ? withParentNames(ctx.places).find((x) => x.id === a.place_id) : undefined;
      if (!p) return { ok: false, status: 'unknown_place', message: 'Lieu inconnu : utilisez un identifiant renvoyé par find_place.' };
      if (name === 'show_place') return ctx.onShowPlace(p) ? { ok: true, status: 'shown', place: pub(p) } : { ok: false, status: 'place_unavailable', message: outcomeMessage({ status: 'place_unavailable' }, p.name) };
      const o = ctx.onNavigate(p), message = outcomeMessage(o, clean(p.name));
      // Le modèle ne reçoit « ok: true » QUE si une route a réellement été calculée.
      return o.status === 'route_ready'
        ? { ok: true, status: 'route_ready', place: pub(p), distance_m: o.distance_m, minutes: o.minutes, first_steps: o.plan.steps.slice(0, 3).map(clean), message }
        : { ok: false, status: o.status === 'no_route' ? `no_route_${o.reason}` : o.status, place: pub(p), message };
    }
  } catch { return { error: 'échec de l’outil' }; }
  return { error: 'outil inconnu' };
}
