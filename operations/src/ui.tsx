import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight, ArrowRight, Inbox, LoaderCircle } from 'lucide-react';
import type { Event, Metrics } from './types';
import { change, dateTime, duration, money, number } from './format';

export const colors = ['#177c65', '#8ba8e0', '#dbb572', '#a894c5', '#96b9ac', '#ce847f'];
export function Status({ status }: { status: Event['status'] }) { return <span className={`status status-${status}`}><i />{status === 'success' ? 'Success' : status === 'error' ? 'Failed' : status === 'running' ? 'Running' : 'Cancelled'}</span>; }
export function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="empty"><div className="empty-icon"><Inbox size={23} /></div><h3>{title}</h3><p>{children}</p></div>; }
export function Loading() { return <div className="loading"><LoaderCircle className="spin" size={22} /><p>Connecting to your workspace…</p></div>; }
export function Panel({ title, caption, action, children, className = '' }: { title: string; caption?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{caption && <p>{caption}</p>}</div>{action}</div>{children}</section>;
}
export function Metric({ label, value, icon: Icon, before, current, note, spark, tone = 'green' }: { label: string; value: string; icon: LucideIcon; before?: number; current?: number; note: string; spark: number[]; tone?: string }) {
  const trend = before !== undefined && current !== undefined ? change(current, before) : null;
  const up = (current ?? 0) >= (before ?? 0);
  const max = Math.max(...spark, 1); const points = spark.map((v, i) => `${i / Math.max(1, spark.length - 1) * 96},${27 - v / max * 22}`).join(' ');
  return <div className={`metric metric-${tone}`}><div className="metric-label">{label}<span><Icon size={16} /></span></div><div className="metric-main"><strong>{value}</strong><svg viewBox="0 0 100 30" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></div><div className="metric-foot">{trend && <span className="trend">{up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{trend}</span>}<span>{note}</span></div></div>;
}
export function CallsTable({ events, onSelect, compact = false }: { events: Event[]; onSelect: (id: string) => void; compact?: boolean }) {
  return <div className="table-scroll"><table className="calls-table"><thead><tr><th>Call / operation</th><th>Status</th>{!compact && <th>User</th>}<th>Duration</th><th>Est. cost</th><th>Time</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{events.map(e => <tr key={e.id}>
    <td><button className="call-name" onClick={() => onSelect(e.id)}><span className={`kind-icon kind-${e.kind}`}>{e.kind === 'llm' ? 'AI' : e.kind === 'tool' ? 'ƒ' : e.kind === 'retrieval' ? 'R' : '↗'}</span><span><b>{e.name}</b><small>{e.kind === 'llm' ? `${e.provider} · ${e.input_tokens == null ? 'usage unavailable' : number((e.input_tokens ?? 0) + (e.output_tokens ?? 0)) + ' tokens'}` : `${e.kind === 'http' ? 'API request' : e.kind === 'websocket' ? 'Assistant connection' : e.kind === 'tool' ? 'Agent tool' : 'Retrieval'} · ${e.id.slice(0, 8)}`}</small></span></button></td>
    <td><Status status={e.status} /></td>{!compact && <td><span className="user-cell">{e.user_email || (e.user_id ? e.user_id.slice(0, 12) : 'Unattributed')}</span></td>}<td className="mono">{duration(e.duration_ms)}</td><td className="mono">{e.kind === 'llm' ? money(e.cost_usd, true) : '—'}</td><td className="time-cell">{dateTime(e.started_at)}</td><td><button className="icon-button row-arrow" aria-label={`Inspect ${e.name}`} onClick={() => onSelect(e.id)}><ArrowRight size={16} /></button></td>
  </tr>)}</tbody></table></div>;
}
export function Budget({ metrics, budget, threshold, onEdit }: { metrics: Metrics; budget: number; threshold: number; onEdit: () => void }) {
  const percent = metrics.cost / budget * 100; const warning = percent >= threshold;
  return <div className={`budget-box ${warning ? 'budget-warning' : ''}`}><div className="budget-label"><b>Monthly budget</b><button onClick={onEdit}>Manage <ArrowRight size={13} /></button></div><div className="budget-amount"><strong>{money(metrics.cost)}</strong><span>of {money(budget)}</span></div><div className="progress"><i style={{ width: `${Math.min(100, percent)}%` }} /></div><p>{warning ? 'Your spending alert threshold has been reached.' : `${Math.max(0, 100 - percent).toFixed(0)}% of your budget remaining`}{metrics.unpriced > 0 && <span> · {metrics.unpriced} unpriced calls</span>}</p><small>Month to date · alert only</small></div>;
}
