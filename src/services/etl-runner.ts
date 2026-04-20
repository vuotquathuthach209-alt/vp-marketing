/**
 * ETL Runner — orchestrate full sync.
 *
 * Flow:
 *   1. Create sync_log entry (status=running)
 *   2. Read OTA hotels (incremental nếu có since)
 *   3. FOR EACH: synthesize → upsert knowledge → track metrics
 *   4. Pacing: 10 req/min (tôn trọng Gemini free tier 10 RPM)
 *   5. Update sync_log (status=completed/failed, stats)
 *
 * Exports:
 *   - runEtl(opts) — manual trigger
 *   - scheduleEtl() — cron T2/T4/T6 3am
 */
import { db } from '../db';
import { readOtaHotels } from './ota-reader';
import { synthesizeHotel } from './hotel-synthesizer';
import { upsertKnowledge, hasKnowledge } from './hotel-knowledge';

// Gemini free tier: 10 RPM. Pace 1 req/6 giây an toàn.
const PACING_MS = 6500;
const MAX_HOTELS_PER_RUN = 500;

export interface EtlRunOptions {
  force?: boolean;          // bypass incremental check
  limit?: number;
  trigger?: 'manual' | 'cron' | 'api';
  targetHotelIds?: number[]; // specific hotels only
}

export interface EtlRunResult {
  sync_log_id: number;
  status: 'completed' | 'failed' | 'partial';
  hotels_total: number;
  hotels_ok: number;
  hotels_failed: number;
  provider_gemini: number;
  provider_fallback: number;
  duration_ms: number;
  errors: Array<{ hotel_id: number; reason: string }>;
}

export async function runEtl(opts: EtlRunOptions = {}): Promise<EtlRunResult> {
  const startedAt = Date.now();
  const trigger = opts.trigger || 'manual';

  // Create sync log
  const logResult = db.prepare(
    `INSERT INTO etl_sync_log (started_at, status, trigger_source) VALUES (?, 'running', ?)`
  ).run(startedAt, trigger);
  const syncLogId = logResult.lastInsertRowid as number;

  console.log(`[etl] start run #${syncLogId} (trigger=${trigger})`);

  let providerGemini = 0, providerFallback = 0;
  let ok = 0, failed = 0;
  const errors: Array<{ hotel_id: number; reason: string }> = [];

  try {
    // Fetch hotels to process
    const limit = Math.min(opts.limit || MAX_HOTELS_PER_RUN, MAX_HOTELS_PER_RUN);
    const lastSyncRow = db.prepare(
      `SELECT MAX(finished_at) AS last FROM etl_sync_log WHERE status = 'completed'`
    ).get() as any;
    const since = opts.force ? 0 : (lastSyncRow?.last || 0);

    const hotels = await readOtaHotels({ limit, since });

    // Filter by targetHotelIds nếu có
    const filtered = opts.targetHotelIds
      ? hotels.filter(h => opts.targetHotelIds!.includes(Number(h.id)))
      : hotels;

    for (let i = 0; i < filtered.length; i++) {
      const raw = filtered[i];
      const hotelId = Number(raw.id);

      try {
        const t0 = Date.now();
        const result = await synthesizeHotel(raw);

        if (!result.ok || !result.data) {
          failed++;
          errors.push({ hotel_id: hotelId, reason: result.error || 'synthesize failed' });
          db.prepare(
            `INSERT INTO etl_hotel_failures (sync_log_id, ota_hotel_id, hotel_name, reason, created_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(syncLogId, hotelId, raw.name || '', result.error || '', Date.now());
          continue;
        }

        // Track provider (retried = fallback used likely)
        if (result.retried) providerFallback++;
        else providerGemini++;

        await upsertKnowledge(hotelId, hotelId, result.data, 'gemini-2.5-flash');
        ok++;

        const lat = Date.now() - t0;
        console.log(`[etl] #${i + 1}/${filtered.length} hotel=${hotelId} (${raw.name}) OK in ${lat}ms`);

        // Pacing (10 RPM for Gemini)
        if (i < filtered.length - 1) await sleep(PACING_MS);
      } catch (e: any) {
        failed++;
        errors.push({ hotel_id: hotelId, reason: e?.message || 'unknown' });
        db.prepare(
          `INSERT INTO etl_hotel_failures (sync_log_id, ota_hotel_id, hotel_name, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(syncLogId, hotelId, raw.name || '', e?.message || '', Date.now());
      }
    }

    const finishedAt = Date.now();
    const duration = finishedAt - startedAt;
    const status: 'completed' | 'partial' = failed === 0 ? 'completed' : 'partial';

    db.prepare(
      `UPDATE etl_sync_log SET
        finished_at = ?, status = ?, hotels_total = ?, hotels_ok = ?, hotels_failed = ?,
        provider_gemini = ?, provider_fallback = ?, duration_ms = ?,
        error_summary = ?
       WHERE id = ?`
    ).run(
      finishedAt, status, filtered.length, ok, failed,
      providerGemini, providerFallback, duration,
      errors.length > 0 ? JSON.stringify(errors.slice(0, 10)) : null,
      syncLogId,
    );

    console.log(`[etl] run #${syncLogId} ${status}: ${ok} ok, ${failed} failed, ${Math.round(duration / 1000)}s`);

    return {
      sync_log_id: syncLogId,
      status,
      hotels_total: filtered.length,
      hotels_ok: ok,
      hotels_failed: failed,
      provider_gemini: providerGemini,
      provider_fallback: providerFallback,
      duration_ms: duration,
      errors,
    };
  } catch (e: any) {
    const finishedAt = Date.now();
    db.prepare(
      `UPDATE etl_sync_log SET finished_at = ?, status = 'failed', duration_ms = ?, error_summary = ? WHERE id = ?`
    ).run(finishedAt, finishedAt - startedAt, e?.message || 'unknown', syncLogId);
    console.error(`[etl] run #${syncLogId} FAILED:`, e?.message);
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function getEtlStats(days = 30): any {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const runs = db.prepare(
    `SELECT id, started_at, finished_at, status, hotels_total, hotels_ok, hotels_failed,
            provider_gemini, provider_fallback, duration_ms, trigger_source
     FROM etl_sync_log WHERE started_at >= ? ORDER BY id DESC`
  ).all(since) as any[];

  const agg = runs.reduce((acc: any, r: any) => {
    acc.total_runs++;
    acc.hotels_synced += r.hotels_ok || 0;
    acc.gemini_calls += r.provider_gemini || 0;
    acc.fallback_calls += r.provider_fallback || 0;
    acc.failures += r.hotels_failed || 0;
    acc.total_duration_ms += r.duration_ms || 0;
    return acc;
  }, { total_runs: 0, hotels_synced: 0, gemini_calls: 0, fallback_calls: 0, failures: 0, total_duration_ms: 0 });

  return {
    days,
    agg,
    last_run: runs[0] || null,
    recent_runs: runs.slice(0, 10),
  };
}
