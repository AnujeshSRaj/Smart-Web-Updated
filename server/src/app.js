import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config/env.js';
import { requestContext } from './middleware/request-context.middleware.js';
import { requireUser } from './middleware/auth.middleware.js';
import { apiRateLimiter } from './middleware/rate-limit.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import protectedRoutes from './routes/chat.routes.js';
import systemRoutes from './routes/system.routes.js';

const HOME_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Smart Web Assistant API</title>
  </head>
  <body>
    <main>
      <h1>Smart Web Assistant API</h1>
      <p>The backend is online. Use the Chrome extension to chat with the assistant.</p>
      <h2>Service status</h2>
      <ul>
        <li><a href="/api/health">API health</a> — confirms the server is responding.</li>
        <li><a href="/api/ready">Database readiness</a> — confirms the database connection.</li>
      </ul>
    </main>
  </body>
</html>`;

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(APP_DIR, '..', 'public');
const NEON_AUTH_BUNDLE_PATH = [
  join(APP_DIR, '..', '..', 'extension', 'neon-auth.bundle.js'),
  join(APP_DIR, '..', 'extension', 'neon-auth.bundle.js'),
].find(existsSync);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        connectSrc: ["'self'", new URL(config.neonAuthBaseUrl).origin],
      },
    },
  }));
  app.use(requestContext);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      const error = new Error('Origin is not allowed.');
      error.statusCode = 403;
      error.code = 'ORIGIN_DENIED';
      return callback(error);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Groq-API-Key'],
    maxAge: 600,
  }));

  app.get('/', (_req, res) => {
    res.status(200).type('html').send(HOME_PAGE);
  });

  app.get('/auth-assets/neon-auth.bundle.js', (_req, res) => {
    if (!NEON_AUTH_BUNDLE_PATH) return res.sendStatus(404);
    res.sendFile(NEON_AUTH_BUNDLE_PATH);
  });
  app.get('/auth-assets/auth-config.js', (_req, res) => {
    res.type('application/javascript').send(
      `globalThis.SMART_WEB_AUTH_CONFIG = Object.freeze(${JSON.stringify({ neonAuthBaseUrl: config.neonAuthBaseUrl })});`,
    );
  });
  app.use('/auth-assets', express.static(PUBLIC_DIR, { dotfiles: 'deny', index: false }));
  app.get('/extension-auth', (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'extension-auth.html'));
  });

  // Public operational endpoints are mounted separately from user data routes.
  app.use('/api', systemRoutes);

  // Identity and quotas run before parsing user payloads or invoking application routes.
  app.use('/api', requireUser);
  app.use('/api', apiRateLimiter);
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use('/api', protectedRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = createApp();
export default app;
