"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { SafeGoogleStatus } from "@/lib/google/connectionStatus";

function connectionHeadline(status: SafeGoogleStatus): {
  title: string;
  detail: string;
  tone: "ok" | "warn" | "neutral";
} {
  const conn = status.connection;
  if (!status.oauthConfigured) {
    return {
      title: "Not connected",
      detail:
        "Google OAuth is not configured on the server. An administrator must set OAuth environment variables before anyone can connect.",
      tone: "neutral",
    };
  }
  if (!conn) {
    return {
      title: "Not connected",
      detail:
        "No usable Google connection is stored for this workspace yet. Connect once with Google consent; later TRONX logins reuse the stored encrypted tokens (refreshed server-side). OAuth does not start automatically on login.",
      tone: "neutral",
    };
  }
  if (conn.status === "active") {
    return {
      title: "Connected",
      detail: conn.email
        ? `Using Google account ${conn.email}. Access tokens are refreshed on the server and never sent to the browser.`
        : "A usable Google connection is stored. Access tokens are refreshed on the server and never sent to the browser.",
      tone: "ok",
    };
  }
  if (conn.status === "revoked") {
    return {
      title: "Disconnected",
      detail:
        conn.lastError ||
        "The platform Google connection was disconnected. Local credentials are cleared and not usable. Live sync and publishing stay offline until you reconnect. Existing locations, businesses, and reviews were kept.",
      tone: "warn",
    };
  }
  return {
    title: "Reconnect required",
    detail:
      conn.lastError ||
      "The stored credentials are missing, revoked, invalid, or insufficiently scoped. Connect again with Google consent.",
    tone: "warn",
  };
}

