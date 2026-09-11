import { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Navbar } from "./Navbar";
import { statsService } from "../services/api";

export function Layout() {
    const location = useLocation();
    const [stats, setStats] = useState(null);

    const fetchGlobalStats = async () => {
        try {
            const data = await statsService.getStats();
            if (data.success && data.stats) {
                setStats(data.stats);
            }
        } catch {
            // Ignore background stats fetch errors
        }
    };

    useEffect(() => {
        fetchGlobalStats();
    }, [location.pathname]);

    // Determine current page title based on path
    const getTitle = () => {
        switch (location.pathname) {
            case "/dashboard":
                return "Dashboard Overview";
            case "/pending":
                return "Pending Reviews Inbox";
            case "/reviews":
                return "All Google Reviews";
            default:
                return "Google Review Auto-Reply";
        }
    };

    return (
        <div className="app-layout">
            <Sidebar pendingCount={stats?.pendingReviews} />
            <div className="main-viewport">
                <Navbar pageTitle={getTitle()} />
                <main className="content-area">
                    <Outlet context={{ refreshStats: fetchGlobalStats, stats }} />
                </main>
            </div>
        </div>
    );
}
