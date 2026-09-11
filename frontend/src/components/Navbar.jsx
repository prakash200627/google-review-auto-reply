import { useAuth } from "../context/AuthContext";

export function Navbar({ pageTitle }) {
    const { user, logout } = useAuth();

    return (
        <header className="navbar">
            <div className="navbar-left">
                <h1 className="navbar-page-title">{pageTitle}</h1>
            </div>

            <div className="navbar-right">
                {user && (
                    <div className="org-profile">
                        <div className="org-avatar">
                            {(user.name || "O")[0].toUpperCase()}
                        </div>
                        <div className="org-meta">
                            <span className="org-name">{user.name || "Organization"}</span>
                            <span className="org-mode-tag">
                                Mode: <strong>{user.mode || "manual"}</strong>
                            </span>
                        </div>
                    </div>
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
