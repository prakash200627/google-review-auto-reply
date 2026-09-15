import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { authService } from "../services/api";

export function Login() {
    const navigate = useNavigate();
    const { login } = useAuth();

    const [isRegister, setIsRegister] = useState(false);
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccessMessage(null);
        setLoading(true);

        try {
            if (isRegister) {
                if (!name.trim()) {
                    setError("Organization name is required.");
                    setLoading(false);
                    return;
                }
                const res = await authService.register(name, email, password);
                if (res.success) {
                    setSuccessMessage("Registration successful! Logging you in...");
                    const loginResult = await login(email, password);
                    if (loginResult.success) {
                        navigate("/dashboard");
                    } else {
                        setIsRegister(false);
                        setSuccessMessage("Registration successful. Please log in.");
                    }
                } else {
                    setError(res.message || "Registration failed.");
                }
            } else {
                const result = await login(email, password);
                if (result.success) {
                    navigate("/dashboard");
                } else {
                    setError(result.message || "Invalid email or password.");
                }
            }
        } catch (err) {
            setError(
                err.response?.data?.message ||
                "Failed to connect to the backend server. Make sure port 5000 is running."
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-page">
            <div className="auth-card">
                <div className="auth-header">
                    <div className="auth-logo-badge">⭐</div>
                    <h2 className="auth-title">
                        {isRegister ? "Create Organization Account" : "Sign In to AutoReply"}
                    </h2>
                    <p className="auth-subtitle">
                        {isRegister
                            ? "Register your organization to automate Google Review responses"
                            : "AI-Powered Google Review Management & Approval System"}
                    </p>
                </div>

                {error && <div className="alert alert-error">{error}</div>}
                {successMessage && <div className="alert alert-success">{successMessage}</div>}

                <form className="auth-form" onSubmit={handleSubmit}>
                    {isRegister && (
                        <div className="form-group">
                            <label className="form-label" htmlFor="orgName">
                                Organization Name
                            </label>
                            <input
                                id="orgName"
                                type="text"
                                className="form-input"
                                placeholder="e.g. Acme Hospitality"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                            />
                        </div>
                    )}

                    <div className="form-group">
                        <label className="form-label" htmlFor="email">
                            Email Address
                        </label>
                        <input
                            id="email"
                            type="email"
                            className="form-input"
                            placeholder="name@company.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="password">
                            Password
                        </label>
                        <input
                            id="password"
                            type="password"
                            className="form-input"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary btn-block"
                        disabled={loading}
                    >
                        {loading
                            ? "Authenticating..."
                            : isRegister
                            ? "Register Organization"
                            : "Sign In"}
                    </button>
                </form>

                <div className="auth-footer">
                    <button
                        type="button"
                        className="btn-toggle-auth"
                        onClick={() => {
                            setIsRegister(!isRegister);
                            setError(null);
                            setSuccessMessage(null);
                        }}
                    >
                        {isRegister
                            ? "Already have an organization? Sign in instead"
                            : "Need a new organization account? Register here"}
                    </button>
                </div>
            </div>
        </div>
    );
}
