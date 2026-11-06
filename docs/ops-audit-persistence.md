# Audit persistence failures — ops runbook

Stdout audit JSON lines are **not** durable storage. Durable audit rows live in MongoDB `auditevents`. When writes fail, TRONX increments an in-process counter, upserts `auditpersisthealths` (`_id: audit_persist`), and emits stderr JSON.

## Signals

| Signal | Where | Durable? |
|--------|--------|----------|
| `type:"audit"` | stdout | No |
| `type:"audit_persist_failure"` | stderr | No (scrape/alert) |
| `type:"audit_persist_alert"` | stderr | No (scrape/alert) |
| `AuditPersistHealth` | Mongo | Yes (cross-instance) |
| `AuditEvent` | Mongo | Yes (the audit itself) |

## Configuration

- `AUDIT_PERSIST_FAILURE_ALERT_THRESHOLD` — process-local failure count that arms stderr `audit_persist_alert` (default **5**).

## Check

```js
// mongosh
db.auditpersisthealths.findOne({ _id: "audit_persist" })
db.auditevents.find().sort({ at: -1 }).limit(5)
```

Look for rising `failureCount`, recent `lastFailureAt`, and `alertArmed: true`.

## Respond

1. Confirm MongoDB connectivity / Atlas status and disk quotas.
2. Confirm the app can write `auditevents` (auth, network, schema).
3. After recovery, optionally reset the health doc:  
   `db.auditpersisthealths.updateOne({ _id: "audit_persist" }, { $set: { failureCount: 0, alertArmed: false } })`
4. Do **not** treat a restart alone as proof audits were retained — compare `auditevents` coverage for the outage window.

## Anti-recursion

Persistence and health-doc failures never call `auditLog`. Alert lines go only to stderr.
