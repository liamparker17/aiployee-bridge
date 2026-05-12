/**
 * tools/flow_runs.ts - thin re-export wrapper for the flow-runs tool group.
 *
 * Live behaviour lives in `src/client/flow_runs.ts` (listing) and
 * `src/client/flow_run_detail.ts` (single-run detail). This file exists so
 * the tool surface is consistent with the rest of the tools facade.
 */

export type { FlowRunSummary } from "../client/flow_runs.js";
export { listFlowRuns } from "../client/flow_runs.js";

export type {
  TranscriptEntry,
  NodePathEntry,
  FlowRunDetail,
} from "../client/flow_run_detail.js";
export { getFlowRun } from "../client/flow_run_detail.js";
