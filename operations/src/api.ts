import { createClient } from '@supabase/supabase-js';
import type { Dashboard, Filters, Identity } from './types';

const env = (import.meta as unknown as { env: Record<string, string> }).env;
export const supabase = env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY
  ? createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY) : null;
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function headers() {
  const session = supabase ? await supabase.auth.getSession() : null;
  return { 'Content-Type': 'application/json', ...(session?.data.session ? { Authorization: `Bearer ${session.data.session.access_token}` } : {}) };
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers: { ...await headers(), ...init.headers }, signal: init.signal ?? AbortSignal.timeout(20000) }); }
  catch { throw new ApiError(0, 'Cannot reach the backend. Start the research chatbot API on port 8002, then reconnect.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = typeof body.detail === 'string' ? body.detail : response.status === 422 ? 'Check your settings. Rates and budget must be valid, nonnegative numbers, with unique model names.' : '';
    throw new ApiError(response.status, response.status === 404 ? 'Research Ops is not available on this backend yet. Restart the chatbot backend to load the new monitoring routes.' : detail || `The backend returned HTTP ${response.status}.`);
  }
  return response.json();
}
export const getIdentity = () => request<Identity>('/ops/identity');
export function queryString(days: number, filters: Filters, offset = 0) {
  const params = new URLSearchParams({ days: String(days), limit: '25', offset: String(offset) });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
}
export async function dashboard(days: number, filters: Filters, offset: number): Promise<Dashboard> {
  const [overview, events, users, issues, connection] = await Promise.all([
    request<Dashboard['overview']>(`/ops/overview?days=${days}`), request<Dashboard['events']>(`/ops/events?${queryString(days, filters, offset)}`),
    request<{ users: Dashboard['users'] }>(`/ops/users?days=${days}`), request<{ issues: Dashboard['issues'] }>(`/ops/issues?days=${days}`), request<Dashboard['connection']>('/ops/connection'),
  ]);
  return { overview, events, users: users.users, issues: issues.issues, connection };
}
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportCalls(days: number, filters: Filters): Promise<number> {
  const response = await fetch(`/api/ops/export?${queryString(days, filters)}`, { headers: await headers(), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Could not export calls. Reconnect and try again.');
  download(await response.blob(), 'research-ops-calls.csv');
  return Number(response.headers.get('X-Ops-Export-Total') || 0);
}
