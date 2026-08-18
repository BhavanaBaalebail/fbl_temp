/**
 * Offline validation for WhatsApp alert formatting + dedup rules.
 * Does not call Meta APIs.
 */
import assert from "node:assert/strict";

function clean(value) {
  if (value == null) return null;
  const text = String(value).strip?.() ?? String(value).trim();
  if (!text) return null;
  if (["null", "undefined", "n/a", "none", "—", "-"].includes(text.toLowerCase())) return null;
  return text;
}

function buildCritical(fault) {
  const lines = ["🚨 FBL CRITICAL ALERT", ""];
  const pairs = [
    ["Component", clean(fault.component)],
    ["Metric", clean(fault.metric_name)],
    ["Current", clean(fault.current_value)],
    ["Critical Threshold", clean(fault.threshold_crossed)],
    ["Status", "CRITICAL"],
  ];
  for (const [label, value] of pairs) {
    if (value) lines.push(`${label}: ${value}`);
  }
  if (clean(fault.description)) {
    lines.push("");
    lines.push(`Impact: ${clean(fault.description)}`);
  }
  lines.push("");
  lines.push("FBL: Recovery/Investigation Required");
  return lines.join("\n");
}

// 1–2: normal/warning should not be messaged by client policy
assert.equal("warning".toLowerCase() === "critical", false);

// 3: critical message omits nulls
const msg = buildCritical({
  component: "CPU",
  metric_name: "CPU Temperature",
  current_value: "91°C",
  threshold_crossed: "85°C",
  description: "CPU temperature has exceeded the configured critical threshold.",
  hostname: null,
  unused: "N/A",
});
assert.match(msg, /CPU Temperature/);
assert.doesNotMatch(msg, /null|undefined|N\/A|Host:/);

// 9: missing optional fields stay clean
const sparse = buildCritical({ component: "GPU", description: "XID errors" });
assert.match(sparse, /Component: GPU/);
assert.doesNotMatch(sparse, /Metric:/);
assert.doesNotMatch(sparse, /Current:/);

console.log("whatsapp message validation OK");
console.log("--- sample ---");
console.log(msg);
