"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthNav } from "@/components/auth/AuthNavProvider";

export function AccountLogoutButton() {
  const router = useRouter();
  const { clearToGuest } = useAuthNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not sign out.");
        return;
      }
      clearToGuest();
      router.push("/login");
      router.refresh();
    } catch {
      setError("Could not sign out.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
