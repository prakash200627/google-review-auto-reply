"use client";

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

/** Bounded wait so a stalled Mongo-backed /api/auth/me cannot freeze the navbar. */
export const AUTH_ME_TIMEOUT_MS = 8_000;

export type AuthNavRole = "superadmin" | "business_owner";

export type AuthNavUser = {
  id: string;
  email: string;
  role: AuthNavRole;
};

export type AuthNavStatus = "loading" | "guest" | "authenticated";

export type AuthNavContextValue = {
  status: AuthNavStatus;
  user: AuthNavUser | null;
  /** Soft failure reason for UI only — never a token or secret. */
  error: string | null;
  /** Re-fetch /api/auth/me (e.g. after login). Does not trust client-supplied roles. */
  refresh: () => Promise<void>;
  /** Drop to guest UI after logout (server session clear is authoritative). */
  clearToGuest: () => void;
};

const AuthNavContext = createContext<AuthNavContextValue | null>(null);

type MeResponse = {
  success?: boolean;
  user?: {
    id?: string;
    email?: string;
    role?: string;
  };
};

function mapUser(data: MeResponse): AuthNavUser | null {
  if (!data.success || !data.user?.id || !data.user?.email) return null;
  const role =
    data.user.role === "superadmin" ? "superadmin" : "business_owner";
  // Only accept roles the server returned on a successful me payload.
  if (data.user.role !== "superadmin" && data.user.role !== "business_owner") {
    return null;
  }
  return {
    id: data.user.id,
    email: data.user.email,
    role,
  };
}

type AuthMeResult =
  | { ok: true; user: AuthNavUser }
  | { ok: false; reason: "unauthorized" | "timeout" | "network" | "invalid" };

/** Deduplicate concurrent default /api/auth/me calls (e.g. React Strict Mode). */
let sharedDefaultMe: Promise<AuthMeResult> | null = null;

/**
 * Fetch /api/auth/me with AbortSignal timeout.
 * Exported for unit tests — navigation must not invent roles.
 */
export async function fetchAuthMe(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = AUTH_ME_TIMEOUT_MS
): Promise<AuthMeResult> {
  const useShared = fetchImpl === fetch;
  if (useShared && sharedDefaultMe) {
    return sharedDefaultMe;
  }

  const run = (async (): Promise<AuthMeResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl("/api/auth/me", {
        credentials: "same-origin",
        signal: controller.signal,
      });
      let data: MeResponse = {};
      try {
        data = (await res.json()) as MeResponse;
      } catch {
        return { ok: false, reason: "invalid" };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: "unauthorized" };
      }
      if (!res.ok) {
        return { ok: false, reason: "invalid" };
      }
      const user = mapUser(data);
      if (!user) return { ok: false, reason: "invalid" };
      return { ok: true, user };
    } catch (err) {
      const aborted =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      return { ok: false, reason: aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  })();

  if (useShared) {
    sharedDefaultMe = run.finally(() => {
      sharedDefaultMe = null;
    });
    return sharedDefaultMe;
  }
  return run;
}

export function AuthNavProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthNavStatus>("loading");
  const [user, setUser] = useState<AuthNavUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const applyResult = useCallback(
    (
      generation: number,
      result: Awaited<ReturnType<typeof fetchAuthMe>>
    ) => {
      if (generation !== generationRef.current) return;
      if (result.ok) {
        setUser(result.user);
        setStatus("authenticated");
        setError(null);
        return;
      }
      setUser(null);
      setStatus("guest");
      if (result.reason === "timeout") {
        setError("session_check_timeout");
      } else if (result.reason === "network") {
        setError("session_check_failed");
      } else {
        setError(null);
      }
    },
    []
  );

  // Mount: initial status is already "loading"; only update after the fetch settles.
  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    void (async () => {
      const result = await fetchAuthMe();
      if (cancelled) return;
      applyResult(generation, result);
    })();
    return () => {
      cancelled = true;
      generationRef.current += 1;
    };
  }, [applyResult]);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setStatus("loading");
    setError(null);
    const result = await fetchAuthMe();
    applyResult(generation, result);
  }, [applyResult]);

  const clearToGuest = useCallback(() => {
    generationRef.current += 1;
    setUser(null);
    setStatus("guest");
    setError(null);
  }, []);

  const value = useMemo<AuthNavContextValue>(
    () => ({
      status,
      user,
      error,
      refresh,
      clearToGuest,
    }),
    [status, user, error, refresh, clearToGuest]
  );

  return (
    <AuthNavContext.Provider value={value}>{children}</AuthNavContext.Provider>
  );
}

export function useAuthNav(): AuthNavContextValue {
  const ctx = useContext(AuthNavContext);
  if (!ctx) {
    throw new Error("useAuthNav must be used within AuthNavProvider");
  }
  return ctx;
}
