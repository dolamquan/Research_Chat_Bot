import { useState, type FormEvent } from 'react';
import { ArrowRight, Plus, Save, X } from 'lucide-react';
import { request } from './api';
import { saveDemoAPI } from './demo';
import { duration, money, number } from './format';
import type { APIConfig, ManagedAPI } from './types';
import { Empty, Panel } from './ui';

const blank: APIConfig = { id: '', name: '', provider: '', category: 'custom', enabled: true, billing: 'unknown', unit: 'request', unit_price: 0, unit_size: 1, monthly_budget: null, monthly_call_limit: null };
function config(api: APIConfig): APIConfig {
  return Object.fromEntries(Object.keys(blank).map(key => [key, api[key as keyof APIConfig]])) as APIConfig;
}
export function billingLabel(api: APIConfig) {
  return api.billing === 'unknown' ? 'Usage only · cost unknown' : api.billing === 'free' ? 'Explicitly free' : api.billing === 'tokens' ? 'Model token rates' : `${money(api.unit_price, true)} / ${number(api.unit_size)} ${api.billing === 'request' ? 'requests' : api.unit}`;
}

export function APIBreakdown({ apis, onCalls }: { apis: ManagedAPI[]; onCalls: (id: string) => void }) {
  const active = apis.filter(a => a.stats.events > 0);
  return <Panel title="API breakdown" caption="All instrumented providers and service types">
    {active.length ? <div className="table-scroll"><table className="breakdown-table"><thead><tr><th>API / provider</th><th>Category</th><th>Calls</th><th>Failures</th><th>Avg. duration</th><th>Recorded spend</th></tr></thead><tbody>{active.map(api => <tr key={api.id}>
      <td><button className="model-link" onClick={() => onCalls(api.id)}><span><b>{api.name}</b><small>{api.provider}</small></span></button></td><td>{api.category}</td><td>{number(api.stats.calls)}</td><td>{number(api.stats.errors)}</td><td>{duration(api.stats.latency_ms)}</td><td className="mono">{api.stats.calls === api.stats.unpriced ? '—' : money(api.stats.cost, true)}{api.stats.unpriced > 0 && <small className="cell-note">+ {api.stats.unpriced} unpriced</small>}</td>
    </tr>)}</tbody></table></div> : <Empty title="No outbound API activity yet">Instrumented API calls will appear here as you use the chatbot.</Empty>}
  </Panel>;
}

