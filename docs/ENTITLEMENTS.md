# Entitlement mapping (backwards-compatible)

Stored plan feature flags (unchanged):

- `reviewSync`
- `aiDrafts`
- `advancedAnalytics`
- `automation`
- `maxLocations` / `maxOwnerAccounts` / `monthlyAiDraftQuota` (limits)

Product concept aliases (read existing flags; **not** new DB columns):

| Product concept | Stored flag |
|---|---|
| `orm` | `reviewSync` |
| `autoReply` | `automation` |
| `monthlyReport` | `advancedAnalytics` |
| `fakeReviewFlagging` | `advancedAnalytics` |
| `seo` | `advancedAnalytics` |
| `maxLocations` | `plan.limits.maxLocations` |

Implementation: `lib/entitlements/featureMap.ts`.

New concepts are **not** auto-granted. Plans without `advancedAnalytics` do not get SEO/reports/flagging. Plans without `automation` do not get auto-reply.

Commercial tier names and prices remain whatever is already in `lib/entitlements/plans.ts` — not reinvented here.
