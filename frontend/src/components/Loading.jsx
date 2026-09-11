export function Loading({ message = "Loading data..." }) {
    return (
        <div className="loading-container">
            <div className="spinner" />
            <p className="loading-text">{message}</p>
        </div>
    );
}