export function APIs({ apis, demo, onSave, notify, onCalls, onPricing }: { apis: ManagedAPI[]; demo: boolean; onSave: () => void; notify: (message: string) => void; onCalls: (id: string) => void; onPricing: () => void }) {
  const [draft, setDraft] = useState<APIConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function edit(api?: ManagedAPI) { setError(''); setCreating(!api); setDraft(api ? config(api) : { ...blank }); }
  async function save(e: FormEvent) {
    e.preventDefault(); if (!draft) return;
    setBusy(true); setError('');
    try {
      const value = { ...draft, id: draft.id.trim(), name: draft.name.trim(), provider: draft.provider.trim(), category: draft.category.trim(), unit: draft.unit.trim() };
      if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.id) || !value.name || !value.provider || !value.category || !value.unit) throw new Error('Enter a name, provider, category, unit and an API ID containing lowercase letters, numbers, underscores or hyphens.');
      if (!Number.isFinite(value.unit_price) || value.unit_price < 0 || !Number.isFinite(value.unit_size) || value.unit_size <= 0 || (value.monthly_budget != null && (!Number.isFinite(value.monthly_budget) || value.monthly_budget <= 0)) || (value.monthly_call_limit != null && (!Number.isSafeInteger(value.monthly_call_limit) || value.monthly_call_limit < 1))) throw new Error('Use valid nonnegative prices, a positive unit size, and positive limits.');
      if (creating && apis.some(a => a.id === value.id)) throw new Error('An API with this ID already exists.');
      if (demo) saveDemoAPI(value);
      else await request(creating ? '/ops/apis' : `/ops/apis/${encodeURIComponent(value.id)}`, { method: creating ? 'POST' : 'PUT', body: JSON.stringify(value) });
      setDraft(null); onSave(); notify(demo ? 'Sample API configuration saved.' : 'API saved. Controls apply to new instrumented calls.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save API.'); }
    finally { setBusy(false); }
  }
  async function toggle(api: ManagedAPI) {
    setBusy(true); setError('');
    try {
      const value = { ...config(api), enabled: !api.enabled };
      if (demo) saveDemoAPI(value);
      else await request(`/ops/apis/${encodeURIComponent(api.id)}`, { method: 'PUT', body: JSON.stringify(value) });
      onSave(); notify(demo ? 'Sample control updated.' : `${api.name} ${value.enabled ? 'resumed' : 'paused'} for new instrumented calls.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update API.'); }
    finally { setBusy(false); }
  }
  return <>
    <div className="notice neutral-notice"><span>Register any provider or service type. Connect its API ID in the backend adapter to activate tracking and controls. Credentials stay in your existing server configuration.</span></div>
    {error && <div className="notice error-notice" role="alert">{error}</div>}
    {draft && <Panel title={creating ? 'Register API' : `Configure ${draft.name}`} caption="Changes apply to future calls" action={<button className="icon-button" aria-label="Close API editor" disabled={busy} onClick={() => setDraft(null)}><X size={18} /></button>}><form onSubmit={save} className="settings-body api-editor">
      <div className="field-grid"><label>API ID<input aria-label="API ID" required maxLength={80} pattern="[a-z0-9][a-z0-9_-]*" value={draft.id} disabled={!creating || busy} onChange={e => setDraft({ ...draft, id: e.target.value })} /><small className="field-help">Stable ID used by the backend integration.</small></label><label>Display name<input required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>Provider<input required maxLength={50} disabled={!creating} value={draft.provider} onChange={e => setDraft({ ...draft, provider: e.target.value })} /></label><label>Category<input required list="api-categories" maxLength={50} disabled={!creating} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} /><datalist id="api-categories">{['llm', 'search', 'embeddings', 'audio', 'images', 'storage', 'productivity', 'integration', 'custom'].map(c => <option key={c} value={c} />)}</datalist></label>
      <label>Billing method<select value={draft.billing} onChange={e => setDraft({ ...draft, billing: e.target.value as APIConfig['billing'] })}><option value="unknown">Unknown / provider reported</option><option value="free">Explicitly free</option><option value="tokens">Token based</option><option value="request">Per request</option><option value="unit">Per custom unit</option></select></label><label className="checkbox-label"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />Enable new calls</label>
      {(draft.billing === 'unit' || draft.billing === 'request') && <><label>Price (USD)<input type="number" required min="0" max="1000000" step="any" value={draft.unit_price} onChange={e => setDraft({ ...draft, unit_price: Number(e.target.value) })} /></label><label>Price per how many units?<input type="number" required min="0.000001" max="1000000000" step="any" value={draft.unit_size} onChange={e => setDraft({ ...draft, unit_size: Number(e.target.value) })} /></label>{draft.billing === 'unit' && <label>Unit name<input required maxLength={50} value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value })} placeholder="seconds, images, characters…" /></label>}</>}
      <label>Monthly spend threshold (USD)<input type="number" min="0.01" max="1000000" step="any" value={draft.monthly_budget ?? ''} onChange={e => setDraft({ ...draft, monthly_budget: e.target.value ? Number(e.target.value) : null })} placeholder="No threshold" /></label><label>Monthly call limit<input type="number" min="1" max="1000000000" step="1" value={draft.monthly_call_limit ?? ''} onChange={e => setDraft({ ...draft, monthly_call_limit: e.target.value ? Number(e.target.value) : null })} placeholder="No limit" /></label></div>
      {draft.billing === 'tokens' && <p className="field-help">Token pricing uses the provider and model rate table. <button type="button" className="text-button" onClick={onPricing}>Edit model rates</button></p>}
      <p className="field-help">Spend thresholds stop new calls once recorded month-to-date cost reaches the threshold. Unknown costs and concurrent calls can exceed it. Call limits count admitted calls, including failed attempts. Limits reset at the start of each UTC month.</p>
      <button className="button primary" disabled={busy} type="submit"><Save size={15} />{busy ? 'Saving…' : 'Save API'}</button>
    </form></Panel>}
    <Panel title="API registry" caption={`${apis.length} registered services · activity for the selected period`} action={<button className="button primary" disabled={busy} onClick={() => edit()}><Plus size={15} />Register API</button>}>
      <div className="api-grid">{apis.map(api => {
        const capped = (api.monthly_budget != null && api.monthly.cost >= api.monthly_budget) || (api.monthly_call_limit != null && api.monthly.calls >= api.monthly_call_limit);
        return <article className="api-card" key={api.id}><div className="api-card-heading"><div><h3>{api.name}</h3><small>{api.provider} · {api.category}</small></div><span className={`status ${!api.enabled || capped ? 'status-error' : 'status-success'}`}><i />{!api.enabled ? 'Paused' : capped ? 'Limit reached' : 'Enabled'}</span></div><code>{api.id}</code><p>{billingLabel(api)}</p><div className="api-card-metrics"><span><b>{number(api.stats.calls)}</b>calls</span><span><b>{api.stats.calls > 0 && api.stats.calls === api.stats.unpriced ? '—' : money(api.stats.cost, true)}</b>recorded spend</span><span><b>{number(api.stats.errors)}</b>failures</span></div><p className="field-help">{api.stats.unpriced > 0 ? `${api.stats.unpriced} calls with unknown cost. ` : ''}{api.stats.last_seen == null ? 'Awaiting instrumented activity. ' : ''}Month to date: {money(api.monthly.cost)}{api.monthly_budget ? ` / ${money(api.monthly_budget)}` : ''} · {number(api.monthly.calls)}{api.monthly_call_limit ? ` / ${number(api.monthly_call_limit)}` : ''} admitted calls.</p><div className="api-card-actions"><button className="button secondary" disabled={busy} onClick={() => edit(api)}>Configure</button><button className="button secondary" disabled={busy} onClick={() => void toggle(api)}>{api.enabled ? 'Pause' : 'Resume'}</button><button className="text-button" onClick={() => onCalls(api.id)}>Calls <ArrowRight size={13} /></button></div></article>;
      })}</div>
    </Panel>
    <p className="field-help">Controls apply to the integrations connected to each API ID. Pausing a service does not cancel requests already running. New registrations need a backend adapter; adding a registry entry alone does not add a chatbot feature.</p>
  </>;
}
