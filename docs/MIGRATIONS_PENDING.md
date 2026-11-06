# Pending MongoDB migrations (NOT executed in this task)

Shared production MongoDB must not be touched until a separately approved staging rollout.

## Schema additions (code-only today)

| Collection | Fields / indexes | Notes |
|---|---|---|
| `businesses` | `status`, `archivedAt`, `suspendedAt`; index on `status` | Compatibility: missing `status` → `active===true`→active, `false`→suspended. Dual-write on lifecycle APIs. **Do not backfill archived.** |
| `reviews` | `replySource`, `tronxPublishedAt`, `draftText`, `draftStatus`, `draftApproved`, `draftUpdatedAt`, `draftGeneratedAt`, `publishClaimOwner`, `publishClaimExpiresAt`; indexes on `replySource`, `draftStatus`, `publishClaimExpiresAt` | Legacy rows: treat non-empty `replyComment` without provenance as `unknown` — **not** TRONX-published. Multi-instance publish lock fields. |
| `autopublishjobs` | `processing` status, `claimOwner`, `claimExpiresAt`; index `{ status, claimExpiresAt }` | Atomic worker claims; expired leases reclaimable. |
| `auditevents` | new collection + indexes on `at`, `businessId+at`, `orgId+at`, `action+at` | Durable audit; stdout remains fallback. |
| `seokeywords` / `seorankings` | new collections + compound indexes | Staff-managed Local SEO. |
| `gmbservicejobs` | new collection + `businessId+updatedAt` | GMB service tracker. |
| `fakereviewflags` | new collection + `reviewId+status` | Investigation flags only. |

## Safest rollout order

1. Deploy code that reads with compatibility helpers (no required fields).
2. Create indexes in a maintenance window (non-blocking where possible).
3. Optionally backfill `businesses.status` from `active` (active/suspended only) — **never** invent archived.
4. Optionally backfill `reviews.replySource=google_synced` where `replyComment` exists and `tronxPublishedAt` is null.
5. Do **not** auto-enable `AUTO_PUBLISH_GLOBALLY_ENABLED` or scheduler secret until queue safety is verified in staging.

## Explicitly not run here

- No `mongosh` / mongoose connect against shared URI
- No index builds, seeds, reconcile, or permanent deletion
- Location 66 vs 134/164 discrepancy remains **unreconciled** (needs separate read-only inspection)
