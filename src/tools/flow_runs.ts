/**
 * tools/flow_runs.ts — thin re-export wrapper for the flow-runs tool group.
 *
 * Live behaviour lives in `src/client/flow_runs.ts`. This file exists so the
 * tool surface is consistent with the rest of the tools façade (flows.ts,
 * agents.ts, etc.) — callers import from "aiployee-bridge/tools".
 */

export type { FlowRunSummary } from "../client/flow_runs.js";
export { listFlowRuns, parseDurationS, extractFlowRunsFromHtml } from "../client/flow_runs.js";
