/**
 * Recovery History — session-persistent recovery execution records.
 */

const STORAGE_KEY = "fbl_recovery_history_v1";

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

export function isFaultAutoRecovered(faultId) {
  return memory.some((r) => r.faultId === faultId && r.result === "success");
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
