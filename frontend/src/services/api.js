import axios from "axios";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        "Content-Type": "application/json",
    },
});

// Attach Authorization Bearer token to requests if available
api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem("token");
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// Global response interceptor for 401 unauthorized & standardized error handling
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response && error.response.status === 401) {
            // Unauthorized - clear token and notify/redirect
            localStorage.removeItem("token");
            localStorage.removeItem("user");
            if (window.location.pathname !== "/login") {
                window.location.href = "/login";
            }
        }
        return Promise.reject(error);
    }
);

export const authService = {
    login: async (email, password) => {
        const res = await api.post("/auth/login", { email, password });
        return res.data;
    },
    register: async (name, email, password) => {
        const res = await api.post("/auth/register", { name, email, password });
        return res.data;
    },
};

export const statsService = {
    getStats: async () => {
        const res = await api.get("/stats");
        return res.data;
    },
};

export const reviewsService = {
    getAll: async () => {
        const res = await api.get("/reviews");
        return res.data;
    },
    getPending: async () => {
        const res = await api.get("/reviews/pending");
        return res.data;
    },
    getById: async (id) => {
        const res = await api.get(`/reviews/${id}`);
        return res.data;
    },
};

export const replyService = {
    approve: async (reviewId, finalReply) => {
        const payload = { reviewId };
        if (finalReply !== undefined && finalReply !== null) {
            payload.finalReply = finalReply;
        }
        const res = await api.post("/reply/approve", payload);
        return res.data;
    },
    reject: async (reviewId) => {
        const res = await api.post("/reply/reject", { reviewId });
        return res.data;
    },
};

export const locationsService = {
    getAll: async () => {
        const res = await api.get("/locations");
        return res.data;
    },
    create: async (name, googleLocationId) => {
        const res = await api.post("/locations", { name, googleLocationId });
        return res.data;
    },
};

export default api;
