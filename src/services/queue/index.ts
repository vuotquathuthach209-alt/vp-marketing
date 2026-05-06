/**
 * BullMQ — central job queue for vp-marketing.
 * Replaces "n8n-style" workflow engine with code-owned TypeScript jobs.
 *
 * Reference: skill sonder-tech-sovereignty (BullMQ MIT, NOT n8n fair-code)
 *
 * Architecture:
 *   src/services/queue/index.ts        ← exports queues + redis connection
 *   src/services/queue/workers.ts      ← worker definitions (consume jobs)
 *   src/services/email-automation/...  ← producers (enqueue jobs)
 *
 * Redis: localhost:6379 (no password, bind 127.0.0.1 only)
 * Persistence: AOF + RDB (managed by Redis daemon)
 *
 * If Redis not available, queues fail gracefully — no crash.
 */

import { Queue, QueueOptions } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/1';

let redisConnection: IORedis | null = null;
let queuesEnabled = true;

export function getRedisConnection(): IORedis | null {
  if (!queuesEnabled) return null;
  if (redisConnection && redisConnection.status === 'ready') return redisConnection;

  try {
    redisConnection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,    // BullMQ requirement
      enableReadyCheck: false,
      lazyConnect: false,
    });
    redisConnection.on('error', (err) => {
      console.warn('[bullmq] redis error:', err.message);
    });
    redisConnection.on('ready', () => {
      console.log('[bullmq] redis connected');
    });
    redisConnection.on('end', () => {
      console.warn('[bullmq] redis disconnected');
    });
    return redisConnection;
  } catch (e: any) {
    console.warn('[bullmq] redis init fail — queues disabled:', e.message);
    queuesEnabled = false;
    return null;
  }
}

const baseOptions: Omit<QueueOptions, 'connection'> = {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 }, // 1min, 2min, 4min
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 }, // keep 7d, max 1000
    removeOnFail: { age: 30 * 24 * 3600 },                 // keep 30d
  },
};

let _emailQueue: Queue | null = null;

/** Email automation queue — welcome, review request, loyalty re-engage */
export function getEmailQueue(): Queue | null {
  if (_emailQueue) return _emailQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  _emailQueue = new Queue('sonder-email-automation', { connection: conn, ...baseOptions });
  return _emailQueue;
}

/** Health check — useful for /api/queue/health endpoint */
export async function getQueueHealth(): Promise<{
  redis: boolean;
  email_waiting: number;
  email_active: number;
  email_completed: number;
  email_failed: number;
}> {
  const result = {
    redis: false,
    email_waiting: 0,
    email_active: 0,
    email_completed: 0,
    email_failed: 0,
  };
  const q = getEmailQueue();
  if (!q) return result;
  result.redis = true;
  try {
    const [w, a, c, f] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
    ]);
    result.email_waiting = w;
    result.email_active = a;
    result.email_completed = c;
    result.email_failed = f;
  } catch {}
  return result;
}

export async function shutdownQueues() {
  try {
    if (_emailQueue) await _emailQueue.close();
    if (redisConnection) await redisConnection.quit();
  } catch {}
}
