import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";

import { UNAUTHORIZED_EVENT, getAuthMe, setAccessTokenProvider } from "../api";
import { authEnabled, supabase } from "./supabase";

export type AuthStatus = "disabled" | "loading" | "signed_out" | "signed_in";

export type AuthUser = {
  id: string;
  email: string;
};

type AuthValue = {
  status: AuthStatus;
  user: AuthUser | null;
  /** "admin" or "user"; "admin" when sign-in is disabled (local development). */
  role: string;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

function toUser(session: Session | null): AuthUser | null {
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? "" };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(authEnabled ? "loading" : "disabled");
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string>(authEnabled ? "user" : "admin");
  // The API layer reads the token synchronously on every request, so it has
  // to come from a ref rather than the state captured by an older closure.
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    setAccessTokenProvider(() => sessionRef.current?.access_token ?? null);
    const client = supabase;
    if (!client) {
      // Sign-in disabled: the backend acts as one local administrator. Asking
      // it who we are also adopts any data written before accounts existed.
      void getAuthMe()
        .then((me) => setRole(me.role))
        .catch(() => setRole("admin"));
      return;
    }

    let active = true;
    let knownUser = "";
    const apply = (next: Session | null) => {
      sessionRef.current = next;
      if (!active) return;
      setSession(next);
      setStatus(next ? "signed_in" : "signed_out");
      // The role lives in the token's app_metadata, which the backend reads;
      // asking it once per sign-in also lets an admin adopt pre-account data.
      const userId = next?.user?.id ?? "";
      if (userId && userId !== knownUser) {
        knownUser = userId;
        void getAuthMe()
          .then((me) => {
            if (active && sessionRef.current?.user?.id === me.id) setRole(me.role);
          })
          .catch(() => {
            if (active) setRole("user");
          });
      } else if (!userId) {
        knownUser = "";
        setRole("user");
      }
    };

    void client.auth.getSession().then(({ data }) => apply(data.session));
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => apply(next));

    // A 401 from the API means the token is stale: refresh once, otherwise
    // fall back to the sign-in screen instead of failing every request.
    const onUnauthorized = () => {
      void client.auth.refreshSession().then(({ data, error }) => {
        if (error || !data.session) void client.auth.signOut();
      });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);

    return () => {
      active = false;
      listener.subscription.unsubscribe();
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return "Sign-in is not configured.";
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!supabase) return { error: "Sign-in is not configured.", needsConfirmation: false };
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error: error.message, needsConfirmation: false };
    return { error: null, needsConfirmation: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user: toUser(session),
      role,
      isAdmin: role === "admin",
      signIn,
      signUp,
      signOut,
    }),
    [status, session, role, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}
