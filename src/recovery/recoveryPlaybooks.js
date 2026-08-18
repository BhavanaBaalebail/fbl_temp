/**
 * Recovery Playbooks — legacy match helpers; recommendations drive the new workflow.
 */

import {
  hasRecoveryRecommendations,
  getRecommendationCatalogForFault,
} from "./recoveryRecommendationCatalog";

/**
 * @param {object} fault
 * @returns {boolean}
 */
export function hasRecoveryPlaybook(fault) {
  return hasRecoveryRecommendations(fault);
}

/**
 * @param {object} fault
 * @returns {object|null}
 */
export function getPlaybookForFault(fault) {
  return getRecommendationCatalogForFault(fault);
}

/** @deprecated Legacy step-based playbooks — use recoveryRecommendationCatalog */
export const RECOVERY_PLAYBOOKS = [];
