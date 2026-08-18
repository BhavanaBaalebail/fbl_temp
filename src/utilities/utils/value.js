/**
 * Value helpers for Utilities UI.
 */

export function hasValue(v) {
  if (v == null) return false;
  if (v === "") return false;
  if (typeof v === "number" && Number.isNaN(v)) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}
