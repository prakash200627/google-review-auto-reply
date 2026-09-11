export function ErrorMessage({ message, onRetry }) {
    if (!message) return null;

    return (
        <div className="error-banner">
            <div className="error-icon">⚠️</div>
            <div className="error-content">
                <p className="error-text">{message}</p>
                {onRetry && (
                    <button className="btn-retry" onClick={onRetry}>
                        Retry
                    </button>
                )}
            </div>
        </div>
    );
}
