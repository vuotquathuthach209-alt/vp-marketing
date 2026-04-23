/**
 * Winner Selector — auto-select winner khi experiment reach min_sample_size.
 *
 * Logic:
 *   - For each running experiment, compute conversion_rate per variant
 *   - Conversion = (converted_to_lead + booked) / impressions
 *   - Statistical test (chi-square or z-test for proportions)
 *   - Nếu best variant's rate > 2nd-best AND significance p < 0.10 → promote winner
 *   - Stop experiment, mark is_winner=1 trên winner → 100% traffic
 *
 * Cron weekly.
 */

import { db } from '../db';

export interface WinnerSelectionResult {
  experiment_id: number;
  template_key: string;
  variants_evaluated: number;
  winner_id?: number;
  winner_name?: string;
  winner_conversion_rate?: number;
  runner_up_rate?: number;
  decision: 'promoted' | 'needs_more_data' | 'no_significant_difference' | 'skipped';
  reasons: string[];
}

/** Z-test for difference of 2 proportions (one-tailed). p-value approx. */
function zTestProportions(successA: number, totalA: number, successB: number, totalB: number): number {
  const pA = successA / totalA;
  const pB = successB / totalB;
  const pPool = (successA + successB) / (totalA + totalB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / totalA + 1 / totalB));
  if (se === 0) return 1.0;
  const z = (pA - pB) / se;
  // One-tailed p-value approx (for positive z, probability pA > pB by chance alone)
  // Using simple approximation: p ≈ 0.5 * erfc(z / sqrt(2))
  return 0.5 * erfc(z / Math.SQRT2);
}

// Approximation of erfc(x)
function erfc(x: number): number {
  // Abramowitz & Stegun approximation
  const z = Math.abs(x);
  const t = 1.0 / (1.0 + 0.5 * z);
  const erfcX = t * Math.exp(-z * z - 1.26551223 +
    t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
  );
  return x >= 0 ? erfcX : 2.0 - erfcX;
}

export function selectWinnerForExperiment(experimentId: number): WinnerSelectionResult {
  const exp = db.prepare(`SELECT * FROM reply_experiments WHERE id = ? AND status = 'running'`).get(experimentId) as any;
  if (!exp) {
    return { experiment_id: experimentId, template_key: '', variants_evaluated: 0, decision: 'skipped', reasons: ['experiment not running'] };
  }

  const variants = db.prepare(
    `SELECT id, variant_name, content, impressions, conversions, misunderstood, ghosted
     FROM reply_templates
     WHERE (hotel_id = ? OR hotel_id = 0) AND template_key = ? AND active = 1
     ORDER BY id`
  ).all(exp.hotel_id, exp.template_key) as any[];

  const result: WinnerSelectionResult = {
    experiment_id: experimentId,
    template_key: exp.template_key,
    variants_evaluated: variants.length,
    decision: 'needs_more_data',
    reasons: [],
  };

  // Need at least min_sample_size per variant
  const minSample = exp.min_sample_size || 50;
  const underpoweredCount = variants.filter(v => v.impressions < minSample).length;
  if (underpoweredCount > 0) {
    result.reasons.push(`${underpoweredCount}/${variants.length} variants below min_sample=${minSample}`);
    return result;
  }

  if (variants.length < 2) {
    result.decision = 'skipped';
    result.reasons.push('need at least 2 variants');
    return result;
  }

  // Compute rates
  const withRates = variants.map(v => ({
    ...v,
    conversion_rate: v.impressions > 0 ? v.conversions / v.impressions : 0,
    bad_rate: v.impressions > 0 ? (v.misunderstood + v.ghosted) / v.impressions : 0,
  }));
  withRates.sort((a, b) => b.conversion_rate - a.conversion_rate);

  const best = withRates[0];
  const runnerUp = withRates[1];

  result.winner_id = best.id;
  result.winner_name = best.variant_name;
  result.winner_conversion_rate = +best.conversion_rate.toFixed(4);
  result.runner_up_rate = +runnerUp.conversion_rate.toFixed(4);

  // Statistical significance test (one-tailed, p < 0.10 is enough for marketing decisions)
  const pValue = zTestProportions(best.conversions, best.impressions, runnerUp.conversions, runnerUp.impressions);
  result.reasons.push(`best=${best.variant_name}(${(best.conversion_rate*100).toFixed(1)}%) vs runner=${runnerUp.variant_name}(${(runnerUp.conversion_rate*100).toFixed(1)}%), p=${pValue.toFixed(3)}`);

  // Also check: improvement must be at least 15% relative
  const relImprovement = runnerUp.conversion_rate > 0
    ? (best.conversion_rate - runnerUp.conversion_rate) / runnerUp.conversion_rate
    : 1.0;

  if (pValue < 0.10 && relImprovement >= 0.15) {
    // Promote winner
    db.prepare(`UPDATE reply_templates SET is_winner = 1, updated_at = ? WHERE id = ?`).run(Date.now(), best.id);
    // Deactivate losers
    for (const v of withRates.slice(1)) {
      db.prepare(`UPDATE reply_templates SET is_winner = 0, active = 0, updated_at = ? WHERE id = ?`).run(Date.now(), v.id);
    }
    // Close experiment
    db.prepare(
      `UPDATE reply_experiments SET status = 'winner_selected', winner_variant_id = ?, winner_conversion_rate = ?, winner_selected_at = ?, ended_at = ? WHERE id = ?`
    ).run(best.id, best.conversion_rate, Date.now(), Date.now(), experimentId);

    result.decision = 'promoted';
    result.reasons.push(`+${(relImprovement * 100).toFixed(0)}% relative improvement`);
    console.log(`[winner-selector] PROMOTED ${exp.template_key}/${best.variant_name} (${(best.conversion_rate*100).toFixed(1)}% vs ${(runnerUp.conversion_rate*100).toFixed(1)}%)`);
  } else {
    result.decision = 'no_significant_difference';
    if (pValue >= 0.10) result.reasons.push(`p-value ${pValue.toFixed(3)} >= 0.10`);
    if (relImprovement < 0.15) result.reasons.push(`improvement ${(relImprovement*100).toFixed(1)}% < 15%`);
  }

  return result;
}

/** Run winner selection cho TẤT CẢ running experiments. Cron weekly. */
export function selectAllWinners(): WinnerSelectionResult[] {
  const running = db.prepare(`SELECT id FROM reply_experiments WHERE status = 'running'`).all() as any[];
  const results: WinnerSelectionResult[] = [];
  for (const r of running) {
    try {
      results.push(selectWinnerForExperiment(r.id));
    } catch (e: any) {
      console.warn(`[winner-selector] fail exp #${r.id}:`, e?.message);
    }
  }
  const promoted = results.filter(r => r.decision === 'promoted').length;
  if (results.length > 0) {
    console.log(`[winner-selector] evaluated ${results.length} experiments, ${promoted} promoted`);
  }
  return results;
}
