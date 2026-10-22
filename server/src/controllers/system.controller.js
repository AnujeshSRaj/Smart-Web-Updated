import { config } from '../config/env.js';
import { pingDatabase } from '../db/database.js';

export function handleHealth(req, res) {
  res.json({ status: 'ok', model: config.groq.model, timestamp: new Date().toISOString() });
}

export async function handleReadiness(req, res) {
  try {
    await pingDatabase();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
}

export function handleAuthConfig(req, res) {
  res.json({ neonAuthBaseUrl: config.neonAuthBaseUrl });
}
