// Client de l'assistant IA. La clé Google reste sur le serveur : ici, seulement le jeton de session MaCité.
import { API_BASE } from './api';
let cfg = { baseUrl: API_BASE, getToken: (): string | null => { try { return JSON.parse(localStorage.getItem('macite-auth') ?? 'null')?.token ?? null; } catch { return null; } } };
export function configureAi(c: Partial<typeof cfg>) { cfg = { ...cfg, ...c }; }
export const hasAiSession = () => !!cfg.getToken();

const CONSENT_KEY = 'macite_ai_consent';
export const hasAiConsent = () => { try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; } };
export const giveAiConsent = () => { try { localStorage.setItem(CONSENT_KEY, '1'); } catch { /* stockage indisponible */ } };

const LIVE_CONSENT_KEY = 'macite_ai_live_consent';   // consentement SÉPARÉ : la voix part directement vers Google, sans passer par notre serveur
export const hasLiveConsent = () => { try { return localStorage.getItem(LIVE_CONSENT_KEY) === '1'; } catch { return false; } };
export const giveLiveConsent = () => { try { localStorage.setItem(LIVE_CONSENT_KEY, '1'); } catch { /* stockage indisponible */ } };
/** Révocation : le consentement ne vit que sur l'appareil ; sans lui, aucun jeton n'est demandé (ack=false → refus 422 côté serveur). */
export const revokeLiveConsent = () => { try { localStorage.removeItem(LIVE_CONSENT_KEY); } catch { /* stockage indisponible */ } };

export interface AiPlace { id: string; name: string; type_label?: string | null; type?: string | null; parent_name?: string | null; level?: number | null }
export type ChatAction = 'show_place' | 'navigate' | 'list' | 'clarify' | 'not_found';
export interface ChatReply { action: ChatAction; degraded: boolean; message: string; place?: AiPlace; places?: AiPlace[]; options?: AiPlace[] }
export interface SurveyDraft { name: string; type: string | null; parent_id: string | null; notes: string }
export class AiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const t = cfg.getToken();
  const r = await fetch(cfg.baseUrl + path, { ...init, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
  if (!r.ok) { let m = `Erreur ${r.status}`; try { const j = await r.json(); if (typeof j.detail === 'string') m = j.detail; } catch { /* corps non JSON */ } throw new AiError(r.status, m); }
  return r.json() as Promise<T>;
}
export interface AiQuota { used: number; limit: number; remaining: number }
/** Quota texte du jour : permet de ne pas envoyer une requête vouée au refus 429, et de montrer ce qu'il reste. */
export const aiUsage = () => call<AiQuota>('/ai/usage');
export const aiStatus = () => call<{ enabled: boolean }>('/ai/status').then((j) => j.enabled).catch(() => false);
/** Le consentement (ack) n'est envoyé que s'il a réellement été donné par l'utilisateur. */
export const aiChat = (message: string, pos?: { lat: number; lon: number }) =>
  call<ChatReply>('/ai/chat', { method: 'POST', body: JSON.stringify({ message, ack: hasAiConsent(), ...(pos ?? {}) }) });
export const aiSurveyDraft = (text: string) =>
  call<{ draft: SurveyDraft; degraded: boolean; message: string }>('/ai/survey-draft', { method: 'POST', body: JSON.stringify({ text, ack: hasAiConsent() }) });

export const aiLiveStatus = () => call<{ enabled: boolean }>('/ai/live/status').then((j) => j.enabled).catch(() => false);
export const aiLiveToken = () => call<{ token: string; model: string; expires_in: number; max_session_s?: number }>('/ai/live-token', { method: 'POST', body: JSON.stringify({ ack: hasLiveConsent() }) });
/** Mesure du coût pendant le pilote : durée réellement écoutée. Sans effet bloquant : une erreur est ignorée (le quota ne dépend pas de ce rapport). */
export const aiLiveReport = (seconds: number) => call<{ recorded: boolean }>('/ai/live/report', { method: 'POST', body: JSON.stringify({ seconds: Math.max(0, Math.round(seconds)) }) }).catch(() => ({ recorded: false }));