export function GoogleConnectPanel({
  initialStatus,
  role,
  businessId,
  allowConnect = role === "superadmin",
}: {
  initialStatus: SafeGoogleStatus;
  role: "superadmin" | "business_owner";
  businessId?: string | null;
  /** Only Super Admin may start Google OAuth for the platform connection. */
  allowConnect?: boolean;
}) {
  const searchParams = useSearchParams();
  const [starting, setStarting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [status, setStatus] = useState(initialStatus);

  const flash = searchParams.get("google");
  const reason = searchParams.get("reason");
  const returnPath = "/gmb";
  void businessId;

  async function refreshStatus() {
    try {
      const res = await fetch("/api/auth/google/status");
      const data = (await res.json()) as SafeGoogleStatus & {
        success?: boolean;
        message?: string;
        code?: string;
      };
      if (res.status === 401 || res.status === 403) {
        setStatus({
          oauthConfigured: data.oauthConfigured ?? status.oauthConfigured,
          connection: null,
          statusError:
            data.message ||
            "You are not authorized to view Google connection status.",
        });
        return;
      }
      if (!res.ok) {
        setStatus({
          oauthConfigured: data.oauthConfigured ?? status.oauthConfigured,
          connection: null,
          statusError:
            data.statusError ||
            data.message ||
            "Could not load Google connection status.",
        });
        return;
      }
      setStatus({
        oauthConfigured: Boolean(data.oauthConfigured),
        connection: data.connection ?? null,
        statusError: data.statusError ?? null,
      });
    } catch {
      setStatus((prev) => ({
        ...prev,
        connection: null,
        statusError: "Could not load Google connection status.",
      }));
    }
  }

  async function startOAuth() {
    if (!allowConnect) {
      setError(
        "Only Super Admin can connect the TRONX Google Business Profile account."
      );
      return;
    }
    setStarting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnPath,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        authUrl?: string;
        message?: string;
        code?: string;
      };
      if (res.status === 401 || res.status === 403) {
        setError(
          data.message ||
            "You are not authorized to connect Google for this workspace."
        );
        await refreshStatus();
        return;
      }
      if (!res.ok || !data.success || !data.authUrl) {
        setError(data.message || "Failed to start Google authorization");
        return;
      }
      window.location.href = data.authUrl;
    } catch {
      setError("Failed to start Google authorization");
    } finally {
      setStarting(false);
    }
  }

  async function disconnectGoogle() {
    if (!allowConnect) {
      setError("Only Super Admin can disconnect the platform Google connection.");
      return;
    }
    if (!confirmDisconnect) {
      setError(
        "Confirm disconnect first. Live Google sync and publishing may stop until reconnection. Locations, businesses, and reviews stay in TRONX."
      );
      return;
    }
    setDisconnecting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/admin/google/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
        code?: string;
        status?: string;
        googleRevoked?: boolean;
        googleRevokeError?: string | null;
        localTokensCleared?: boolean;
      };
      if (res.status === 401 || res.status === 403) {
        setError(
          data.message ||
            "You are not authorized to disconnect Google for this workspace."
        );
        return;
      }
      if (!res.ok || !data.success) {
        setError(data.message || "Failed to disconnect Google");
        await refreshStatus();
        return;
      }
      setConfirmDisconnect(false);
      const revokeNote = data.googleRevoked
        ? " Google revoked the token."
        : data.googleRevokeError
          ? ` Google revocation did not complete (${data.googleRevokeError}); local credentials are cleared and not usable.`
          : " Local credentials are cleared and not usable.";
      setInfo(
        (data.message ||
          "Google connection disconnected. Existing locations, businesses, and reviews were preserved.") +
          revokeNote
      );
      await refreshStatus();
    } catch {
      setError("Failed to disconnect Google");
    } finally {
      setDisconnecting(false);
    }
  }

  const headline = connectionHeadline(status);
  const needsReconnect =
    !status.connection || status.connection.status !== "active";
  const buttonLabel = starting
    ? "Redirecting…"
    : status.connection?.status === "active"
      ? "Reconnect Google"
      : status.connection
        ? "Reconnect Google"
        : "Connect Google";

  return (
    <div className="space-y-4 rounded-lg border border-zinc-300 bg-white p-5 shadow-sm dark:border-zinc-600 dark:bg-zinc-950">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Google Business Profile
        </h2>
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
          {allowConnect
            ? "Connect the central TRONX Google Business Profile account once. Discover locations under GMB → Locations, then assign one location per business. TRONX app login stays email/password — this OAuth flow is not used to sign into TRONX. Tokens never appear in the browser."
            : "Google connection is managed by Super Admin for the TRONX platform account. You sign into TRONX with email/password. Live sync and publishing require a valid Super Admin connection; stored reviews remain available if Google is disconnected."}
        </p>
      </div>

      {flash === "connected" && (
        <p
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-50"
          role="status"
        >
          Google account connected successfully. The connection is stored
          encrypted and will be reused on later logins.
        </p>
      )}
      {flash === "error" && (
        <p
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-50"
          role="alert"
        >
          Google authorization failed
          {reason ? ` (${reason})` : ""}. Try reconnecting, or check server
          OAuth configuration.
        </p>
      )}

      <div
        className={`rounded-md border px-3 py-3 text-sm ${
          headline.tone === "ok"
            ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-50"
            : headline.tone === "warn"
              ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
              : "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
        }`}
        role="status"
        aria-live="polite"
      >
        <p className="text-base font-semibold">{headline.title}</p>
        <p className="mt-1">{headline.detail}</p>
        {status.connection && (
          <ul className="mt-2 space-y-1 text-zinc-800 dark:text-zinc-200">
            <li>
              <span className="font-medium">Stored status:</span>{" "}
              {status.connection.status}
            </li>
            <li>
              <span className="font-medium">Account:</span>{" "}
              {status.connection.email || "(email unavailable)"}
            </li>
            <li>
              <span className="font-medium">Source:</span>{" "}
              {status.connection.connectionSource === "business_owner"
                ? "Business owner connection"
                : status.connection.connectionSource === "platform"
                  ? "Platform-managed connection"
                  : "Stored connection"}
            </li>
            {status.connection.connectedAt && (
              <li>
                <span className="font-medium">Connected at:</span>{" "}
                {/* Locale formatting differs on server vs client — avoid hydration mismatch. */}
                <time
                  dateTime={status.connection.connectedAt}
                  suppressHydrationWarning
                >
                  {new Date(status.connection.connectedAt).toLocaleString()}
                </time>
              </li>
            )}
          </ul>
        )}
      </div>

      {status.statusError && (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
          role="alert"
        >
          {status.statusError}
        </p>
      )}

      {error && (
        <p
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-950"
          role="alert"
        >
          {error}
        </p>
      )}
      {info && (
        <p
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-50"
          role="status"
        >
          {info}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {allowConnect ? (
          <button
            type="button"
            onClick={() => void startOAuth()}
            disabled={starting || disconnecting || !status.oauthConfigured}
            className="inline-flex rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {buttonLabel}
          </button>
        ) : (
          <p className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
            Connect / reconnect is Super Admin only.
          </p>
        )}
        <button
          type="button"
          onClick={() => void refreshStatus()}
          className="inline-flex rounded-md border border-zinc-400 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-500 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Refresh status
        </button>
      </div>
      {allowConnect &&
        status.connection &&
        status.connection.status !== "revoked" && (
          <div className="space-y-2 rounded-md border border-zinc-300 bg-zinc-50 px-3 py-3 text-sm dark:border-zinc-600 dark:bg-zinc-900">
            <p className="text-zinc-800 dark:text-zinc-200">
              Disconnect clears local Google credentials and attempts to revoke
              the token at Google. Live sync and publishing may stop until you
              reconnect. Existing Google-linked locations, businesses, and
              reviews stay in TRONX.
            </p>
            <label className="flex items-start gap-2 text-zinc-800 dark:text-zinc-200">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmDisconnect}
                onChange={(e) => setConfirmDisconnect(e.target.checked)}
              />
              <span>
                I understand live Google sync/publishing may stop until
                reconnection, and I want to disconnect the platform connection.
              </span>
            </label>
            <button
              type="button"
              onClick={() => void disconnectGoogle()}
              disabled={disconnecting || starting || !confirmDisconnect}
              className="inline-flex rounded-md border border-red-400 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-700 dark:text-red-100 dark:hover:bg-red-950"
            >
              {disconnecting ? "Disconnecting…" : "Disconnect Google"}
            </button>
          </div>
        )}
      {allowConnect && needsReconnect && status.oauthConfigured && (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Explicit consent is required for the first connection or after a
          reconnect. Signing into TRONX never starts Google OAuth automatically.
        </p>
      )}
    </div>
  );
}
