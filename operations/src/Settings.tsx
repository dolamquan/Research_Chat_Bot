import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Download, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { request } from './api';
import { demoSettings } from './demo';
import type { Connection, Settings as SettingsType } from './types';
import { Panel } from './ui';

export function Settings({ value, connection, demo, onSave, notify }: { value: SettingsType; connection: Connection; demo: boolean; onSave: () => void; notify: (message: string) => void }) {
  const [settings, setSettings] = useState(() => structuredClone(value));
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setSettings(structuredClone(value)); }, [value, dirty]);
  function edit(next: SettingsType) { setDirty(true); setSettings(next); }
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const invalid = !Number.isFinite(settings.monthly_budget) || settings.monthly_budget <= 0 || settings.alert_percent < 1 || settings.alert_percent > 100 || settings.rates.some(r => !r.model.trim() || !r.provider.trim() || [r.input, r.cached, r.output].some(n => !Number.isFinite(n) || n < 0));
      if (invalid) throw new Error('Enter a positive budget, an alert between 1–100%, and nonnegative rates with a provider and model.');
      if (new Set(settings.rates.map(r => `${r.provider}:${r.model}`)).size !== settings.rates.length) throw new Error('Each provider and model must have a unique rate.');
      if (demo) Object.assign(demoSettings, structuredClone(settings));
      else await request('/ops/settings', { method: 'PUT', body: JSON.stringify(settings) });
      setDirty(false); notify(demo ? 'Sample settings updated in this preview.' : 'Settings saved. New rates apply to future calls.'); onSave();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }
  async function importHistory() {
    setImporting(true); setError('');
    try {
      const result = await request<{ imported: number; skipped: number; capped: boolean }>('/ops/import-langsmith', { method: 'POST', body: JSON.stringify({ days: 7 }), signal: AbortSignal.timeout(120000) });
      notify(`Imported ${result.imported} calls; ${result.skipped} already recorded.${result.capped ? ' Reached the 1,000-run import limit.' : ''}`); onSave();
    } catch (e) { setError(e instanceof Error ? e.message : 'Import failed.'); }
    finally { setImporting(false); }
  }
  return <div className="settings-layout"><form onSubmit={submit}>
    <Panel title="Budget & alerts" caption="Keep spending within sight"><div className="settings-body"><div className="field-grid"><label>Monthly budget (USD)<div className="input-prefix"><span>$</span><input type="number" min="0.01" max="1000000" step="0.01" required value={settings.monthly_budget} onChange={e => edit({ ...settings, monthly_budget: Number(e.target.value) })} /></div></label><label>Alert threshold (%)<input type="number" min="1" max="100" required value={settings.alert_percent} onChange={e => edit({ ...settings, alert_percent: Number(e.target.value) })} /></label></div><p className="field-help">An alert appears in your dashboard when estimated month-to-date spend reaches this threshold. The budget does not block API calls.</p></div></Panel>
    <Panel title="Model pricing" caption="USD per 1 million tokens · standard processing"><div className="pricing-scroll"><table className="pricing-table"><thead><tr><th>Provider / model</th><th>Input</th><th>Cached input</th><th>Output</th><th /></tr></thead><tbody>{settings.rates.map((rate, i) => <tr key={i}><td><input aria-label={`Provider ${i + 1}`} required value={rate.provider} onChange={e => edit({ ...settings, rates: settings.rates.map((r, j) => j === i ? { ...r, provider: e.target.value } : r) })} /><input aria-label={`Model ${i + 1}`} required value={rate.model} onChange={e => edit({ ...settings, rates: settings.rates.map((r, j) => j === i ? { ...r, model: e.target.value } : r) })} /></td>{(['input', 'cached', 'output'] as const).map(key => <td key={key}><input type="number" min="0" max="10000" step="any" required aria-label={`${key} rate ${i + 1}`} value={rate[key]} onChange={e => edit({ ...settings, rates: settings.rates.map((r, j) => j === i ? { ...r, [key]: Number(e.target.value) } : r) })} /></td>)}<td><button type="button" className="icon-button" aria-label={`Remove pricing for ${rate.model}`} onClick={() => edit({ ...settings, rates: settings.rates.filter((_, j) => i !== j) })}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div><div className="settings-body pricing-bottom"><button type="button" className="button secondary" onClick={() => edit({ ...settings, rates: [...settings.rates, { provider: 'openai', model: '', input: 0, cached: 0, output: 0 }] })}><Plus size={15} />Add model</button><a href={connection.pricing_source} target="_blank" rel="noreferrer">Official pricing <ArrowUpRight size={13} /></a><p className="field-help">Defaults verified {connection.pricing_verified}. Rates apply to future calls; recorded estimates stay as captured. Unknown models, missing usage, audio, cache writes, and nonstandard service tiers remain unpriced.</p></div></Panel>
    {error && <div className="notice error-notice" role="alert">{error}</div>}<div className="save-row"><span>{dirty ? 'You have unsaved changes' : 'Settings are up to date'}</span><button className="button primary" type="submit" disabled={busy || !dirty}><Save size={15} />{busy ? 'Saving…' : 'Save settings'}</button></div>
  </form><div><Panel title="Connections" caption="Your monitoring sources"><div className="settings-body"><div className="connection-row"><span className="source-icon">Z</span><div><b>Local telemetry</b><small>{connection.storage}</small></div><span className={`connection-dot ${connection.telemetry_enabled ? 'connected' : ''}`} /></div><div className="connection-detail"><Check size={14} /><span>{connection.events_stored.toLocaleString()} events stored</span></div><div className="connection-row"><span className="source-icon langsmith">L</span><div><b>LangSmith</b><small>{connection.langsmith_configured ? connection.langsmith_project : 'Not configured'}</small></div><span className={`connection-dot ${connection.langsmith_configured ? 'connected' : ''}`} /></div><button className="button secondary full-width" type="button" disabled={demo || importing || !connection.langsmith_configured} onClick={() => void importHistory()}><Download size={15} />{importing ? 'Importing history…' : 'Import last 7 days'}</button><p className="field-help">Imports up to 1,000 LLM calls from the server’s LangSmith project. Repeat imports skip calls already recorded. Earlier activity may have no user attribution.</p></div></Panel>
    <Panel title="What gets recorded" caption="Useful metadata, less noise"><div className="settings-body"><div className="privacy-heading"><ShieldCheck size={18} /><b>Administrator access only</b></div><p className="field-help">{connection.coverage}.</p><p className="field-help">Model prompts, responses, request bodies, query strings, and authorization headers are not saved. Error messages are shortened and credentials are redacted.</p><div className="coverage-note"><b>Coverage limits</b><p>{connection.excluded}. Totals describe recorded calls, rather than your provider invoice.</p></div></div></Panel></div></div>;
}
