import type { APIConfig, Dashboard, Event, Filters, Issue, Metrics, Settings } from './types';

export const demoAPIs: APIConfig[] = [
  { id: 'openai-chat', name: 'OpenAI chat', provider: 'openai', category: 'llm', billing: 'tokens' },
  { id: 'sample-search', name: 'Research search', provider: 'example-search', category: 'search', billing: 'request', unit_price: .004 },
  { id: 'sample-audio', name: 'Transcription', provider: 'example-audio', category: 'audio', billing: 'unit', unit: 'seconds', unit_price: .01, unit_size: 60 },
  { id: 'notion', name: 'Notion', provider: 'notion', category: 'productivity', billing: 'unknown' },
].map(a => ({ enabled: true, unit: 'request', unit_price: 0, unit_size: 1, monthly_budget: null, monthly_call_limit: null, ...a })) as APIConfig[];
export function saveDemoAPI(value: APIConfig) {
  const index = demoAPIs.findIndex(a => a.id === value.id);
  if (index < 0) demoAPIs.push(value); else demoAPIs[index] = value;
}

export const demoSettings: Settings = { monthly_budget: 100, alert_percent: 80, rates: [
  { provider: 'openai', model: 'gpt-5', input: 1.25, cached: .125, output: 10 },
  { provider: 'openai', model: 'gpt-5-mini', input: .25, cached: .025, output: 2 },
  { provider: 'openai', model: 'gpt-4o-mini', input: .15, cached: .075, output: .6 },
] };
const actors = ['Maya Chen', 'Alex Rivera', 'Sam Patel', 'Jordan Lee', 'Taylor Kim', 'Local developer'];
const routes = ['POST /chat', 'POST /agent/chat', 'POST /visualizer/generate-scene', 'POST /variants/chat', 'POST /ingest/url'];
const tools = ['research.search_library', 'app.papers', 'api.visualizer.generate_scene', 'research.compare_papers', 'api.ingest.ingest_url'];
const now = Date.now() / 1000;
const today = Math.floor(now / 86400) * 86400;
export const demoEvents: Event[] = [];

function event(part: Partial<Event>): Event {
  return { id: '', request_id: '', parent_id: null, kind: 'llm', name: '', provider: '', model: '', user_id: '', user_email: '',
    api_id: '', category: '', billing_unit: '', units: null, admitted: 1,
    started_at: now, ended_at: now, duration_ms: 0, status: 'success', http_status: null, input_tokens: null, output_tokens: null,
    cached_tokens: null, cost_usd: null, cost_source: 'unknown', error_type: '', error: '', fingerprint: '', metadata: {}, source: 'demo', ...part };
}
for (let day = 13; day >= 0; day--) {
  const count = 29 + ((13 - day) * 7 % 24);
  for (let i = 0; i < count; i++) {
    const serial = day * 100 + i;
    const time = day === 0 ? today + Math.max(0, now - today - 35) * ((i + 1) / count) : today - day * 86400 + 8 * 3600 + i / count * 13 * 3600;
    const actor = serial % actors.length;
    const route = serial % routes.length;
    const root = `demo-request-${day}-${i}`;
    const failed = serial % 27 === 3;
    const base = { request_id: root, user_id: `user-${actor}`, user_email: `${actors[actor].toLowerCase().replace(' ', '.')}@example.test` };
    demoEvents.push(event({ ...base, id: root, name: routes[route], kind: 'http', started_at: time, ended_at: time + 7.4, duration_ms: 7400,
      status: failed ? 'error' : 'success', http_status: failed ? 502 : 200, error_type: failed ? 'HTTP 502' : '', error: failed ? 'Model provider did not respond in time.' : '', fingerprint: failed ? `http-error-${route}` : '' }));
    demoEvents.push(event({ ...base, id: `${root}-tool`, parent_id: root, name: tools[route], kind: 'tool', started_at: time + .02, ended_at: time + .8, duration_ms: 780 }));
    for (let step = 0; step < (route === 1 ? 3 : 1); step++) {
      const rate = demoSettings.rates[(serial + step) % 3];
      const input = 11000 + serial % 14000;
      const output = 2200 + serial % 700;
      const cached = serial % 3 === 0 ? 7000 : 0;
      const failure = failed && step === 0;
      const duration = 1800 + (serial * 43 % 5200);
      demoEvents.push(event({ ...base, id: `${root}-llm-${step}`, parent_id: root, name: rate.model, model: rate.model, provider: rate.provider,
        api_id: 'openai-chat', category: 'llm', billing_unit: 'tokens',
        started_at: time + .85 + step * .2, ended_at: time + .85 + duration / 1000, duration_ms: duration, status: failure ? 'error' : 'success',
        input_tokens: failure ? null : input, output_tokens: failure ? null : output, cached_tokens: failure ? null : cached,
        cost_usd: failure ? null : ((input - cached) * rate.input + cached * rate.cached + output * rate.output) / 1e6,
        cost_source: failure ? 'unknown' : 'estimated', error_type: failure ? 'TimeoutError' : '', error: failure ? 'The model request exceeded the configured timeout. Try a shorter context or check the provider status.' : '',
        fingerprint: failure ? `model-timeout-${rate.model}` : '', metadata: { service_tier: 'default' } }));
    }
    if (i % 3 === 0) demoEvents.push(event({ ...base, id: `${root}-search`, parent_id: root, kind: 'api', name: 'Search papers', api_id: 'sample-search', category: 'search', provider: 'example-search', started_at: time + .1, units: 1, billing_unit: 'request', cost_usd: .004, cost_source: 'estimated', duration_ms: 240 }));
    if (i % 7 === 0) demoEvents.push(event({ ...base, id: `${root}-audio`, parent_id: root, kind: 'api', name: 'Transcribe audio', api_id: 'sample-audio', category: 'audio', provider: 'example-audio', started_at: time + .2, units: 90, billing_unit: 'seconds', cost_usd: .015, cost_source: 'estimated', duration_ms: 1200 }));
  }
}
demoEvents.sort((a, b) => b.started_at - a.started_at);
const resolved = new Set<string>();
export function resolveDemo(fingerprint: string, value: boolean) { value ? resolved.add(fingerprint) : resolved.delete(fingerprint); }

