# Deployment: Neon + Drizzle + Google Cloud Run

```text
Chrome extension ──HTTPS + Neon Auth JWT──> Cloud Run API ──> Neon Auth JWKS
                                                   └──> Neon Postgres (Drizzle)
                                                   └──> Groq API
```

The API is publicly reachable so the extension can call it; protected routes require a verified Neon Auth user token. Database credentials and any shared Groq key stay on the server. Each chat write is transactional, and per-user quotas are shared through Postgres.

## 1. Configure Neon

1. Create a Neon project and enable Neon Auth.
2. Copy the pooled Postgres connection string as `DATABASE_URL` for the Cloud Run service.
3. Copy Neon Auth's base URL and JWKS URL as `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL`.
4. Add the final Chrome extension origin (`chrome-extension://YOUR_EXTENSION_ID`) to Neon Auth's trusted origins. Enable email verification and configure allowed sign-in methods.
5. From `server/`, run `npm ci` and `npm run db:migrate` against the target database before deploying. Migrations create application tables, forced tenant row level security policies, and stable message ordering; Neon Auth manages its own auth schema. Migration `0003` clears only temporary rate-limit counters as it adds the owner column. Coordinate this schema change with the API release if an older server is already serving traffic.

## 2. Deploy the API to Cloud Run

### Deploy from GitHub

The repository root contains a `Dockerfile` that builds only `server/`; select the repository root as the build context when connecting GitHub. This lets Cloud Run build the API without a custom subdirectory setting. In Cloud Run, choose **Create service → Continuously deploy from a repository**, connect the GitHub repository, and select the root `Dockerfile` build option. Use a push to `main` as the deployment trigger.

Before the first deployment, create Secret Manager secrets named `neon-database-url` and `groq-api-key`. Put the rotated Neon pooled connection string in the first secret and the Groq key in the second. Do not commit either value. Configure these non-secret Cloud Run environment variables:

```text
NODE_ENV=production
HOST=0.0.0.0
DB_POOL_MAX=5
GROQ_MODEL=openai/gpt-oss-20b
NEON_AUTH_BASE_URL=https://ep-spring-breeze-b5te0gvr.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth
NEON_AUTH_JWKS_URL=https://ep-spring-breeze-b5te0gvr.neonauth.c-7.us-east-2.aws.neon.tech/neondb/auth/.well-known/jwks.json
CORS_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
```

Reference the secrets as `DATABASE_URL` and `GROQ_API_KEY`. For a demo, start with a low Cloud Run maximum instance count that fits the Neon connection limit. Apply migrations once to the target Neon database before serving user traffic; do not run migrations from every application instance.

After Cloud Run creates the service, copy its HTTPS URL into `extension/config.js`, replace broad host permissions in `extension/manifest.json` with the exact Cloud Run and Neon Auth hosts, load the extension in Chrome to get its ID, and update `CORS_ORIGINS` plus Neon Auth trusted origins. Push these extension changes to GitHub if you want them tracked there.

The local project is initialized on the `main` branch, but has no commit or GitHub remote yet. Add a remote, make and push the first commit, then connect that GitHub repository to Cloud Run.

### Deploy with the Google Cloud CLI

Create Secret Manager entries for the database URL and, if the server supplies a Groq key, the Groq key. Grant the Cloud Run service identity access to those secrets. Deploy from `server/` with an instance cap appropriate for the Neon connection limit:

```sh
gcloud run deploy smart-web-assistant-api --source . --region REGION --allow-unauthenticated --max-instances 10 --concurrency 40 --timeout 60 --set-env-vars NODE_ENV=production,HOST=0.0.0.0,DB_POOL_MAX=5,GROQ_MODEL=openai/gpt-oss-20b,NEON_AUTH_BASE_URL=https://YOUR_AUTH_HOST/neondb/auth,NEON_AUTH_JWKS_URL=https://YOUR_AUTH_HOST/neondb/auth/.well-known/jwks.json,CORS_ORIGINS=chrome-extension://YOUR_EXTENSION_ID --set-secrets DATABASE_URL=neon-database-url:latest,GROQ_API_KEY=groq-api-key:latest
```

Omit the Groq secret mapping when users bring their own keys. Keep `DATABASE_URL` in Secret Manager; do not pass it as a literal environment variable. Cloud Run supplies `PORT`. At these settings, the service can open up to 50 database connections (10 instances × 5 connections); lower either cap if the Neon plan has a smaller connection budget. `GROQ_MODEL` and user-selected models are restricted to the supported options in `server/src/config/models.js`.

## 3. Configure and publish the extension

1. Set `API_BASE_URL` in `extension/config.js` to the Cloud Run HTTPS URL.
2. Replace the broad `*.run.app` and `*.neon.tech` permissions in `extension/manifest.json` with the exact API host and Neon Auth host, each ending in `/*`.
3. Load the extension in Chrome, copy its stable ID, and make sure the same origin appears in both Cloud Run `CORS_ORIGINS` and Neon Auth's trusted origins.
4. Reload the extension and test account creation, email verification, sign-in, chat, sign-out, and a second account.

## 4. Verify

- `/api/health` returns liveness status; `/api/ready` returns 200 only when the database responds.
- `/api/auth-config` returns only the public Neon Auth base URL.
- Sign in as two accounts and confirm each account sees only its own conversations. The API's user ownership checks are applied to list, fetch, delete, clear, and chat continuation operations.
- Confirm requests without a bearer token fail, then confirm valid tokens can only access their own data. Review Cloud Run, Neon, and Groq usage and configure spend alerts before inviting more users.
- Check `/api/ready` after deployment and verify the Cloud Run revision logs contain `server.started` without exposing secrets.
- Use a Neon database role that does not have `SUPERUSER` or `BYPASSRLS`; Postgres applies forced row level security to the table owner, but those elevated roles can bypass it.

Deployment still requires your Neon and Google Cloud projects, provider secrets, billing choice, and final extension ID. Never put private keys in the extension or chat. Before a broad launch, add signup-abuse controls and an edge-level IP quota in addition to the authenticated per-user application quotas.
