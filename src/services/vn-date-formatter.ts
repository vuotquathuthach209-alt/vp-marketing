/**
 * VN Date Formatter — format date theo cách người Việt hay nói.
 *
 * Vấn đề: Bot hiện output `2026-04-23` — lạnh, máy móc, khách không nói như vậy.
 * Thay bằng: `hôm nay (23/4)`, `ngày mai (24/4)`, `thứ 5 này (25/4)`, `thứ 5 tuần sau (30/4)`...
 *
 * Cũng xuất `is_same_day_checkin` flag để bot escalate gấp khi khách book ngày hôm đó.
 */

const VN_TZ_OFFSET_MS = 7 * 3600_000;
const WEEKDAY_VN = ['Chủ nhật', 'thứ 2', 'thứ 3', 'thứ 4', 'thứ 5', 'thứ 6', 'thứ 7'];

/** Return date adjusted to VN tz (Asia/Ho_Chi_Minh, UTC+7). */
function toVnDate(d: Date | string | number): Date {
  const base = typeof d === 'string' ? new Date(d) : (d instanceof Date ? d : new Date(d));
  // Get the *calendar date* in VN tz by shifting UTC ms by +7h
  return new Date(base.getTime() + VN_TZ_OFFSET_MS);
}

/** Strip time portion — return YYYY-MM-DD (VN tz). */
function vnDayStr(d: Date | string | number): string {
  const v = toVnDate(d);
  return v.toISOString().slice(0, 10);
}

/** Count days between two dates (VN day boundary). */
function daysBetween(a: Date | string | number, b: Date | string | number): number {
  const msPerDay = 86_400_000;
  const ta = Date.parse(vnDayStr(a) + 'T00:00:00Z');
  const tb = Date.parse(vnDayStr(b) + 'T00:00:00Z');
  return Math.round((tb - ta) / msPerDay);
}

export interface FormatDateOptions {
  /** Reference date (default = now). */
  reference?: Date | string | number;
  /** Include year if date > 60 days away. Default true. */
  includeYear?: boolean;
  /** Short mode: only `23/4` (no weekday). Default false. */
  short?: boolean;
}

export interface FormatDateResult {
  display: string;             // "hôm nay (23/4)"
  iso: string;                 // "2026-04-23"
  is_same_day: boolean;        // true if check-in is today
  is_tomorrow: boolean;        // true if check-in is tomorrow
  days_until: number;          // 0 = today, 1 = tomorrow, -1 = yesterday
  weekday_vn: string;          // "thứ 5"
}

/**
 * Format an ISO date (YYYY-MM-DD) or Date object the way Vietnamese speakers
 * naturally refer to dates.
 */
export function formatDateVN(
  date: string | Date | number | null | undefined,
  opts: FormatDateOptions = {},
): FormatDateResult | null {
  if (!date) return null;
  let iso: string;
  try {
    iso = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : vnDayStr(date);
  } catch { return null; }

  const ref = opts.reference ? vnDayStr(opts.reference) : vnDayStr(Date.now());
  const days = daysBetween(ref, iso);
  const target = toVnDate(iso + 'T00:00:00Z');
  const weekday = WEEKDAY_VN[target.getUTCDay()];

  // Parts: "23/4" or "23/4/2026"
  const day = target.getUTCDate();
  const month = target.getUTCMonth() + 1;
  const year = target.getUTCFullYear();
  const nowYear = toVnDate(ref + 'T00:00:00Z').getUTCFullYear();
  const showYear = opts.includeYear !== false && (year !== nowYear || Math.abs(days) > 180);
  const ddmm = `${day}/${month}${showYear ? '/' + year : ''}`;

  let display: string;
  if (opts.short) {
    display = weekday + ', ' + ddmm;
  } else if (days === 0) {
    display = `hôm nay (${ddmm})`;
  } else if (days === 1) {
    display = `ngày mai (${ddmm})`;
  } else if (days === 2) {
    display = `ngày kia (${ddmm})`;
  } else if (days === -1) {
    display = `hôm qua (${ddmm})`;
  } else if (days > 2 && days <= 7) {
    display = `${weekday} này (${ddmm})`;
  } else if (days > 7 && days <= 14) {
    display = `${weekday} tuần sau (${ddmm})`;
  } else if (days < 0) {
    display = `${ddmm} (đã qua ${Math.abs(days)} ngày)`;
  } else {
    display = `${weekday}, ${ddmm}`;
  }

  return {
    display,
    iso,
    is_same_day: days === 0,
    is_tomorrow: days === 1,
    days_until: days,
    weekday_vn: weekday,
  };
}

/**
 * Shortcut: format and return only display string, empty if invalid.
 */
export function formatDateVNDisplay(date: string | Date | number | null | undefined, opts?: FormatDateOptions): string {
  return formatDateVN(date, opts)?.display || '';
}

/**
 * Check-in urgency label for bot escalation logic.
 */
export function checkinUrgency(date: string | Date | number | null | undefined): 'same_day' | 'tomorrow' | 'soon' | 'future' | null {
  const r = formatDateVN(date);
  if (!r) return null;
  if (r.is_same_day) return 'same_day';
  if (r.is_tomorrow) return 'tomorrow';
  if (r.days_until > 1 && r.days_until <= 3) return 'soon';
  return 'future';
}
