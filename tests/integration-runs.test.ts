/**
 * integration-runs.test.ts — LIVE tests for Phase 7:
 *   1. setFlowStatus no-op path on the sandbox flow (status already
 *      Inactive, target Inactive → changed:false; no PATCH).
 *   2. listFlowRuns() — assert at least one run exists in the live tenant
 *      (the demo tenant has dozens).
 *   3. getFlowRun(<one uuid from step 2>) — assert the parser ran without
 *      throwing and surfaced at least uuid + status + channel. Transcript
 *      may be empty in real cases (e.g. failed calls) so we don't assert
 *      length > 0 — but we do assert the array exists.
 *
 * runFlowTest is intentionally NOT live-tested — calling it would create a
 * real test-widget session the human would have to clean up manually.
 *
 * Gated by AIPLOYEE_BRIDGE_LIVE=1. Without it the suite is skipped
 * (visible in the test summary). With it set but no auth.json present the
 * suite fails fast.
 *
 * Sandbox safety:
 *   - The sandbox flow is asserted to be Inactive on entry. Step 1 only
 *     exercises the no-op short-circuit; no PATCH is issued. The test
 *     refuses to proceed if the flow is unexpectedly Active.
 *   - Step 2/3 are read-only.
 */

import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Client } from "../src/client/index.js";

// ---------------------------------------------------------------------------
// Sandbox invariants
// ---------------------------------------------------------------------------

const SANDBOX_FLOW_UUID = "b2deacdb-73d2-4b4e-b13a-b2de58dc7ebd"; // "Architect test 1"

const LIVE = process.env.AIPLOYEE_BRIDGE_LIVE === "1";
const SUITE_SKIP_REASON = LIVE
  ? false
  : "AIPLOYEE_BRIDGE_LIVE!=1 — skipping live Phase 7 integration tests (set env var to run)";

describe(
  "integration-runs: live Phase 7 surfaces (set_flow_status / list_flow_runs / get_flow_run)",
  { skip: SUITE_SKIP_REASON },
  () => {
    let client: Client | null = null;

    before(async () => {
      // Fail fast if env is set but auth file is missing.
      const authFilePath = path.join(homedir(), ".aiployee-bridge", "auth.json");
      try {
        await fs.access(authFilePath);
      } catch {
        throw new Error(
          `AIPLOYEE_BRIDGE_LIVE=1 but ${authFilePath} is missing — ` +
            `run \`aiployee-bridge auth --token <value>\` first`,
        );
      }
      client = await Client.fromAuthFile();
    });

    // -------------------------------------------------------------------
    // Step 1: setFlowStatus no-op path
    // -------------------------------------------------------------------
    it("setFlowStatus no-op: sandbox flow already Inactive → changed:false", async () => {
      assert.ok(client, "client must be initialised");
      const { listFlows, setFlowStatus } = await import("../src/tools/flows.js");

      const flows = await listFlows(client);
      const sandbox = flows.find((f) => f.uuid === SANDBOX_FLOW_UUID);
      assert.ok(sandbox, `sandbox flow ${SANDBOX_FLOW_UUID} not found in listFlows`);

      // Sandbox safety: refuse to proceed if the sandbox flow is Active.
      // The no-op path is only safe when current === target === Inactive.
      assert.equal(
        sandbox.status,
        "Inactive",
        `SANDBOX GUARD: sandbox flow ${SANDBOX_FLOW_UUID} is unexpectedly ${sandbox.status}; ` +
          `aborting before any PATCH risk`,
      );

      const result = await setFlowStatus(client, {
        uuid: SANDBOX_FLOW_UUID,
        status: "Inactive",
        confirm: sandbox.name,
      });

      assert.equal(result.changed, false, "no-op path should report changed:false");
      assert.equal(result.previousStatus, "Inactive");
      assert.equal(result.newStatus, "Inactive");
      assert.deepEqual(result.phoneNumbersAffected, []);
    });

    // -------------------------------------------------------------------
    // Step 2: listFlowRuns — at least one run exists
    // -------------------------------------------------------------------
    let firstRunUuid: string | null = null;

    it("listFlowRuns returns at least one record from the live tenant", async () => {
      assert.ok(client, "client must be initialised");
      const { listFlowRuns } = await import("../src/tools/flow_runs.js");

      const runs = await listFlowRuns(client, { limit: 5 });
      assert.ok(Array.isArray(runs), "result should be an array");
      assert.ok(runs.length >= 1, `expected at least one run, got ${runs.length}`);

      const first = runs[0]!;
      assert.ok(typeof first.uuid === "string" && first.uuid.length === 36, "first.uuid should be a UUID");
      assert.ok(typeof first.status === "string");
      assert.ok(typeof first.channel === "string");

      firstRunUuid = first.uuid;
    });

    // -------------------------------------------------------------------
    // Step 3: getFlowRun on the first run from step 2
    // -------------------------------------------------------------------
    it("getFlowRun parses the detail page for the first run uuid", async () => {
      assert.ok(client, "client must be initialised");
      assert.ok(firstRunUuid, "step 2 must have set firstRunUuid");

      const { getFlowRun } = await import("../src/tools/flow_runs.js");
      const detail = await getFlowRun(client, firstRunUuid);

      assert.equal(detail.uuid, firstRunUuid);
      assert.ok(typeof detail.status === "string", "status should be a string (may be 'unknown' on parse miss)");
      assert.ok(typeof detail.channel === "string", "channel should be a string");
      assert.ok(Array.isArray(detail.transcript), "transcript should be an array (possibly empty)");
      assert.ok(detail.metadata && typeof detail.metadata === "object", "metadata should be an object");
    });
  },
);
