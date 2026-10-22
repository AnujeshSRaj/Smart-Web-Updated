/**
 * tests/performance-benchmark.js
 * ───────────────────────────────
 * Measures performance metrics for the Express server:
 *  1. Latency percentiles (min, mean, max, p50, p95, p99)
 *  2. Throughput / Requests per second (RPS)
 *  3. Memory footprint (Heap Used, RSS)
 *  4. Payload size scaling impact (1KB, 10KB, 25KB contexts)
 */

process.env.NODE_ENV = 'test';
process.env.GROQ_API_KEY = 'benchmark-key';

import supertest from 'supertest';
import app from '../src/app.js';
import { setGroqCaller, resetGroqCaller } from '../src/services/groq.service.js';

const request = {
  get: (path) => supertest(app).get(path).set('X-Smart-Web-Token', 'test-api-token'),
  post: (path) => supertest(app).post(path).set('X-Smart-Web-Token', 'test-api-token'),
};

// Mock LLM so we benchmark server execution speed rather than Groq internet latency
setGroqCaller(async () => 'This is a mocked high-performance response from the assistant.');

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function runBenchmark() {
  console.log('\n======================================================');
  console.log('   SMART WEB ASSISTANT - PERFORMANCE BENCHMARK');
  console.log('======================================================\n');

  const memInitial = process.memoryUsage();
  console.log(`Initial Memory -> Heap Used: ${(memInitial.heapUsed / 1024 / 1024).toFixed(2)} MB, RSS: ${(memInitial.rss / 1024 / 1024).toFixed(2)} MB`);

  // ── Benchmark 1: Health Check Endpoint ──────────────────────────────────────
  const HEALTH_REQUESTS = 200;
  const healthLatencies = [];
  const healthStart = performance.now();

  for (let i = 0; i < HEALTH_REQUESTS; i++) {
    const t0 = performance.now();
    await request.get('/api/health');
    healthLatencies.push(performance.now() - t0);
  }

  const healthTotalMs = performance.now() - healthStart;
  const healthRps = (HEALTH_REQUESTS / (healthTotalMs / 1000)).toFixed(1);

  console.log('\n[1] GET /api/health (Lightweight Endpoint)');
  console.log(`    Total Requests : ${HEALTH_REQUESTS}`);
  console.log(`    Total Time     : ${healthTotalMs.toFixed(1)} ms`);
  console.log(`    Throughput     : ${healthRps} requests/sec`);
  console.log(`    Mean Latency   : ${(healthLatencies.reduce((a, b) => a + b, 0) / healthLatencies.length).toFixed(2)} ms`);
  console.log(`    Min Latency    : ${Math.min(...healthLatencies).toFixed(2)} ms`);
  console.log(`    p50 (Median)   : ${percentile(healthLatencies, 50).toFixed(2)} ms`);
  console.log(`    p95 Latency    : ${percentile(healthLatencies, 95).toFixed(2)} ms`);
  console.log(`    p99 Latency    : ${percentile(healthLatencies, 99).toFixed(2)} ms`);
  console.log(`    Max Latency    : ${Math.max(...healthLatencies).toFixed(2)} ms`);

  // ── Benchmark 2: POST /api/chat (Pipeline: Validation + Prompt + DB write) ───
  const CHAT_REQUESTS = 50;
  const chatLatencies = [];
  const chatStart = performance.now();

  for (let i = 0; i < CHAT_REQUESTS; i++) {
    const t0 = performance.now();
    await request.post('/api/chat').send({
      question: `Benchmark test question #${i}`,
      pageContext: 'Sample webpage text about distributed systems and performance measurement.',
      pageUrl: 'https://benchmark.local',
      pageTitle: 'Benchmark Test',
    });
    chatLatencies.push(performance.now() - t0);
  }

  const chatTotalMs = performance.now() - chatStart;
  const chatRps = (CHAT_REQUESTS / (chatTotalMs / 1000)).toFixed(1);

  console.log('\n[2] POST /api/chat (Full Backend Flow: Zod + Context + DB Persist)');
  console.log(`    Total Requests : ${CHAT_REQUESTS}`);
  console.log(`    Total Time     : ${chatTotalMs.toFixed(1)} ms`);
  console.log(`    Throughput     : ${chatRps} requests/sec`);
  console.log(`    Mean Latency   : ${(chatLatencies.reduce((a, b) => a + b, 0) / chatLatencies.length).toFixed(2)} ms`);
  console.log(`    Min Latency    : ${Math.min(...chatLatencies).toFixed(2)} ms`);
  console.log(`    p50 (Median)   : ${percentile(chatLatencies, 50).toFixed(2)} ms`);
  console.log(`    p95 Latency    : ${percentile(chatLatencies, 95).toFixed(2)} ms`);
  console.log(`    p99 Latency    : ${percentile(chatLatencies, 99).toFixed(2)} ms`);
  console.log(`    Max Latency    : ${Math.max(...chatLatencies).toFixed(2)} ms`);

  // ── Benchmark 3: Payload Scaling (Context Size Impact) ─────────────────────
  console.log('\n[3] Context Payload Scaling Analysis');
  const payloadSizes = [
    { label: '1 KB Text', size: 1_000 },
    { label: '5 KB Text', size: 5_000 },
    { label: '10 KB Text (Max Default Context)', size: 10_000 },
    { label: '25 KB Text (Large Webpage)', size: 25_000 },
  ];

  for (const { label, size } of payloadSizes) {
    const sampleText = 'Lorem ipsum dolor sit amet '.repeat(Math.ceil(size / 27)).slice(0, size);
    const times = [];
    for (let j = 0; j < 5; j++) {
      const t0 = performance.now();
      await request.post('/api/chat').send({
        question: 'Summarize the context',
        pageContext: sampleText,
      });
      times.push(performance.now() - t0);
    }
    const avgTime = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2);
    console.log(`    ${label.padEnd(35)} -> Mean Processing: ${avgTime} ms`);
  }

  // ── Memory Post-Run ────────────────────────────────────────────────────────
  const memFinal = process.memoryUsage();
  console.log('\n[4] Resource Utilization');
  console.log(`    Final Heap Used: ${(memFinal.heapUsed / 1024 / 1024).toFixed(2)} MB (Delta: ${((memFinal.heapUsed - memInitial.heapUsed) / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`    Final RSS      : ${(memFinal.rss / 1024 / 1024).toFixed(2)} MB`);

  resetGroqCaller();
  console.log('\n======================================================\n');
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