export function metrics(events: Event[]): Metrics {
  const calls = events.filter(e => ['llm', 'api'].includes(e.kind));
  const measured = calls.filter(e => e.duration_ms != null);
  return { events: events.length, calls: calls.length, requests: events.filter(e => ['http', 'websocket'].includes(e.kind) && !e.parent_id).length,
    errors: events.filter(e => e.status === 'error').length, running: events.filter(e => e.status === 'running').length,
    cost: calls.reduce((sum, e) => sum + (e.cost_usd ?? 0), 0), unpriced: calls.filter(e => e.cost_usd == null).length,
    input_tokens: calls.reduce((sum, e) => sum + (e.input_tokens ?? 0), 0), output_tokens: calls.reduce((sum, e) => sum + (e.output_tokens ?? 0), 0),
    cached_tokens: calls.reduce((sum, e) => sum + (e.cached_tokens ?? 0), 0), latency_ms: measured.length ? measured.reduce((sum, e) => sum + e.duration_ms!, 0) / measured.length : null };
}
export function filteredDemo(days: number, filters: Filters): Event[] {
  const start = today - (days - 1) * 86400;
  return demoEvents.filter(e => e.started_at >= start && (!filters.kind || e.kind === filters.kind) && (!filters.status || e.status === filters.status)
    && (!filters.user_id || e.user_id === filters.user_id) && (!filters.model || e.model === filters.model)
    && (!filters.api_id || e.api_id === filters.api_id) && (!filters.provider || e.provider === filters.provider) && (!filters.category || e.category === filters.category)
    && (!filters.query || [e.name, e.model, e.user_email, e.id, e.error].some(v => v.toLowerCase().includes(filters.query.toLowerCase()))));
}
export function demoDashboard(days: number, filters: Filters, offset: number): Dashboard {
  const start = today - (days - 1) * 86400;
  const events = demoEvents.filter(e => e.started_at >= start);
  const selected = filteredDemo(days, filters);
  const modelNames = [...new Set(events.filter(e => e.kind === 'llm').map(e => e.model))];
  const userIds = [...new Set(events.map(e => e.user_id))];
  const issueGroups = [...new Set(events.filter(e => e.status === 'error').map(e => e.fingerprint))];
  const issues: Issue[] = issueGroups.map(fingerprint => {
    const group = events.filter(e => e.fingerprint === fingerprint); const latest = group[0];
    return { fingerprint, name: latest.name, kind: latest.kind, error_type: latest.error_type, error: latest.error, occurrences: group.length,
      users: new Set(group.map(e => e.user_id)).size, last_seen: latest.started_at, event_id: latest.id, resolved: resolved.has(fingerprint) ? 1 : 0 };
  }).sort((a, b) => b.last_seen - a.last_seen);
  return {
    apis: demoAPIs.map(api => {
      const group = events.filter(e => e.api_id === api.id);
      const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
      const monthly = metrics(demoEvents.filter(e => e.api_id === api.id && e.started_at >= month.getTime() / 1000));
      return { ...api, stats: { ...metrics(group), last_seen: group.length ? Math.max(...group.map(e => e.started_at)) : null }, monthly: { cost: monthly.cost, calls: monthly.calls } };
    }),
    overview: { stats: { ...metrics(events), users: userIds.length }, previous: metrics(demoEvents.filter(e => e.started_at >= start - days * 86400 && e.started_at < start)),
      monthly: metrics(demoEvents.filter(e => new Date(e.started_at * 1000).getUTCMonth() === new Date().getUTCMonth())),
      models: modelNames.map(model => ({ ...metrics(events.filter(e => e.kind === 'llm' && e.model === model)), model, provider: 'openai' })).sort((a, b) => b.cost - a.cost),
      areas: routes.map(name => ({ ...metrics(events.filter(e => e.kind === 'http' && e.name === name)), name })),
      series: Array.from({ length: days === 1 ? 24 : days }, (_, i) => {
        const bucketStart = start + i * (days === 1 ? 3600 : 86400); const bucketEnd = bucketStart + (days === 1 ? 3600 : 86400);
        return { ...metrics(events.filter(e => e.started_at >= bucketStart && e.started_at < bucketEnd)), bucket: new Date(bucketStart * 1000).toISOString() };
      }), settings: structuredClone(demoSettings), generated_at: now, first_event_at: demoEvents.at(-1)!.started_at, timezone: 'UTC' },
    events: { events: selected.slice(offset, offset + 25), total: selected.length, offset, limit: 25 },
    users: userIds.map(user_id => { const group = events.filter(e => e.user_id === user_id); return { ...metrics(group), user_id, email: group[0].user_email, last_seen: group[0].started_at }; }).sort((a, b) => b.cost - a.cost),
    issues, connection: { telemetry_enabled: true, events_stored: demoEvents.length, langsmith_configured: false, langsmith_project: 'research-chatbot',
      pricing_source: 'https://developers.openai.com/api/docs/pricing', pricing_verified: '2026-10-01', storage: 'Sample data in your browser',
      coverage: 'HTTP, assistant WebSocket connections, LangChain chat models, retrieval and catalog tools', excluded: 'Direct provider SDK calls, external scripts, and live transcription audio billing' },
  };
}
