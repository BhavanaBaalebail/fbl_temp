/**
 * Standalone validation of Predictive Maintenance scenarios
 * (mirrors engine rules without Vite path resolution).
 */
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sumT = 0, sumV = 0, sumTT = 0, sumTV = 0;
  for (const p of points) {
    sumT += p.t; sumV += p.v; sumTT += p.t * p.t; sumTV += p.t * p.v;
  }
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * sumTV - sumT * sumV) / denom;
  const intercept = (sumV - slope * sumT) / n;
  const meanV = sumV / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    const pred = intercept + slope * p.t;
    ssTot += (p.v - meanV) ** 2;
    ssRes += (p.v - pred) ** 2;
  }
  const r2 = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r2, n };
}

function scenario(name, points, warning, critical, minSlope) {
  const reg = linearRegression(points);
  const current = points[points.length - 1].v;
  const slopePerHour = reg.slope * 3600;
  const alreadyCritical = current >= critical;
  const meaningful = Math.abs(slopePerHour) >= minSlope;
  const degrading = slopePerHour > 0;
  const reliable = reg.r2 >= 0.35;
  let etaW = null, etaC = null, has = false, msg = "No significant degradation trend detected";
  if (alreadyCritical) {
    msg = "Already at or above critical threshold";
  } else if (points.length < 8) {
    msg = "Prediction unavailable — insufficient historical data";
  } else if (meaningful && degrading && reliable) {
    has = true;
    if (current < warning) etaW = (warning - current) / reg.slope;
    if (current < critical) etaC = (critical - current) / reg.slope;
  }
  console.log(name, {
    n: points.length,
    current: current.toFixed(2),
    slopePerHour: slopePerHour.toFixed(3),
    r2: reg.r2.toFixed(3),
    hasPrediction: has,
    etaWarnMin: etaW != null ? (etaW / 60).toFixed(1) : null,
    etaCritH: etaC != null ? (etaC / 3600).toFixed(2) : null,
    message: has ? null : msg,
  });
}

const now = Date.now() / 1000;
function series(n, step, startV, dV, noise = 0) {
  return Array.from({ length: n }, (_, i) => ({
    t: now - (n - 1 - i) * step,
    v: startV + dV * i + (noise ? Math.sin(i) * noise : 0),
  }));
}

scenario("1 rising CPU temp", series(48, 300, 70, 0.08), 75, 85, 0.15);
scenario("2 rising disk", series(72, 300, 78, 0.02), 80, 90, 0.05);
scenario("3 stable", series(48, 300, 60, 0), 75, 85, 0.15);
scenario("4 insufficient", series(3, 60, 70, 0.5), 75, 85, 0.15);
scenario("5 noisy", series(48, 300, 65, 0, 8), 75, 85, 0.15);
scenario("6 already critical", series(48, 300, 86, 0.05), 75, 85, 0.15);
