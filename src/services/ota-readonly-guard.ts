/**
 * OTA Read-Only Safety Guard
 * ═══════════════════════════════════════════════════════════════
 *
 * HỢP ĐỒNG CỨNG: dự án VP Marketing KHÔNG BAO GIỜ được ghi/sửa/xóa
 * dữ liệu vào OTA database. CHỈ ĐƯỢC ĐỌC (SELECT/SHOW/DESCRIBE/EXPLAIN).
 *
 * Tại sao:
 *   - OTA là hệ thống production của công ty, data của nhiều khách sạn.
 *   - Dự án này chỉ làm ETL đọc + tổng hợp vào knowledge base riêng.
 *   - Bất kỳ thao tác ghi nào có thể gây thiệt hại nghiêm trọng.
 *
 * 3 LỚP BẢO VỆ:
 *   1. DB user: GRANT SELECT only (setup phía OTA DBA).
 *   2. Network: read replica nếu có (optional).
 *   3. Runtime: guard này chặn mọi query không phải SELECT.
 *
 * Usage:
 *   import { otaQueryReadOnly } from './ota-readonly-guard';
 *   const rows = await otaQueryReadOnly('SELECT * FROM hotels LIMIT 10');
 *   // OK
 *
 *   await otaQueryReadOnly('DELETE FROM hotels');
 *   // → throws OtaReadOnlyViolation immediately, BEFORE hitting network
 */
import { trackEvent } from './events';

// ── Allowed statement prefixes ────────────────────────────────
const READ_ONLY_PREFIXES = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\s/i;

// ── Forbidden keywords (double-check) ─────────────────────────
// Các keyword mutation phổ biến. Ngay cả khi "ẩn" trong WITH/CTE cũng bị chặn.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW|COLUMN|CONSTRAINT|SCHEMA)\b/i,
  /\bTRUNCATE\s+(TABLE|\w+)\b/i,
  /\bALTER\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b/i,
  /\bCREATE\s+(TABLE|DATABASE|INDEX|VIEW|SCHEMA|TRIGGER|PROCEDURE|FUNCTION)\b/i,
  /\bREPLACE\s+INTO\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bRENAME\s+(TABLE|COLUMN)\b/i,
  /\bMERGE\s+INTO\b/i,
  /\bUPSERT\b/i,
  /\bLOCK\s+TABLE\b/i,
  /\bCALL\s+\w+\s*\(/i,   // chặn stored procedure (có thể mutation)
  /\bSET\s+@\w+/i,         // chặn SET biến server (có thể gây side effect)
  /\bLOAD\s+DATA\b/i,
  /\bFLUSH\b/i,
  /\bKILL\s+\d+/i,
  /\bHANDLER\s+\w+\s+OPEN\b/i,
];

export class OtaReadOnlyViolation extends Error {
  constructor(message: string, public readonly sql: string) {
    super(`[OTA READ-ONLY VIOLATION] ${message}`);
    this.name = 'OtaReadOnlyViolation';
  }
}

export interface QueryAuditEvent {
  sql_preview: string;
  matched_prefix?: string;
  blocked_reason?: string;
  executed: boolean;
  ms?: number;
}

/**
 * Validate SQL - throw OtaReadOnlyViolation nếu không phải read-only.
 */
export function assertReadOnly(sql: string): void {
  const trimmed = (sql || '').trim();
  if (!trimmed) throw new OtaReadOnlyViolation('empty SQL', sql);
  if (trimmed.length > 50_000) throw new OtaReadOnlyViolation('SQL too long (>50KB)', sql);

  // Must start with approved prefix
  if (!READ_ONLY_PREFIXES.test(trimmed)) {
    throw new OtaReadOnlyViolation(
      `SQL must start with SELECT/SHOW/DESCRIBE/EXPLAIN/WITH; got: "${trimmed.slice(0, 40)}..."`,
      sql,
    );
  }

  // No forbidden keywords anywhere (including CTEs, subqueries)
  for (const re of FORBIDDEN_PATTERNS) {
    const m = trimmed.match(re);
    if (m) {
      throw new OtaReadOnlyViolation(
        `Forbidden keyword detected: "${m[0]}" at index ${m.index}`,
        sql,
      );
    }
  }

  // No multiple statements (prevent SQL injection of mutation)
  // Strip string literals first, then check for semicolons
  const withoutStrings = trimmed
    .replace(/'([^'\\]|\\.)*'/g, "''")
    .replace(/"([^"\\]|\\.)*"/g, '""');
  const semicolons = (withoutStrings.match(/;/g) || []).length;
  if (semicolons > 1 || (semicolons === 1 && !/;\s*$/.test(withoutStrings))) {
    throw new OtaReadOnlyViolation(
      'Multiple statements or non-terminal semicolon detected',
      sql,
    );
  }
}

