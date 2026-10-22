import { config } from './config/env.js';
import app from './app.js';
import { closeDatabase, pingDatabase } from './db/database.js';

async function start() {
  await pingDatabase();
  const server = app.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      level: 'info',
      event: 'server.started',
      host: config.host,
      port: config.port,
      environment: config.nodeEnv,
      model: config.groq.model,
    }));
  });

  server.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'server.error', code: error.code }));
    process.exitCode = 1;
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'server.shutdown', signal }));
    const forceExit = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', event: 'server.shutdown_timeout' }));
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    server.close(async () => {
      clearTimeout(forceExit);
      await closeDatabase();
      process.exitCode = 0;
    });
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start().catch(async (error) => {
  console.error(JSON.stringify({ level: 'fatal', event: 'server.start_failed', name: error.name, code: error.code }));
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
