"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuthNav } from "@/components/auth/AuthNavProvider";
import { homePathForRole } from "@/lib/auth/homePath";

export default function LoginPage() {
  const router = useRouter();
  const { status, user, refresh } = useAuthNav();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "authenticated" && user) {
      router.replace(homePathForRole(user.role));
    }
  }, [status, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        user?: { role?: string };
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Login failed");
        return;
      }
      await refresh();
      router.push(homePathForRole(data.user?.role));
      router.refresh();
    } catch {
      setError("Login failed");
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading" || status === "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
        <p className="text-sm text-zinc-600" role="status">
          {status === "authenticated"
            ? "Redirecting…"
            : "Checking session…"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="w-full max-w-md space-y-4 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
        aria-labelledby="login-heading"
      >
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            TRONX
          </p>
          <h1
            id="login-heading"
            className="text-xl font-semibold tracking-tight text-zinc-900"
          >
            Sign in
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-zinc-600">
            Sign in with your TRONX email and password. Google OAuth is not used
            for app login — Super Admin connects Google Business Profile under
            GMB after sign-in.
          </p>
        </div>
        <label className="block text-sm">
          <span className="font-medium text-zinc-800">Email</span>
          <input
            type="email"
            required
            id="login-email"
            name="email"
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            aria-required="true"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-zinc-800">Password</span>
          <input
            type="password"
            required
            id="login-password"
            name="password"
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-required="true"
          />
        </label>
        {error && (
          <p
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800"
            role="alert"
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-center text-sm text-zinc-500">
          <Link href="/" className="underline hover:text-zinc-800">
            Back to home
          </Link>
        </p>
      </form>
    </div>
  );
}
