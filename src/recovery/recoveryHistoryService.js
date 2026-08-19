/**
 * Recovery History — session-persistent recovery execution records.
 *
 * recoveryStatus is the source of truth for whether the *fault* recovered.
 * ACTION_SUCCESS alone must never mark a fault Recovered.
 */

const STORAGE_KEY = "fbl_recovery_history_v1";

/** Canonical recovery lifecycle states (ACTION_SUCCESS ≠ RECOVERED). */
export const RECOVERY_STATUS = {
  ACTION_PENDING: "ACTION_PENDING",
  ACTION_EXECUTING: "ACTION_EXECUTING",
  ACTION_SUCCESS: "ACTION_SUCCESS",
  ACTION_FAILED: "ACTION_FAILED",
  VERIFYING: "VERIFYING",
  RECOVERED: "RECOVERED",
  STILL_ACTIVE: "STILL_ACTIVE",
  RECOVERY_FAILED: "RECOVERY_FAILED",
  VERIFICATION_UNAVAILABLE: "VERIFICATION_UNAVAILABLE",
};

function load() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(records) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-100)));
  } catch {
    /* ignore */
  }
}

let memory = load();

export function getRecoveryHistory(faultId = null) {
  if (!faultId) return [...memory];
  return memory.filter((r) => r.faultId === faultId);
}

export function getLatestRecovery(faultId) {
  return getRecoveryHistory(faultId).slice(-1)[0] || null;
}

/**
 * True only when the latest recovery record for this fault confirmed
 * the fault condition cleared — never when only the kill/pause command succeeded.
 */
export function isFaultAutoRecovered(faultId) {
  if (!faultId) return false;
  const latest = getLatestRecovery(faultId);
  if (!latest) return false;

  if (latest.recoveryStatus === RECOVERY_STATUS.RECOVERED) return true;
  if (
    latest.recoveryStatus === RECOVERY_STATUS.STILL_ACTIVE ||
    latest.recoveryStatus === RECOVERY_STATUS.RECOVERY_FAILED ||
    latest.recoveryStatus === RECOVERY_STATUS.VERIFICATION_UNAVAILABLE ||
    latest.recoveryStatus === RECOVERY_STATUS.ACTION_FAILED ||
    latest.recoveryStatus === RECOVERY_STATUS.ACTION_SUCCESS
  ) {
    return false;
  }

  // Legacy recommendation-path records: result "success" only counts when
  // verificationStatus explicitly indicates fault clearance.
  const vs = String(latest.verificationStatus || "").toLowerCase();
  if (latest.result === "success" && (vs === "success" || vs === "recovered")) {
    return true;
  }
  return false;
}

export function getFaultRecoveryOverlay(faultId) {
  const latest = getLatestRecovery(faultId);
  if (!latest) return null;
  return {
    recoveryStatus: latest.recoveryStatus || null,
    actionStatus: latest.actionStatus || null,
    verificationOutcome: latest.verificationOutcome || latest.reason || null,
    result: latest.result || null,
    recovered: isFaultAutoRecovered(faultId),
    selectedAction: latest.selectedAction || null,
    pid: latest.params?.pid ?? latest.pid ?? null,
    processName: latest.processName || latest.params?.processName || null,
  };
}

export function recordRecoveryExecution(record) {
  memory.push({
    ...record,
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: record.timestamp || new Date().toISOString(),
  });
  save(memory);
  notifyRecoveryHistoryChanged();
  return memory[memory.length - 1];
}

export function subscribeRecoveryHistory(callback) {
  const handler = () => callback([...memory]);
  window.addEventListener("fbl-recovery-history", handler);
  return () => window.removeEventListener("fbl-recovery-history", handler);
}

export function notifyRecoveryHistoryChanged() {
  window.dispatchEvent(new CustomEvent("fbl-recovery-history"));
}

const RESOLVED_KEY = "fbl_resolved_faults_v1";
const SEEN_KEY = "fbl_seen_active_faults_v1";

