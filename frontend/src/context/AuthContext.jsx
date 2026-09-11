import { createContext, useContext, useState, useEffect } from "react";
import { authService } from "../services/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [token, setToken] = useState(() => localStorage.getItem("token") || null);
    const [user, setUser] = useState(() => {
        const storedUser = localStorage.getItem("user");
        try {
            return storedUser ? JSON.parse(storedUser) : null;
        } catch {
            return null;
        }
    });
    const [loading, setLoading] = useState(false);

    const login = async (email, password) => {
        setLoading(true);
        try {
            const data = await authService.login(email, password);
            if (data.success && data.token) {
                setToken(data.token);
                setUser(data.organization);
                localStorage.setItem("token", data.token);
                localStorage.setItem("user", JSON.stringify(data.organization));
                return { success: true };
            } else {
                return {
                    success: false,
                    message: data.message || "Login failed",
                };
            }
        } catch (error) {
            const message =
                error.response?.data?.message ||
                (error.request ? "Cannot connect to server. Please ensure the backend is running." : "Login failed. Please check your credentials.");
            return { success: false, message };
        } finally {
            setLoading(false);
        }
    };

    const logout = () => {
        setToken(null);
        setUser(null);
        localStorage.removeItem("token");
        localStorage.removeItem("user");
    };

    const isAuthenticated = !!token;

    return (
        <AuthContext.Provider
            value={{
                token,
                user,
                loading,
                login,
                logout,
                isAuthenticated,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
