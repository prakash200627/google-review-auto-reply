export function StatCard({
    title,
    value,
    subtitle,
    icon,
    variant = "default",
    onClick,
}) {
    return (
        <div
            className={`stat-card stat-card-${variant} ${onClick ? "stat-card-interactive" : ""}`}
            onClick={onClick}
        >
            <div className="stat-card-header">
                <span className="stat-card-title">{title}</span>
                {icon && <div className="stat-card-icon">{icon}</div>}
            </div>
            <div className="stat-card-body">
                <span className="stat-card-value">{value ?? 0}</span>
                {subtitle && <span className="stat-card-subtitle">{subtitle}</span>}
            </div>
        </div>
    );
}
