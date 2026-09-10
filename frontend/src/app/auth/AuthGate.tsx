import { useState, type FormEvent, type ReactNode } from "react";

import ZoetropeMark from "../components/ZoetropeMark";
import { useAuth } from "./AuthProvider";

type Mode = "sign_in" | "sign_up";

function SignInScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "sign_in") {
        const failure = await auth.signIn(email.trim(), password);
        if (failure) setError(failure);
      } else {
        const result = await auth.signUp(email.trim(), password);
        if (result.error) {
          setError(result.error);
        } else if (result.needsConfirmation) {
          setNotice("Check your inbox and confirm your email, then sign in.");
          setMode("sign_in");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "h-10 w-full border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground";

  return (
    <main className="min-h-screen flex items-center justify-center bg-background text-foreground px-6">
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <ZoetropeMark />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Zoetrope</h1>
            <p className="text-sm text-muted-foreground">
              {mode === "sign_in" ? "Sign in to your research workspace." : "Create your research workspace."}
            </p>
          </div>
        </div>

        <label className="block text-xs text-muted-foreground mb-1" htmlFor="auth-email">
          Email
        </label>
        <input
          id="auth-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={`${inputClass} mb-4`}
        />

        <label className="block text-xs text-muted-foreground mb-1" htmlFor="auth-password">
          Password
        </label>
        <input
          id="auth-password"
          type="password"
          required
          minLength={6}
          autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={`${inputClass} mb-6`}
        />

        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
        {notice && <p className="mb-4 text-sm text-muted-foreground">{notice}</p>}

        <button
          type="submit"
          disabled={busy}
          className="h-10 w-full bg-foreground text-background text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Please wait..." : mode === "sign_in" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "sign_in" ? "sign_up" : "sign_in");
            setError("");
            setNotice("");
          }}
          className="mt-4 w-full text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === "sign_in" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}

/** Shows the app only to a signed-in user; passes through when sign-in is not configured. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === "disabled" || status === "signed_in") {
    return <>{children}</>;
  }

  if (status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        Restoring your session...
      </main>
    );
  }

  return <SignInScreen />;
}
