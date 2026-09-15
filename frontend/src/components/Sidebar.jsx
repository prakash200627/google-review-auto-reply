import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function Sidebar({ pendingCount }) {
    const { user } = useAuth();

    return (
        <aside className="sidebar">
            <div className="sidebar-brand">
                <div className="brand-logo-icon">&#x2B50;</div>
                <div className="brand-text">
                    <span className="brand-title">AutoReply</span>
                    <span className="brand-subtitle">Google Reviews</span>
                </div>
            </div>

            <nav className="sidebar-nav">
                <span className="nav-section-label">MAIN NAVIGATION</span>

                <NavLink
                    to="/dashboard"
                    className={({ isActive }) =>
                        `nav-item ${isActive ? "nav-item-active" : ""}`
                    }
                >
                    <span className="nav-icon">&#x1F4CA;</span>
                    <span className="nav-label">Dashboard</span>
                </NavLink>

                <NavLink
                    to="/pending"
                    className={({ isActive }) =>
                        `nav-item ${isActive ? "nav-item-active" : ""}`
                    }
                >
                    <span className="nav-icon">&#x1F4E5;</span>
                    <span className="nav-label">Pending Reviews</span>
                    {typeof pendingCount === "number" && pendingCount > 0 && (
                        <span className="nav-badge-count">{pendingCount}</span>
                    )}
                </NavLink>

                <NavLink
                    to="/reviews"
                    className={({ isActive }) =>
                        `nav-item ${isActive ? "nav-item-active" : ""}`
                    }
                >
                    <span className="nav-icon">&#x1F4DD;</span>
                    <span className="nav-label">All Reviews</span>
                </NavLink>
            </nav>

            <div className="sidebar-footer">
                <div className="sidebar-user-card">
                    <div className="sidebar-user-info">
                        <span className="user-email">{user?.email || "Account"}</span>
                        <span className="user-voice">Voice: {user?.brandVoice || "friendly"}</span>
                    </div>
                </div>
            </div>
        </aside>
    );
}
