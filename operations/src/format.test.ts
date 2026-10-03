import { describe, expect, it } from 'vitest';
import { csv, money } from './format';
import { demoDashboard, filteredDemo, metrics } from './demo';
import type { Event } from './types';

describe('honest costs and telemetry export', () => {
  it('distinguishes a zero cost from an unavailable or tiny cost', () => {
    expect(money(null)).toBe('—');
    expect(money(0)).toBe('$0.00');
    expect(money(.000003, true)).toBe('<$0.0001');
  });
  it('neutralizes spreadsheet formulas while preserving quoted CSV fields', () => {
    const result = csv([{ name: '=HYPERLINK("url")', error: 'a,b\nnext line', cost: null }], ['name', 'error', 'cost']);
    expect(result).toContain('"\'=HYPERLINK(""url"")"');
    expect(result).toContain('"a,b\nnext line"');
  });
  it('counts outbound model and API leaves without adding parent span costs', () => {
    const result = metrics([{ kind: 'http', cost_usd: 100, status: 'success' }, { kind: 'llm', cost_usd: 1.2, status: 'success' }, { kind: 'api', cost_usd: .3, status: 'success' }, { kind: 'llm', cost_usd: null, status: 'error' }] as Event[]);
    expect(result.cost).toBe(1.5);
    expect(result.unpriced).toBe(1);
    expect(result.calls).toBe(3);
  });
  it('filters service, provider and category consistently', () => {
    const filters = { kind: 'api', status: '', query: '', model: '', user_id: '', api_id: 'sample-audio', provider: 'example-audio', category: 'audio' };
    const snapshot = demoDashboard(7, filters, 0);
    expect(snapshot.events.total).toBeGreaterThan(0);
    expect(snapshot.events.total).toBe(filteredDemo(7, filters).length);
    expect(snapshot.events.events.every(e => e.api_id === 'sample-audio' && e.billing_unit === 'seconds')).toBe(true);
  });
  it('keeps filtered export and pagination totals consistent', () => {
    const filters = { kind: 'llm', status: 'error', query: '', model: '', user_id: '' };
    const snapshot = demoDashboard(7, filters, 0);
    expect(snapshot.events.total).toBe(filteredDemo(7, filters).length);
    expect(snapshot.events.events.every(e => e.kind === 'llm' && e.status === 'error')).toBe(true);
    expect(snapshot.overview.stats.cost).toBeGreaterThan(0);
  });
});
