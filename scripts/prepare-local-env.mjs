/**
 * DEPRECATED for the current architecture (Next.js local + MongoDB Atlas).
 *
 * This script previously rewrote MONGODB_URI to 127.0.0.1 — that is no longer
 * the intended workflow. Do not run it to “fix” database config.
 *
 * Configure Atlas in .env.local manually (see .env.example).
 * Never commit .env.local or credential backups.
 */
console.error(
  "prepare-local-env.mjs is disabled. Use MongoDB Atlas in .env.local (see .env.example). Do not point development at a local mongod unless you intentionally choose that."
);
process.exit(1);
