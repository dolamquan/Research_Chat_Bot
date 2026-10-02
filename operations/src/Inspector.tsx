import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Copy, Check, X } from 'lucide-react';
import { request } from './api';
import { demoEvents } from './demo';
import type { Event } from './types';
import { dateTime, duration, money, number } from './format';
import { Loading, Status } from './ui';

export function Inspector({ id, demo, refresh, onClose, onSelect }: { id: string; demo: boolean; refresh: number; onClose: () => void; onSelect: (id: string) => void }) {
  const [data, setData] = useState<{ event: Event; timeline: Event[] } | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('timeline');
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true; setError(''); setData(null);
    if (demo) { const event = demoEvents.find(e => e.id === id); if (event) setData({ event, timeline: demoEvents.filter(e => e.request_id === event.request_id).sort((a, b) => a.started_at - b.started_at) }); }
    else void request<{ event: Event; timeline: Event[] }>(`/ops/events/${encodeURIComponent(id)}`).then(d => active && setData(d)).catch(e => active && setError(e.message));
    return () => { active = false; };
  }, [id, demo, refresh]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; closeRef.current?.focus();
    function keyboard(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,[tabindex="0"]') ?? [])];
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); document.body.style.overflow = overflow; previous?.focus(); };
  }, [onClose]);
  const event = data?.event;
  const leaves = data?.timeline.filter(e => e.kind === 'llm') ?? [];
  const priced = leaves.filter(e => e.cost_usd != null);
  const traceCost = priced.length ? priced.reduce((sum, e) => sum + e.cost_usd!, 0) : null;
  const traceStart = data?.timeline[0]?.started_at ?? 0;
  const traceEnd = data?.timeline.reduce((max, e) => Math.max(max, e.ended_at ?? e.started_at), traceStart) ?? 0;
  const traceDuration = Math.max(.01, traceEnd - traceStart);
  return <div className="drawer-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><aside ref={panelRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="inspector-title"><div className="drawer-heading"><span className="eyebrow">CALL INSPECTOR</span><button ref={closeRef} className="icon-button" aria-label="Close call inspector" onClick={onClose}><X size={20} /></button></div>
    {!event ? error ? <div className="notice error-notice" role="alert">{error}</div> : <Loading /> : <><div className="drawer-title"><span className={`kind-icon kind-${event.kind}`}>{event.kind === 'llm' ? 'AI' : '↗'}</span><h2 id="inspector-title">{event.name}</h2><Status status={event.status} /></div><p className="drawer-subtitle">{dateTime(event.started_at)} · {event.user_email || event.user_id || 'Unattributed user'}</p>
      <div className="detail-metrics"><div><span>Duration</span><strong>{duration(event.duration_ms)}</strong></div><div><span>{event.kind === 'llm' ? 'Call estimate' : 'Request estimate'}</span><strong>{money(event.kind === 'llm' ? event.cost_usd : traceCost, true)}</strong></div><div><span>Tokens</span><strong>{event.input_tokens == null ? '—' : number(event.input_tokens + (event.output_tokens ?? 0))}</strong></div></div>
      {event.error && <div className="error-detail"><AlertTriangle size={17} /><div><b>{event.error_type || 'Request failed'}</b><p>{event.error}</p></div></div>}
      <div className="detail-tabs" role="tablist"><button role="tab" aria-selected={tab === 'timeline'} onClick={() => setTab('timeline')}>Request timeline <span>{data!.timeline.length}</span></button><button role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Call details</button></div>
      {tab === 'timeline' ? <div className="timeline" role="tabpanel"><div className="timeline-header"><span>Operation</span><span>Relative duration</span></div>{data!.timeline.map(e => {
        const left = Math.max(0, (e.started_at - traceStart) / traceDuration * 100);
        const width = Math.max(2, ((e.ended_at ?? e.started_at) - e.started_at) / traceDuration * 100);
        return <button key={e.id} className={`timeline-row ${e.id === event.id ? 'active' : ''}`} onClick={() => onSelect(e.id)}><div><span className={`timeline-dot ${e.status}`} /><b>{e.name}</b><small>{e.kind} · {duration(e.duration_ms)}</small></div><span className="timeline-track"><i className={`timeline-bar ${e.status}`} style={{ marginLeft: `${Math.min(98, left)}%`, width: `${Math.min(width, 100 - left)}%` }} /></span></button>;
      })}<p className="timeline-note">{event.source === 'langsmith' ? 'Historical import includes LLM leaf calls only.' : 'Linked model and tool calls share a request ID. Background work may finish after the HTTP response.'}</p></div> : <div className="detail-properties" role="tabpanel">
        {[['Call ID', event.id], ['Request ID', event.request_id], ['Parent ID', event.parent_id || 'Root operation'], ['Provider', event.provider || 'Application'], ['Model', event.model || '—'], ['Source', event.source], ['Cost basis', event.cost_source === 'langsmith' ? 'LangSmith reported estimate' : event.cost_source], ['Input tokens', event.input_tokens == null ? 'Unavailable' : number(event.input_tokens)], ['Cached input tokens', event.cached_tokens == null ? 'Unavailable' : number(event.cached_tokens)], ['Output tokens', event.output_tokens == null ? 'Unavailable' : number(event.output_tokens)], ['HTTP / socket status', event.http_status?.toString() || '—'], ['Service tier', String(event.metadata.service_tier || 'Not reported')]].map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}
        <p className="timeline-note">Unknown costs are excluded from totals. Reasoning tokens are included in the provider’s output-token total. Request bodies and model text are not stored.</p></div>}
      <div className="drawer-footer"><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(event.request_id); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Clipboard unavailable. Copy the request ID from Call details.'); } }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy request ID'}</button>{event.source === 'langsmith' && <a className="button secondary" href={typeof event.metadata.trace_url === 'string' && /^https:\/\/smith\.langchain\.com\//.test(event.metadata.trace_url) ? event.metadata.trace_url : 'https://smith.langchain.com'} target="_blank" rel="noreferrer">LangSmith <ArrowUpRight size={15} /></a>}</div>{error && <p className="notice error-notice">{error}</p>}
    </>}
  </aside></div>;
}
