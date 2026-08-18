/**
 * Fault Detection Service
 * Live fault data is supplied by link_health telemetry via useTelemetry.
 * These stubs remain for future dedicated fault API integration.
 */

import { faultLogRows, faultActionPlans, resolvedLogEntries } from "../data/faultData";

export async function fetchFaults() {
  return faultLogRows;
}

export async function getFaultDetails(componentId) {
  return faultActionPlans[componentId] || null;
}

export async function getResolvedFaults() {
  return resolvedLogEntries;
}

export function subscribeFaultUpdates() {
  return () => {};
}

export async function createFaultEntry(faultData) {
  return { id: Date.now(), ...faultData };
}

export async function resolveFault(faultId, resolutionData) {
  return { id: faultId, status: "RESOLVED", ...resolutionData };
}
