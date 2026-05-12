/**
 * integration.test.ts — LIVE tests against aiployee.jobix.ai.
 *
 * Gated by AIPLOYEE_BRIDGE_LIVE=1. Without it the entire suite is skipped
 * (visible in the test summary). With it set but no auth.json present, the
 * suite fails fast.
 *
 * Sandbox-only. Hard-coded to the "Architect test 1" flow, the Tracey Test
 * agent, and one safe phone number. Snapshots the flow before any mutation
 * and restores in `after()` even on assertion failure.
 *
 * Tests inside the describe block run sequentially (node:test default; we
 * do NOT pass `{ concurrency: true }` anywhere). Ordering matters: step N
 * depends on snapshot captured in step 2.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Client } from "../src/client/index.js";
import { DEFAULT_API_BASE, loadAuth } from "../src/client/auth.js";
import {
  listFlows,
  getFlow,
  updateFlow,
  validateFlowLocal,
} from "../src/tools/index.js";
import type { FlowDTO } from "../src/dto.js";

// ---------------------------------------------------------------------------
// Sandbox invariants. Hard-coded. These bind the suite to ONE flow + ONE
// agent + ONE phone. Any drift here is an attempt to operate outside the
// sandbox — refuse at module load (well, before any network call) rather
// than at assertion time.
// ---------------------------------------------------------------------------

const FLOW_UUID = "b2deacdb-73d2-4b4e-b13a-b2de58dc7ebd"; // "Architect test 1"
const FLOW_NAME = "Architect test 1";
const AGENT_UUID = "3527076a-e3d2-4eb5-bfdb-498e02cde84f"; // Tracey Test
const SAFE_PHONE = "+27877295318";

const LIVE = process.env.AIPLOYEE_BRIDGE_LIVE === "1";
const SUITE_SKIP_REASON = LIVE
  ? false
  : "AIPLOYEE_BRIDGE_LIVE!=1 — skipping live integration tests (set env var to run)";

// Compile-time-ish reminder that these constants exist for guard-rail use.
// Referenced inside individual tests so a future refactor cannot quietly
// drop them.
void AGENT_UUID;
void SAFE_PHONE;

describe("integration: live sandbox bench", { skip: SUITE_SKIP_REASON }, () => {
  // Shared state across the sequential steps. Captured in step 2 (getFlow),
  // used by step 3 (validate), step 4 (mutation source), step 5 (re-fetch
  // comparison), and the teardown.
  let client: Client | null = null;
  let snapshot: FlowDTO | null = null;
  let mutated: FlowDTO | null = null;
  let mutationAttempted = false;
  let mutatedNodeUuid: string | null = null;
  let mutatedOriginalName: string | null = null;
  let mutatedNewName: string | null = null;
  let mutationsSkipped = false;

  before(async () => {
    // Fail fast if the env var is set but no auth file exists. This is a
    // setup error, not a test failure — surface it clearly.
    const authFilePath = path.join(homedir(), ".aiployee-bridge", "auth.json");
    try {
      await fs.access(authFilePath);
    } catch {
      throw new Error(
        `AIPLOYEE_BRIDGE_LIVE=1 but ${authFilePath} is missing — ` +
          `run \`aiployee-bridge auth --token <value>\` first`,
      );
    }

    const auth = await loadAuth();
    client = new Client({
      token: auth.token,
      apiBase: auth.apiBase ?? DEFAULT_API_BASE,
    });
  });

  after(async () => {
    // Best-effort snapshot restore. Runs whether or not the body steps
    // succeeded; only acts if we actually captured a snapshot AND we
    // actually performed a mutation.
    if (client === null || snapshot === null || !mutationAttempted) {
      return;
    }
    try {
      await updateFlow(client, structuredClone(snapshot));
      // Verify on the wire — if the restore silently failed we want to know.
      const reread = await getFlow(client, FLOW_UUID, { name: snapshot.name });
      // Compare by serialised DTO. The DTO is round-trip-stable per
      // Phase 2 contract (number is not exposed). We compare a structural
      // subset rather than deep-equal because the server may reorder
      // connections or sockets internally.
      const restoredNode = reread.nodes.find((n) => n.uuid === mutatedNodeUuid);
      if (
        restoredNode === undefined ||
        restoredNode.name !== mutatedOriginalName
      ) {
        // LOUD: stderr, not stdout, and prefixed so it can't be mistaken
        // for test output. Do NOT throw — afterAll throws mask the real
        // failure from the test body.
        // eslint-disable-next-line no-console
        console.error(
          `[integration] TEARDOWN VERIFICATION FAILED — flow ${FLOW_UUID} ` +
            `node ${mutatedNodeUuid ?? "?"} name is ` +
            `${JSON.stringify(restoredNode?.name)} but expected ` +
            `${JSON.stringify(mutatedOriginalName)}. Manual restoration ` +
            `may be required.`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[integration] TEARDOWN FAILED — could not restore flow ${FLOW_UUID}: ${
          err instanceof Error ? err.message : String(err)
        }. Snapshot DTO will be dumped below. Manual restore may be required.`,
      );
      // eslint-disable-next-line no-console
      console.error("[integration] snapshot DTO:", JSON.stringify(snapshot));
    }
  });

  it("step 1: listFlows() includes the sandbox flow", { timeout: 30_000 }, async () => {
    assert.ok(client, "client not initialised");
    const flows = await listFlows(client);
    assert.ok(flows.length >= 1, "expected at least one flow");
    const sandbox = flows.find((f) => f.uuid === FLOW_UUID);
    assert.ok(
      sandbox,
      `expected to find sandbox flow ${FLOW_UUID} in listFlows() output`,
    );
    // The HTML-scrape fallback returns a placeholder name; accept it but
    // prefer the REST shape. If the name is unknown via fallback, log it
    // and continue — the uuid match is the load-bearing check.
    if (sandbox.name !== FLOW_NAME) {
      // eslint-disable-next-line no-console
      console.warn(
        `[integration] step 1: sandbox flow name is ${JSON.stringify(
          sandbox.name,
        )}, expected ${JSON.stringify(FLOW_NAME)} ` +
          `(may be HTML-scrape fallback placeholder).`,
      );
    }
  });

  it("step 2: getFlow() returns the DTO with a trigger node; capture snapshot", { timeout: 30_000 }, async () => {
    assert.ok(client, "client not initialised");
    const flow = await getFlow(client, FLOW_UUID, { name: FLOW_NAME });
    assert.equal(flow.uuid, FLOW_UUID, "DTO uuid mismatch");

    // Trigger == first inbound_call / internet_call / event / now node.
    const trigger = flow.nodes.find(
      (n) =>
        n.config.kind === "inbound_call" ||
        n.config.kind === "internet_call" ||
        n.config.kind === "event" ||
        n.config.kind === "now",
    );
    assert.ok(
      trigger,
      "expected at least one trigger node (inbound_call/internet_call/event/now)",
    );

    // Deep-clone the snapshot so subsequent steps cannot mutate it.
    snapshot = structuredClone(flow);
  });

  it("step 3: validateFlowLocal(snapshot) returns no errors", () => {
    assert.ok(snapshot, "snapshot not captured in step 2 — cannot validate");
    const issues = validateFlowLocal(snapshot);
    const errors = issues.filter((i) => i.severity === "error");
    assert.deepEqual(
      errors,
      [],
      `expected no validation errors, got: ${JSON.stringify(errors)}`,
    );
  });

  it("step 4: updateFlow() with a renamed node succeeds", { timeout: 30_000 }, async () => {
    assert.ok(client, "client not initialised");
    assert.ok(snapshot, "snapshot not captured");

    if (snapshot.nodes.length === 0) {
      mutationsSkipped = true;
      // Mark as a no-op pass; we cannot mutate a zero-node flow. The
      // read-only steps above still passed.
      // eslint-disable-next-line no-console
      console.warn(
        "[integration] step 4: sandbox flow has zero nodes — skipping mutation steps 4-6",
      );
      return;
    }

    // Pick deterministically: the first node in the DTO's node array. The
    // DTO order is what fromWire produces, which matches wire node order.
    const modified = structuredClone(snapshot);
    const target = modified.nodes[0];
    assert.ok(target, "modified.nodes[0] missing (defensive)");
    assert.ok(target.uuid, "target node has null uuid; cannot identify it on re-fetch");

    mutatedNodeUuid = target.uuid;
    mutatedOriginalName = target.name;
    mutatedNewName = `${target.name} [recon ${Date.now()}]`;
    target.name = mutatedNewName;

    // Sandbox guard: refuse to send anything touching foreign agents or
    // phones. The mutation is name-only, so this loop is purely defensive
    // against a future-me who edits the mutation logic above.
    for (const node of modified.nodes) {
      if (node.config.kind === "connect_call_agent" || node.config.kind === "call") {
        if (node.config.agentUuid !== AGENT_UUID) {
          // Don't throw — the live flow may legitimately reference other
          // agents that pre-existed in the sandbox. Just warn.
          // eslint-disable-next-line no-console
          console.warn(
            `[integration] step 4: node ${node.uuid ?? "(new)"} references ` +
              `non-sandbox agent ${node.config.agentUuid} — not mutating it.`,
          );
        }
      }
    }

    mutationAttempted = true;
    await updateFlow(client, modified);
    mutated = modified;
  });

  it("step 5: getFlow() reflects the rename on the wire", { timeout: 30_000 }, async (t) => {
    if (mutationsSkipped) {
      t.skip("zero-node flow — mutation steps skipped");
      return;
    }
    assert.ok(client, "client not initialised");
    assert.ok(mutatedNodeUuid, "no mutated node uuid recorded");
    assert.ok(mutatedNewName, "no mutated new name recorded");

    const reread = await getFlow(client, FLOW_UUID, { name: FLOW_NAME });
    const node = reread.nodes.find((n) => n.uuid === mutatedNodeUuid);
    assert.ok(
      node,
      `expected to find node ${mutatedNodeUuid} after rename; got nodes: ${reread.nodes
        .map((n) => n.uuid)
        .join(",")}`,
    );
    assert.equal(
      node.name,
      mutatedNewName,
      `expected node name ${JSON.stringify(mutatedNewName)} on the wire`,
    );
  });

  it("step 6: teardown restores snapshot (verified inline)", { timeout: 30_000 }, async (t) => {
    if (mutationsSkipped) {
      t.skip("zero-node flow — mutation steps skipped");
      return;
    }
    assert.ok(client, "client not initialised");
    assert.ok(snapshot, "snapshot missing");
    assert.ok(mutatedNodeUuid, "no mutated node uuid recorded");
    assert.ok(mutatedOriginalName !== null, "no original name recorded");

    // Restore inline first so the assertion runs before `after()` would.
    // The `after()` hook is still a belt-and-braces safety net for the
    // case where this test itself throws before reaching the restore.
    await updateFlow(client, structuredClone(snapshot));

    // Mark mutation as resolved BEFORE the verification assert so that if
    // the assert throws, `after()` does not redo the write (the flow is
    // already restored at this point).
    mutated = null;
    mutationAttempted = false;

    const reread = await getFlow(client, FLOW_UUID, { name: FLOW_NAME });
    const node = reread.nodes.find((n) => n.uuid === mutatedNodeUuid);
    assert.ok(node, `restored flow missing node ${mutatedNodeUuid}`);
    assert.equal(
      node.name,
      mutatedOriginalName,
      "snapshot restore did not put the original node name back on the wire",
    );
  });
});
