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
