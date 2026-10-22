import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
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

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
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