/**
 * Execute read-only query with audit log.
 * Caller passes an actual DB client (mysql2/pg/mongodb).
 */
export async function otaQueryReadOnly<T = any>(
  sql: string,
  params: any[] = [],
  executor: (sql: string, params: any[]) => Promise<T[]>,
): Promise<T[]> {
  const t0 = Date.now();
  const preview = (sql || '').slice(0, 200);

  // 1. Static validation
  try {
    assertReadOnly(sql);
  } catch (e) {
    // Audit log the blocked attempt
    try {
      trackEvent({
        event: 'ota_query_blocked',
        meta: {
          sql_preview: preview,
          reason: (e as Error).message,
          params_count: (params || []).length,
        },
      });
    } catch {}
    console.error(`[ota-guard] BLOCKED: ${(e as Error).message}`);
    throw e;
  }

  // 2. Execute via injected executor (mysql2, pg, etc.)
  try {
    const rows = await executor(sql, params);
    const ms = Date.now() - t0;

    // Audit success (sampling 10% to avoid log spam)
    if (Math.random() < 0.1) {
      try {
        trackEvent({
          event: 'ota_query_ok',
          meta: { sql_preview: preview, ms, row_count: Array.isArray(rows) ? rows.length : 0 },
        });
      } catch {}
    }

    return rows;
  } catch (e: any) {
    const ms = Date.now() - t0;
    try {
      trackEvent({
        event: 'ota_query_error',
        meta: { sql_preview: preview, ms, error: e?.message || String(e) },
      });
    } catch {}
    throw e;
  }
}

/**
 * Tests — run on startup to verify guard works.
 * Throws if any self-test fails → app fail-fast.
 */
export function selfTest(): void {
  // Positive tests — phải PASS
  const allowed = [
    'SELECT * FROM hotels',
    'SELECT id, name FROM hotels WHERE city = ?',
    'SHOW TABLES',
    'DESCRIBE hotels',
    'EXPLAIN SELECT * FROM rooms',
    'WITH t AS (SELECT id FROM hotels) SELECT * FROM t',
    '  select 1  ',
  ];
  for (const sql of allowed) {
    try {
      assertReadOnly(sql);
    } catch (e) {
      throw new Error(`[ota-guard self-test] false-positive block: "${sql}" - ${(e as Error).message}`);
    }
  }

  // Negative tests — phải bị BLOCK
  const forbidden = [
    'INSERT INTO hotels VALUES (1)',
    'UPDATE hotels SET name = "x"',
    'DELETE FROM hotels',
    'DROP TABLE hotels',
    'TRUNCATE TABLE hotels',
    'ALTER TABLE hotels ADD COLUMN x INT',
    'CREATE TABLE x (id INT)',
    'REPLACE INTO hotels VALUES (1)',
    'GRANT ALL ON hotels TO user',
    'SELECT * FROM hotels; DELETE FROM hotels',  // multi-stmt
    'SELECT * FROM hotels; DROP TABLE hotels',
    'WITH t AS (INSERT INTO hotels VALUES (1) RETURNING *) SELECT * FROM t', // CTE with INSERT
    '  ',  // empty
    'random text',
  ];
  for (const sql of forbidden) {
    let blocked = false;
    try {
      assertReadOnly(sql);
    } catch {
      blocked = true;
    }
    if (!blocked) {
      throw new Error(`[ota-guard self-test] failed to block: "${sql}"`);
    }
  }

  console.log('[ota-guard] self-test passed ✅ (7 allowed + 13 blocked verified)');
}

// Chạy self-test ngay khi module load — fail-fast nếu guard hỏng
selfTest();
