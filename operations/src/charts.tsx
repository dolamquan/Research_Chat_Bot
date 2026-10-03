import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Overview } from './types';
import { colors, Empty, Panel } from './ui';
import { compact, money, number } from './format';

export function SpendChart({ overview, days, large = false }: { overview: Overview; days: number; large?: boolean }) {
  const [mode, setMode] = useState<'cost' | 'calls'>('cost');
  const data = overview.series.map(s => ({ ...s, label: new Date(s.bucket).toLocaleString('en-US', days === 1 ? { hour: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' }) }));
  return <Panel title={mode === 'cost' ? 'Spending over time' : 'API calls over time'} caption={`${days === 1 ? 'Today' : `Last ${days} days`} · UTC · ${mode === 'cost' ? 'estimated USD' : 'outbound calls'}`} className="spend-panel" action={<div className="segmented"><button className={mode === 'cost' ? 'selected' : ''} onClick={() => setMode('cost')}>Spend</button><button className={mode === 'calls' ? 'selected' : ''} onClick={() => setMode('calls')}>Calls</button></div>}>
    <div className="chart-summary"><strong>{mode === 'cost' ? money(overview.stats.cost) : number(overview.stats.calls)}</strong><span>{mode === 'cost' ? 'total estimated spend' : 'total outbound calls'}</span></div>
    {overview.stats.events === 0 ? <Empty title="Your first call starts the story">Use the research chatbot and this chart will start filling in.</Empty> : <div className="spend-chart" style={{ height: large ? 300 : 226 }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ top: 8, right: 18, bottom: 0, left: 0 }}>
      <defs><linearGradient id="spend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#278d72" stopOpacity={.2} /><stop offset="100%" stopColor="#278d72" stopOpacity={.015} /></linearGradient></defs>
      <CartesianGrid stroke="#edf0ed" strokeDasharray="3 4" vertical={false} />
      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#90968f', fontSize: 11 }} minTickGap={30} dy={10} />
      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#90968f', fontSize: 11 }} width={50} tickFormatter={v => mode === 'cost' ? money(v) : compact(v)} />
      <Tooltip contentStyle={{ border: '1px solid #e4e8e2', borderRadius: 10, fontSize: 12, boxShadow: '0 5px 20px #152c2510' }} formatter={(v: number) => [mode === 'cost' ? money(v, true) : number(v), mode === 'cost' ? 'Estimated spend' : 'API calls']} />
      <Area type="monotone" dataKey={mode} stroke="#227e65" strokeWidth={2.5} fill="url(#spend-fill)" activeDot={{ r: 5, fill: '#227e65', stroke: 'white', strokeWidth: 3 }} />
    </AreaChart></ResponsiveContainer></div>}
    <div className="chart-footer"><span><i className="legend-dot" />{mode === 'cost' ? 'All recorded APIs' : 'API calls'}</span><span>{overview.stats.unpriced > 0 ? `${overview.stats.unpriced} calls have unknown cost` : 'Based on recorded usage'}</span></div>
  </Panel>;
}
export function ModelChart({ overview, onModel }: { overview: Overview; onModel: (model: string) => void }) {
  const positive = overview.models.filter(m => m.cost > 0);
  const modelCost = overview.models.reduce((sum, m) => sum + m.cost, 0);
  return <Panel title="Spend by model" caption="Token-based model spend" className="model-panel">
    {overview.models.length === 0 ? <Empty title="No models recorded yet">Model usage appears here after a call.</Empty> : <><div className="donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={positive} dataKey="cost" nameKey="model" cx="50%" cy="50%" innerRadius={62} outerRadius={82} paddingAngle={positive.length > 1 ? 4 : 0} stroke="none" onClick={d => onModel(d.model)}>{positive.map((m, i) => <Cell key={m.model} fill={colors[i % colors.length]} />)}</Pie><Tooltip formatter={(v: number) => [money(v, true), 'Estimated spend']} contentStyle={{ borderRadius: 10, border: '1px solid #e4e8e2', fontSize: 12 }} /></PieChart></ResponsiveContainer><div className="donut-center"><span>Model spend</span><strong>{money(modelCost)}</strong><small>{overview.models.length} models</small></div></div>
    <div className="model-legend">{overview.models.slice(0, 5).map((m, i) => <button key={m.provider + m.model} onClick={() => onModel(m.model)}><span><i style={{ background: colors[i % colors.length] }} />{m.model}</span><b>{money(m.cost)}<small>{modelCost > 0 ? `${(m.cost / modelCost * 100).toFixed(0)}%` : '—'}</small></b></button>)}</div></>}
  </Panel>;
}
