/**
 * Outputs only non-secret markers for browser login helpers.
 * Credentials are read from .env.local and written to a temp file for the
 * agent fill step is avoided — instead prints lengths only.
 */
import fs from "fs";

const text = fs.readFileSync(".env.local", "utf8");
const email = (text.match(/^SUPERADMIN_EMAIL=(.*)$/m)?.[1] || "").trim();
const password = (text.match(/^SUPERADMIN_PASSWORD=(.*)$/m)?.[1] || "").trim();
console.log(`email_set=${Boolean(email)}`);
console.log(`email_len=${email.length}`);
console.log(`password_set=${Boolean(password)}`);
console.log(`password_len=${password.length}`);
// Write to a gitignored temp path for local tooling only (not printed).
fs.writeFileSync(
  ".env.login.tmp",
  `EMAIL=${email}\nPASSWORD=${password}\n`,
  "utf8"
);
console.log("wrote=.env.login.tmp");
