# Plan: encrypt organization OpenAI keys at rest

Status: **proposal, not implemented.** Nothing in this document has been run against any database.

## Current state

- `Organization.openaiApiKey` is a plaintext string with `select: false`.
- Written in one place: `POST /api/organization/openai-key` (`routes/organization.js`).
- Read in two places:
  - `GET`/`POST /api/organization/openai-key` only test whether it is non-empty (`configured`).
  - `resolveOpenAIConfig()` in `services/ai.js` uses it as the OpenAI key (org key > `OPENAI_API_KEY`).
- No endpoint returns the key; tests assert this.

Risk: anyone with database read access (Atlas users, backups, exports, a leaked `MONGO_URI`) can read every organization's OpenAI key.

## Design

### Algorithm and format

- AES-256-GCM (Node `crypto`, no new dependency), 12-byte random IV per encryption, 16-byte auth tag.
- Additional authenticated data (AAD) = the organization `_id`, so a ciphertext copied to another organization fails to decrypt.
- Stored as one string, so the schema type does not change:

  ```
  enc:v1:<keyId>:<iv base64url>:<tag base64url>:<ciphertext base64url>
  ```

  `v1` is the format version; `keyId` names the encryption key used.

### Encryption keys (separate from OpenAI keys)

- `OPENAI_KEY_ENCRYPTION_KEYS`: comma-separated `keyId:base64(32 random bytes)` pairs, e.g. `k2026a:...,k2026b:...`. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- `OPENAI_KEY_ENCRYPTION_ACTIVE_KEY`: the `keyId` used for new encryptions.
- Validated at startup: every key must decode to exactly 32 bytes and the active key must exist. If org keys are already encrypted and no encryption keys are configured, the server logs an error and treats org keys as unusable (falls back to `OPENAI_API_KEY` / template replies) instead of crashing.
- Stored only in Render environment variables and a password manager. Never in the repo, the database, logs, or the frontend.

### Code changes (small, isolated)

1. New `services/secretBox.js`: `encrypt(plaintext, orgId)`, `decrypt(stored, orgId)`, `isEncrypted(stored)`, `needsReencryption(stored)` (true for plaintext or non-active `keyId`).
2. `POST /openai-key`: always store `encrypt(apiKey, org._id)`.
3. `resolveOpenAIConfig()`: if `isEncrypted` → `decrypt`; otherwise use the legacy plaintext value (backward-compatible reads during migration). Decryption failure → log `org <id>: stored OpenAI key could not be decrypted (<error class>)`, never the value, and continue as if no org key were configured.
4. `GET /openai-key`: keep `configured`; add `usable` (false when decryption fails) so the UI can prompt the owner to re-enter the key. Additive field only.
5. Add a `toJSON`/`toObject` transform on `Organization` that deletes `openaiApiKey` and `password`, as defence in depth against accidental serialization.

### Migration script (`scripts/encryptOpenAIKeys.js`)

- **Dry run by default.** `--apply` is required to write. Prints counts only (`plaintext`, `encrypted (active key)`, `encrypted (old key)`, `failed`) and org IDs, never key material.
- Connects with `autoIndex: false`.
- For each organization whose `openaiApiKey` is non-empty and `needsReencryption`:
  1. Compute the new ciphertext; immediately `decrypt` it and compare with the original in memory. Abort that record on mismatch.
  2. Conditional write: `updateOne({ _id, openaiApiKey: <original value> }, { $set: { openaiApiKey: <ciphertext> } })`. If the owner changed the key concurrently, the write matches nothing and the record is reported as skipped.
- Idempotent: re-running skips records already encrypted with the active key.
- Processes in batches of 100 with a short pause, so it is safe on Atlas free tiers.

### Rollout (each step needs approval)

1. Deploy the read-compatible code with encryption keys configured. New saves are encrypted; existing plaintext keys keep working.
2. Take an Atlas backup or snapshot (see below), then run the script in dry-run mode and review the counts.
3. Run with `--apply`. Re-run dry-run: expect `plaintext: 0`.
4. After a soak period, optionally make plaintext reads log a warning (still no hard failure).

### Key rotation

1. Add the new key to `OPENAI_KEY_ENCRYPTION_KEYS` and set it as `OPENAI_KEY_ENCRYPTION_ACTIVE_KEY`. Keep the old key.
2. Run the migration script again; it re-encrypts every value whose `keyId` is not active.
3. When the dry run reports `encrypted (old key): 0`, remove the old key from the environment.

### Backups and failure recovery

- Before `--apply`, export `{ _id, openaiApiKey }` for affected organizations (or rely on an Atlas snapshot). **This export contains plaintext keys**: store it encrypted, restrict access, and delete it after verification (for example within 7 days).
- Losing an encryption key makes affected org keys unrecoverable. Mitigation: store encryption keys in two places (Render plus a password manager). Worst case, owners re-enter their OpenAI keys, and AI replies fall back to `OPENAI_API_KEY` or template replies in the meantime.
- If the script fails midway, it is safe to re-run: written records are already encrypted and verified, and unwritten records are still plaintext and readable.
- Rollback: deploy code that can still decrypt (never remove the decrypt path in the same release), and restore from the export only if an encryption key is lost.

### Tests (fake keys only, no database)

- Encrypt/decrypt round-trip; a random IV makes ciphertexts differ for the same input.
- Tampered ciphertext, IV, or tag → decryption fails; a ciphertext used with another orgId (AAD) → decryption fails.
- Unknown `keyId` and malformed strings → handled failure, no throw into request handlers.
- `resolveOpenAIConfig` with encrypted, legacy plaintext, and undecryptable values (the latter falls back to `OPENAI_API_KEY`).
- `POST /openai-key` stores ciphertext (the saved document never contains the fake key); `GET` never returns the stored or decrypted value.
- Logs never contain the fake key or the encryption key.
- Migration: dry-run writes nothing; `--apply` writes only plaintext/old-key records; a concurrent change makes the conditional write skip; re-running is a no-op.

### Not covered

- Encryption does not protect against someone with both database access and the Render environment variables.
- A KMS (AWS KMS, GCP KMS) would be stronger, but adds a paid dependency; the design keeps `secretBox.js` small so it can be swapped later.
