// Runs before every test file. index.js skips dotenv when NODE_ENV is "test",
// so no real credentials from backend/.env reach the tests.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "testsecret";
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_MODEL;
delete process.env.MONGO_URI;
delete process.env.RENDER;
delete process.env.DNS_SERVERS;
delete process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL;
delete process.env.MAKE_WEBHOOK_SECRET;
delete process.env.MAKE_PUBLISH_CALLBACK_SECRET;
delete process.env.ALLOW_UNAUTHENTICATED_WEBHOOKS;

// Deterministic 32-byte encryption key for unit tests (not a production secret).
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/api/google/oauth/callback";
process.env.FRONTEND_URL = "http://localhost:5173";
process.env.DISABLE_REVIEW_SYNC = "true";