function loadJson(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function snapshotFault(fault) {
  if (!fault) return null;
  return {
    id: fault.id,
    component: fault.component,
    severity: fault.severity,
    metricName: fault.metricName,
    currentValue: fault.currentValue,
    thresholdCrossed: fault.thresholdCrossed,
    faultDescription: fault.faultDescription,
    detected: fault.detected,
    source: fault.source,
  };
}

export function getResolvedFaults() {
  const rows = loadJson(RESOLVED_KEY, []);
  return [...rows].sort((a, b) =>
    String(b.resolvedAt || "").localeCompare(String(a.resolvedAt || ""))
  );
}

function upsertResolvedFault(entry) {
  if (!entry?.id) return;
  const rows = loadJson(RESOLVED_KEY, []);
  const next = {
    ...entry,
    status: RECOVERY_STATUS.RECOVERED,
    resolvedAt: entry.resolvedAt || new Date().toISOString(),
  };
  const idx = rows.findIndex((r) => r.id === entry.id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...next };
  else rows.push(next);
  saveJson(RESOLVED_KEY, rows.slice(-200));
}

export function updateLatestRecovery(faultId, patch) {
  if (!faultId) return null;
  for (let i = memory.length - 1; i >= 0; i -= 1) {
    if (memory[i].faultId === faultId) {
      memory[i] = { ...memory[i], ...patch };
      save(memory);
      notifyRecoveryHistoryChanged();
      return memory[i];
    }
  }
  return null;
}

function pendingVerificationStatuses() {
  return new Set([
    RECOVERY_STATUS.VERIFYING,
    RECOVERY_STATUS.ACTION_SUCCESS,
  ]);
}

/**
 * After a remediation action, keep VERIFYING until live monitoring no longer
 * reports the same fault. Then mark RECOVERED and archive to Resolved Faults.
 * Never uses a fixed timer.
 */
export function reconcileFaultLifecycle(liveFaults = []) {
  const live = Array.isArray(liveFaults) ? liveFaults : [];
  const liveIds = new Set(live.map((f) => f.id).filter(Boolean));
  const pending = pendingVerificationStatuses();
  let changed = false;

  const latestByFault = new Map();
  for (const rec of memory) {
    if (rec.faultId) latestByFault.set(rec.faultId, rec);
  }

  for (const [faultId, rec] of latestByFault) {
    const status = rec.recoveryStatus || rec.actionStatus;
    if (!pending.has(status) && rec.result !== "pending_verification") continue;
    if (liveIds.has(faultId)) continue;

    const resolvedAt = new Date().toISOString();
    const snap = rec.faultSnapshot || {};
    rec.recoveryStatus = RECOVERY_STATUS.RECOVERED;
    rec.result = "success";
    rec.verificationOutcome =
      "Monitoring confirmed the component returned to a healthy state.";
    rec.resolvedAt = resolvedAt;
    upsertResolvedFault({
      id: faultId,
      component: snap.component || rec.component,
      severity: snap.severity,
      metricName: snap.metricName || rec.metricName,
      faultDescription: snap.faultDescription,
      detected: snap.detected || rec.faultDetectedAt || rec.timestamp,
      resolvedAt,
      recoveryAction: rec.selectedAction?.label || rec.action || rec.commandExecuted,
      rca: rec.rca || null,
      currentValue: snap.currentValue,
      thresholdCrossed: snap.thresholdCrossed,
      status: RECOVERY_STATUS.RECOVERED,
    });
    changed = true;
  }
  if (changed) save(memory);

  const seen = loadJson(SEEN_KEY, {});
  for (const fault of live) {
    if (!fault?.id || !String(fault.id).startsWith("threshold-")) continue;
    if (fault.status === "Recovered") continue;
    if (!seen[fault.id]) {
      seen[fault.id] = {
        ...snapshotFault(fault),
        firstSeen: fault.detected || new Date().toISOString(),
      };
    }
  }
  for (const [id, snap] of Object.entries(seen)) {
    if (liveIds.has(id)) continue;
    const latest = latestByFault.get(id);
    const alreadyRecovered =
      latest?.recoveryStatus === RECOVERY_STATUS.RECOVERED ||
      getResolvedFaults().some((r) => r.id === id);
    if (!alreadyRecovered) {
      const resolvedAt = new Date().toISOString();
      upsertResolvedFault({
        id,
        component: snap.component,
        severity: snap.severity,
        metricName: snap.metricName,
        faultDescription: snap.faultDescription,
        detected: snap.firstSeen || snap.detected,
        resolvedAt,
        recoveryAction: latest?.selectedAction?.label || "Monitoring confirmed healthy",
        currentValue: snap.currentValue,
        thresholdCrossed: snap.thresholdCrossed,
        status: RECOVERY_STATUS.RECOVERED,
      });
      changed = true;
    }
    delete seen[id];
  }
  saveJson(SEEN_KEY, seen);
  if (changed) notifyRecoveryHistoryChanged();
}
