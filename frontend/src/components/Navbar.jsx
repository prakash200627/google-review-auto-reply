import { useAuth } from "../context/AuthContext";
import ModeSelector from "./ModeSelector";

export function Navbar({ pageTitle }) {
    const { user, logout } = useAuth();

    return (
        <header className="navbar">
            <div className="navbar-left">
                <h1 className="navbar-page-title">{pageTitle}</h1>
            </div>

            <div className="navbar-right">
                {user && (
                    <>
                        <div className="org-profile">
                            <div className="org-avatar">
                                {(user.name || "O")[0].toUpperCase()}
                            </div>
                            <div className="org-meta">
                                <span className="org-name">{user.name || "Organization"}</span>
                                <span className="org-mode-tag">
                                    Current Mode: <strong style={{ textTransform: 'uppercase', color: user.mode === 'auto' ? '#10b981' : '#3b82f6' }}>{user.mode || "manual"}</strong>
                                </span>
                            </div>
                        </div>
                        <ModeSelector />
                    </>
                )}

                <button
                    type="button"
                    className="btn btn-outline-logout"
                    onClick={logout}
                    title="Sign out"
                >
                    Sign Out
                </button>
            </div>
        </header>
    );
}
