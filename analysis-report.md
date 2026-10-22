# Smart Web Assistant: backend architecture review

Updated: 2026-10-22 (Asia/Calcutta)

## Architecture changes

- Separated Express composition, controllers, application services, persistence, middleware, validation, and runtime configuration.
- Replaced single-query Neon HTTP access with a bounded pooled Neon Postgres connection that supports transactional work.
- Made each chat exchange atomic: user mirror, conversation, both messages, and conversation timestamp update commit together.
- Added a composite message-to-conversation owner foreign key and forced Postgres row level security on app users, conversations, messages, and quota buckets.
- Set the verified JWT subject transaction-locally before every user-scoped database operation. Existing owner-filtered queries remain as an additional application guard.
- Added a database-generated message sequence so prior turns stay in a stable order even when rows share a timestamp.
- Moved per-user rate limits from per-process memory into atomic Postgres counters shared by Cloud Run instances. Requests fail closed if the limiter store is unavailable.
- Made stored server history authoritative; the extension no longer posts client-editable assistant history. Added strict request validation and a supported Groq model allowlist that normalizes retired saved model settings.
- Added request IDs, structured redacted errors, readiness checks, graceful database shutdown, pool sizing controls, and Cloud Run deployment guidance.

## Verification and measurements

| Check | Result |
|---|---:|
| Automated tests | 44 passed, 0 failed |
| Line / branch / function coverage | 78.29% / 76.88% / 73.68% |
| JWT signature and issuer checks | Valid token accepted; wrong-key and malformed tokens rejected |
| User ownership tests | Cross-user conversation reads rejected in the isolated test adapter |
| Request controls | CORS allowlist, request validation, retired model rejection, and rate bucket isolation passed |
| RLS migration guard | Static test confirms forced policies and transaction-local owner context are present |
| Migration generation | `drizzle-kit generate` reports no schema drift |

The HTTP suite uses the in-memory adapter, not a real Postgres instance. The RLS check inspects the migration structure; it does not prove live Neon policy behavior. A Neon database integration run is still needed before production.

Mock-only local benchmark: 200 health requests measured p50/p95/p99 of 1.59/2.73/3.50 ms at 527.9 requests/sec. Fifty mocked chat requests measured p50/p95/p99 of 1.87/2.91/17.92 ms at 429.8 requests/sec. Context payloads from 1 KB to 25 KB processed in about 2.15–2.48 ms. These numbers exclude real Postgres, Groq, network, and multi-instance latency and are not deployment capacity estimates.

## Still required before production

- Apply the migrations to a Neon staging branch and exercise RLS with two real accounts and the same pooled DB role used by Cloud Run.
- Confirm the Cloud Run database role does not have `SUPERUSER` or `BYPASSRLS`, set pool and instance limits to fit the Neon connection budget, and verify `/api/ready`.
- Configure the exact extension origin, Neon Auth email verification and signup controls, Secret Manager values, and Groq spend limits.
- Deploy the API, update the extension API host permissions, then test account creation, verification, sign-in, chat persistence, and cross-account isolation end to end.

No live Neon database test or Cloud Run deployment has been performed in this workspace.
