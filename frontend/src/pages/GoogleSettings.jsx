import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { googleService } from "../services/api";
import { Loading } from "../components/Loading";
import { ErrorMessage } from "../components/ErrorMessage";

function formatDate(value) {
    if (!value) return "Never";
    try {
        return new Date(value).toLocaleString();
    } catch {
        return "Unknown";
    }
}

function readOAuthFlash(searchParams) {
    const google = searchParams.get("google");
    if (google === "connected") {
        return {
            notice: "Google account connected successfully. Select locations below to enable review sync.",
            error: null,
        };
    }
    if (google === "error") {
        const reason = searchParams.get("reason") || "unknown";
        return {
            notice: null,
            error: `Google connection failed (${reason}). Try connecting again.`,
        };
    }
    return { notice: null, error: null };
}

export function GoogleSettings() {
    const [searchParams, setSearchParams] = useSearchParams();
    const [status, setStatus] = useState(null);
    const [discovered, setDiscovered] = useState([]);
    const [selected, setSelected] = useState(() => new Set());
    const [loading, setLoading] = useState(true);
    const [discovering, setDiscovering] = useState(false);
    const [actionLoading, setActionLoading] = useState(null);
    const [error, setError] = useState(() => readOAuthFlash(searchParams).error);
    const [notice, setNotice] = useState(() => readOAuthFlash(searchParams).notice);

    const loadStatus = useCallback(async ({ clearError = true } = {}) => {
        // Do not clear OAuth callback flash errors on the initial status load.
        if (clearError) setError(null);
        const data = await googleService.getStatus();
        if (data.success) {
            setStatus(data);
        } else {
            setError((prev) => {
                if (!clearError && prev) return prev;
                return data.message || "Failed to load Google status";
            });
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                // Preserve OAuth redirect error/notice from initial state.
                await loadStatus({ clearError: false });
            } catch (err) {
                if (!cancelled) {
                    setError((prev) => prev || err.response?.data?.message || "Failed to load Google connection status");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // Intentionally run once on mount so OAuth flash state is not wiped.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!searchParams.get("google")) return;
        const next = new URLSearchParams(searchParams);
        next.delete("google");
        next.delete("reason");
        setSearchParams(next, { replace: true });
    }, [searchParams, setSearchParams]);

    const connectedLocations = (status?.locations || []).filter((loc) => loc.connectionId && loc.syncEnabled);

    const handleConnect = async () => {
        setActionLoading("oauth");
        setError(null);
        try {
            const data = await googleService.startOAuth("/settings/google");
            if (!data.success || !data.authUrl) {
                setError(data.message || "Could not start Google authorization");
                return;
            }
            window.location.href = data.authUrl;
        } catch (err) {
            setError(err.response?.data?.message || "Failed to start Google authorization");
            setActionLoading(null);
        }
    };

    const handleDisconnect = async () => {
        if (!window.confirm("Disconnect this Google account? Review sync and publishing will stop until you reconnect.")) {
            return;
        }
        setActionLoading("disconnect");
        setError(null);
        try {
            await googleService.disconnect();
            setDiscovered([]);
            setSelected(new Set());
            setNotice("Google account disconnected.");
            await loadStatus();
        } catch (err) {
            setError(err.response?.data?.message || "Failed to disconnect Google account");
        } finally {
            setActionLoading(null);
        }
    };

    const handleDiscover = async () => {
        setDiscovering(true);
        setError(null);
        try {
            const data = await googleService.discoverLocations();
            setDiscovered(data.locations || []);
            setSelected(new Set());
            if (!(data.locations || []).length) {
                setNotice("No locations were returned for this Google account.");
            }
        } catch (err) {
            setError(err.response?.data?.message || "Failed to discover Google locations");
        } finally {
            setDiscovering(false);
        }
    };

    const toggleSelect = (key) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const handleConnectSelected = async () => {
        const locations = discovered
            .filter((loc) => selected.has(`${loc.googleAccountId}:${loc.googleLocationId}`))
            .map((loc) => ({
                googleAccountId: loc.googleAccountId,
                googleLocationId: loc.googleLocationId,
            }));
        if (!locations.length) {
            setError("Select at least one location to connect.");
            return;
        }
        setActionLoading("connect");
        setError(null);
        try {
            const data = await googleService.connectLocations(locations);
            setNotice(`Connected ${data.connected?.length || 0} location(s).`);
            await loadStatus();
            await handleDiscover();
        } catch (err) {
            setError(err.response?.data?.message || "Failed to connect locations");
        } finally {
            setActionLoading(null);
        }
    };

    const handleSyncNow = async () => {
        setActionLoading("sync");
        setError(null);
        try {
            const data = await googleService.syncNow();
            const summary = data.summary || {};
            setNotice(
                summary.skipped
                    ? `Sync skipped (${summary.reason || "busy"}).`
                    : `Sync finished: ${summary.created || 0} new review(s) across ${summary.locations || 0} location(s).`
            );
            await loadStatus();
        } catch (err) {
            setError(err.response?.data?.message || "Failed to run review sync");
        } finally {
            setActionLoading(null);
        }
    };

    const handleDisconnectLocation = async (locationId) => {
        if (!window.confirm("Stop syncing this location? Existing reviews are kept.")) return;
        setActionLoading(`loc-${locationId}`);
        try {
            await googleService.disconnectLocation(locationId);
            await loadStatus();
        } catch (err) {
            setError(err.response?.data?.message || "Failed to disconnect location");
        } finally {
            setActionLoading(null);
        }
    };

    if (loading) {
        return <Loading message="Loading Google Business Profile settings..." />;
    }

    if (error && !status) {
        return <ErrorMessage message={error} onRetry={() => window.location.reload()} />;
    }

    const connection = status?.connection;

    return (
        <div className="dashboard-page">
            <div className="page-header-row">
                <div>
                    <h2 className="section-title">Google Business Profile</h2>
                    <p className="section-subtitle">
                        Connect your Google account, choose locations, and sync reviews directly every{" "}
                        {status?.syncIntervalMinutes || 5} minutes.
                    </p>
                </div>
            </div>

            {notice && (
                <div className="reply-error" role="status" style={{ background: "var(--success-light)", borderColor: "var(--success-border)", color: "var(--success-text)" }}>
                    {notice}
                </div>
            )}
            {error && <div className="reply-error" role="alert">{error}</div>}

            <div className="stats-section">
                <div className="stat-card" style={{ padding: "1.25rem" }}>
                    <div className="stat-card-header">
                        <span className="stat-card-title">Connection</span>
                        <span className={`badge ${connection ? "badge-status-approved" : "badge-status-pending"}`}>
                            {connection ? connection.status : "Not connected"}
                        </span>
                    </div>

                    {!status?.oauthConfigured && (
                        <p className="section-subtitle">
                            Google OAuth is not configured on the server yet. An administrator must set
                            GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and GOOGLE_TOKEN_ENCRYPTION_KEY.
                        </p>
                    )}

                    {connection ? (
                        <>
                            <p style={{ marginTop: "0.75rem" }}>
                                Connected as <strong>{connection.email || "Google account"}</strong>
                                {connection.connectedAt ? ` · since ${formatDate(connection.connectedAt)}` : ""}
                            </p>
                            {connection.lastError && (
                                <p className="reply-error" style={{ marginTop: "0.75rem" }}>{connection.lastError}</p>
                            )}
                            <div className="reply-action-bar" style={{ marginTop: "1rem" }}>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={handleDiscover}
                                    disabled={discovering || actionLoading !== null}
                                >
                                    {discovering ? "Loading locations..." : "Refresh Google locations"}
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={handleSyncNow}
                                    disabled={actionLoading !== null}
                                >
                                    {actionLoading === "sync" ? "Syncing..." : "Sync reviews now"}
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-reject"
                                    onClick={handleDisconnect}
                                    disabled={actionLoading !== null}
                                >
                                    {actionLoading === "disconnect" ? "Disconnecting..." : "Disconnect Google"}
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="reply-action-bar" style={{ marginTop: "1rem" }}>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={handleConnect}
                                disabled={!status?.oauthConfigured || actionLoading !== null}
                            >
                                {actionLoading === "oauth" ? "Redirecting..." : "Connect Google account"}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <div className="stats-section">
                <h3 className="subheading">Connected locations ({connectedLocations.length})</h3>
                {connectedLocations.length === 0 ? (
                    <p className="section-subtitle">No locations are syncing yet. Connect a Google account and select locations below.</p>
                ) : (
                    <div className="reviews-list">
                        {connectedLocations.map((loc) => (
                            <div key={loc._id} className="stat-card" style={{ padding: "1rem", marginBottom: "0.75rem" }}>
                                <div className="stat-card-header">
                                    <span className="stat-card-title">{loc.name}</span>
                                    <button
                                        type="button"
                                        className="btn-text"
                                        onClick={() => handleDisconnectLocation(loc._id)}
                                        disabled={actionLoading !== null}
                                    >
                                        Stop sync
                                    </button>
                                </div>
                                <p className="section-subtitle" style={{ marginTop: "0.35rem" }}>
                                    Location ID: {loc.googleLocationId}
                                    {loc.googleAccountId ? ` · Account: ${loc.googleAccountId}` : ""}
                                </p>
                                <p className="section-subtitle">
                                    Last successful sync: {formatDate(loc.lastSyncSuccessAt)}
                                    {loc.lastSyncAttemptAt ? ` · Last attempt: ${formatDate(loc.lastSyncAttemptAt)}` : ""}
                                </p>
                                {loc.lastSyncError && (
                                    <p className="reply-error" style={{ marginTop: "0.5rem" }}>{loc.lastSyncError}</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {connection && (
                <div className="stats-section">
                    <h3 className="subheading">Available Google locations</h3>
                    {discovered.length === 0 ? (
                        <p className="section-subtitle">
                            Click &quot;Refresh Google locations&quot; to list businesses this account can manage.
                        </p>
                    ) : (
                        <>
                            <div className="reviews-list">
                                {discovered.map((loc) => {
                                    const key = `${loc.googleAccountId}:${loc.googleLocationId}`;
                                    return (
                                        <label
                                            key={key}
                                            className="stat-card"
                                            style={{
                                                padding: "0.9rem 1rem",
                                                marginBottom: "0.5rem",
                                                display: "flex",
                                                gap: "0.75rem",
                                                alignItems: "flex-start",
                                                cursor: loc.alreadyConnected ? "default" : "pointer",
                                            }}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selected.has(key)}
                                                disabled={loc.alreadyConnected}
                                                onChange={() => toggleSelect(key)}
                                            />
                                            <span>
                                                <strong>{loc.name}</strong>
                                                <br />
                                                <span className="section-subtitle">
                                                    {loc.googleLocationId}
                                                    {loc.alreadyConnected ? " · already connected" : ""}
                                                </span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                            <div className="reply-action-bar" style={{ marginTop: "1rem" }}>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={handleConnectSelected}
                                    disabled={actionLoading !== null || selected.size === 0}
                                >
                                    {actionLoading === "connect" ? "Connecting..." : `Connect selected (${selected.size})`}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
