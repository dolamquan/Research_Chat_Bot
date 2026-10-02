import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, BarChart3, ShieldCheck } from 'lucide-react';
import { ApiError, getIdentity, request, supabase } from './api';
import { Loading } from './ui';
import type { Identity } from './types';

export function Auth({ children }: { children: (identity: Identity) => ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function connect() {
    setLoading(true); setError('');
    try {
      const config = await request<{ mode: string }>('/auth/config');
      if (config.mode !== 'disabled') {
        const session = supabase ? await supabase.auth.getSession() : null;
        if (!session?.data.session) {
          setNeedsLogin(true);
          if (!supabase) setError('Use the same VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY as the chatbot in frontend/.env, then restart Research Ops.');
          return;
        }
      }
      setIdentity(await getIdentity()); setNeedsLogin(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
      if (e instanceof ApiError && e.status === 401) setNeedsLogin(true);
    } finally { setLoading(false); }
  }
  useEffect(() => {
    void connect();
    const subscription = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { setIdentity(null); setNeedsLogin(true); }
    });
    return () => subscription?.data.subscription.unsubscribe();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (!supabase) throw new Error('Supabase sign-in is not configured.');
      const result = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      await connect();
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }
  if (identity) return children(identity);
  if (loading) return <div className="auth-page"><Loading /></div>;
  return <main className="auth-page"><section className="auth-card"><div className="brand-symbol"><BarChart3 size={24} /></div><span className="eyebrow">ZOETROPE / RESEARCH OPS</span><h1>Your workspace,<br />behind the scenes.</h1><p>One clear view of your API costs, calls, and research activity.</p>
    {needsLogin && supabase && <form onSubmit={submit}><label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><button className="button primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to Research Ops'}<ArrowRight size={16} /></button></form>}
    {error && <div className="notice error-notice" role="alert">{error}</div>}
    {!needsLogin && <button className="button primary" onClick={() => void connect()}>Reconnect <ArrowRight size={16} /></button>}
    <a className="button secondary" href="?demo=1">Explore with sample data <ArrowRight size={16} /></a><div className="auth-note"><ShieldCheck size={15} />Administrator account required for live data.</div>
    {supabase && error.includes('Administrator') && <button className="text-button" onClick={async () => { await supabase?.auth.signOut(); setNeedsLogin(true); setError(''); }}>Sign in with a different account</button>}
  </section><div className="auth-decoration"><span>RESEARCH, OBSERVED.</span><div className="auth-bars">{[38, 52, 44, 66, 53, 77, 68, 88, 74, 96, 83, 100].map((v, i) => <i key={i} style={{ height: `${v}%` }} />)}</div><p>A little less noise.<br />A lot more clarity.</p></div></main>;
}
