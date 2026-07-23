/**
 * Session-persistent report generation history.
 * Metadata persists in sessionStorage; file blobs kept in memory for re-download.
 */

const STORAGE_KEY = "fbl_report_history_v1";
const MAX_ENTRIES = 50;

let memory = load();
const blobStore = new Map();

function load() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    const serializable = memory.slice(-MAX_ENTRIES).map(
      ({ id, timestamp, status, name, reportType, formats, pageCount, fileSize, outputs }) => ({
        id,
        timestamp,
        status,
        name,
        reportType,
        formats,
        pageCount,
        fileSize,
        outputs,
      })
    );
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    /* ignore */
  }
}

function notify() {
  window.dispatchEvent(new CustomEvent("fbl-report-history"));
}

export function getReportHistory() {
  return [...memory].reverse();
}

export function addReportHistoryEntry(entry) {
  const { blobs, ...meta } = entry;
  const record = {
    id: `rpt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    status: "ready",
    ...meta,
  };
  if (blobs) {
    blobStore.set(record.id, blobs);
  }
  memory.push(record);
  persist();
  notify();
  return record;
}

export function getReportBlobs(id) {
  return blobStore.get(id) || null;
}

export function deleteReportHistoryEntry(id) {
  memory = memory.filter((r) => r.id !== id);
  blobStore.delete(id);
  persist();
  notify();
}

export function subscribeReportHistory(callback) {
  const handler = () => callback(getReportHistory());
  window.addEventListener("fbl-report-history", handler);
  return () => window.removeEventListener("fbl-report-history", handler);
}

export function formatFileSize(bytes) {
  if (bytes == null || bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
