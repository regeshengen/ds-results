// js/parser.js — k6 JSON parsing (mirrors app.py logic)

export const DURATION_METRIC_KEYS = [
  "duration_avg_ms",
  "duration_min_ms",
  "duration_med_ms",
  "duration_max_ms",
  "duration_p90_ms",
  "duration_p95_ms",
];

export const DURATION_METRIC_LABELS = {
  duration_avg_ms: "avg",
  duration_min_ms: "min",
  duration_med_ms: "med",
  duration_max_ms: "max",
  duration_p90_ms: "p(90)",
  duration_p95_ms: "p(95)",
};

/**
 * Mirrors pandas quantile with linear interpolation (default method).
 */
function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarizeFromJsonPoints(pointsByMetric) {
  const raw = (pointsByMetric["http_req_duration"] ?? []).map(([, v]) => v);

  if (!raw.length) {
    return Object.fromEntries(DURATION_METRIC_KEYS.map(k => [k, null]));
  }

  const sorted = [...raw].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);

  return {
    duration_avg_ms: sum / sorted.length,
    duration_min_ms: sorted[0],
    duration_med_ms: quantile(sorted, 0.5),
    duration_max_ms: sorted[sorted.length - 1],
    duration_p90_ms: quantile(sorted, 0.9),
    duration_p95_ms: quantile(sorted, 0.95),
  };
}

/**
 * Parses a k6 JSON output file (newline-delimited JSON).
 * Returns a summary dict with duration metrics in ms.
 */
export function parseK6Json(text) {
  const pointsByMetric = {};
  let firstTime = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    let item;
    try { item = JSON.parse(line); } catch { continue; }

    if (item.type !== "Point") continue;

    const { metric, data } = item;
    if (!metric || data?.value == null || !data?.time) continue;

    const ts = new Date(data.time).getTime();
    if (Number.isNaN(ts)) continue;

    if (firstTime === null) firstTime = ts;

    (pointsByMetric[metric] ??= []).push([(ts - firstTime) / 1000, data.value]);
  }

  return summarizeFromJsonPoints(pointsByMetric);
}

/**
 * Averages a list of summary dicts across all DURATION_METRIC_KEYS.
 */
export function averageSummaries(summaries) {
  return Object.fromEntries(
    DURATION_METRIC_KEYS.map(key => {
      const vals = summaries.map(s => s[key]).filter(v => v != null);
      return [key, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null];
    })
  );
}
