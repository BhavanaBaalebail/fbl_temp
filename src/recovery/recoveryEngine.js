/**
 * Legacy recovery engine — re-exports workflow engine for backward compatibility.
 */

export {
  analyzeRecovery,
  executeApprovedRecovery,
  buildRecoveryContext,
  createTimelineEvent,
} from "./recoveryWorkflowEngine";

/** @deprecated */
export const RECOVERY_PHASES = [
  { id: "analyze", label: "Analyze Fault" },
  { id: "recommend", label: "Generate Recommendations" },
  { id: "approve", label: "User Approval" },
  { id: "execute", label: "Execute Recovery Action" },
  { id: "verify", label: "Verify Hardware State" },
];

/** @deprecated Use executeApprovedRecovery */
export async function executeRecovery() {
  throw new Error("executeRecovery is deprecated. Use executeApprovedRecovery with user-selected action.");
}
