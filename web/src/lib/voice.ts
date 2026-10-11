import { norm } from "./fuzzy";
// Voix : reconnaissance et synthèse du NAVIGATEUR (gratuit, aucun enregistrement envoyé à NOTRE serveur).
// Attention : selon le navigateur (Chrome), la reconnaissance passe par un service distant → l'indiquer dans le consentement.
type SR = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };
const Ctor = (): (new () => SR) | undefined => (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
export const isSttSupported = () => !!Ctor();

export function startListening(o: { lang?: string; onInterim: (t: string) => void; onFinal: (t: string) => void; onError: (m: string) => void; onEnd?: () => void }): () => void {
  const C = Ctor(); if (!C) { o.onError("Reconnaissance vocale non disponible sur cet appareil."); return () => {}; }
  const r = new C(); r.lang = o.lang ?? "fr-FR"; r.interimResults = true; r.continuous = false;
  r.onresult = (e) => { let txt = "", fin = false; for (let i = e.resultIndex; i < e.results.length; i++) { txt += e.results[i][0].transcript; fin ||= e.results[i].isFinal; } (fin ? o.onFinal : o.onInterim)(txt.trim()); };
  r.onerror = (e) => o.onError(e.error === "not-allowed" ? "Accès au microphone refusé." : e.error === "no-speech" ? "Je n'ai rien entendu." : "Erreur de reconnaissance vocale.");
  r.onend = () => o.onEnd?.();
  r.start(); return () => r.stop();
}
export function speak(text: string, lang = "fr-FR") {
  const s = (globalThis as any).speechSynthesis; if (!s) return;
  s.cancel(); const u = new (globalThis as any).SpeechSynthesisUtterance(text); u.lang = lang; s.speak(u);
}

// Commandes de relevé : liste FERMÉE, interprétée côté client. Les actions sensibles exigent une confirmation.
export type Command = "start_survey" | "add_point" | "finish_outline" | "save_draft" | "undo_last";
const PATTERNS: [Command, RegExp][] = [
  ["start_survey", /^(commencer|demarrer|lancer) (un |le )?releve$/], ["add_point", /^ajouter (un )?point( gps)?$/],
  ["finish_outline", /^(terminer|finir) (le )?contour$/], ["save_draft", /^enregistrer (comme )?brouillon$/], ["undo_last", /^annuler (le )?dernier point$/],
];
export const NEEDS_CONFIRMATION: ReadonlySet<Command> = new Set<Command>(["save_draft"]);
export function parseCommand(text: string): Command | null {
  const t = norm(text).replace(/^macite /, "");
  return PATTERNS.find(([, re]) => re.test(t))?.[0] ?? null;
}
