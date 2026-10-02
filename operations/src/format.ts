export function money(value: number | null | undefined, precise = false) {
  if (value == null) return '—';
  if (value > 0 && value < 0.0001) return '<$0.0001';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: precise ? 4 : 2, maximumFractionDigits: precise ? 4 : 2 }).format(value);
}
export const number = (value: number | null | undefined) => new Intl.NumberFormat('en-US').format(value ?? 0);
export const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export function duration(ms: number | null) { return ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`; }
export function dateTime(seconds: number) { return new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
export function relative(seconds: number) {
  const delta = Math.max(0, Date.now() / 1000 - seconds);
  return delta < 60 ? 'Just now' : delta < 3600 ? `${Math.floor(delta / 60)}m ago` : delta < 86400 ? `${Math.floor(delta / 3600)}h ago` : `${Math.floor(delta / 86400)}d ago`;
}
export function change(now: number, before: number): string | null { return before > 0 ? `${Math.abs((now - before) / before * 100).toFixed(1)}%` : null; }
export function csv(events: Record<string, unknown>[], columns: string[]) {
  const escape = (value: unknown) => {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [columns.map(escape).join(','), ...events.map(e => columns.map(c => escape(e[c])).join(','))].join('\r\n');
}
