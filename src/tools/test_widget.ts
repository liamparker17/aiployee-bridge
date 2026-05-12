/**
 * tools/test_widget.ts — thin re-export wrapper for the run_flow_test tool.
 *
 * Live behaviour lives in `src/client/test_widget.ts`. This file exists so the
 * tool surface is consistent with the rest of the tools façade.
 */

export type { RunFlowTestArgs, RunFlowTestResult } from "../client/test_widget.js";
export { runFlowTest } from "../client/test_widget.js";
