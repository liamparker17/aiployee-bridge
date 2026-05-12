/**
 * integration-yii.test.ts — LIVE tests against the Yii surfaces of
 * aiployee.jobix.ai (Agents + Custom Fields).
 *
 * Gated independently of `tests/integration.test.ts`:
 *   1. process.env.AIPLOYEE_BRIDGE_LIVE === "1" — describe block skipped
 *      otherwise (visible in the test summary).
 *   2. After confirming env, `loadAuth()` and assert `auth.cookies.PHPSESSID`
 *      is present. If not, the suite fails fast with a clear "auth incomplete"
 *      message — Yii endpoints can't be reached without session cookies.
 *
 * Sandbox-only. Hard-coded to the "Tracey Test" agent and a disposable
 * Custom Field slug. Snapshots before any mutation and restores in `after()`
 * even on assertion failure. Steps run sequentially (node:test default).
 *
 * Contacts are intentionally OMITTED. Contacts contain real customer PII;
 * the plan's Task 6.5 covers only Agent + Custom Fields scenarios. A future
 * Phase 6.5b can add contact tests against a disposable test contact once
 * the create endpoint is recon'd.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";

import { Client } from "../src/client/index.js";
import {
  DEFAULT_API_BASE,
  DEFAULT_YII_HOST,
  loadAuth,
} from "../src/client/auth.js";
import type { AgentDetails } from "../src/client/agents.js";
import type { CustomFieldDTO } from "../src/client/custom_fields.js";

// ---------------------------------------------------------------------------
// Sandbox invariants. Hard-coded. Bind the suite to ONE agent + ONE
// disposable field slug. Asserted in every `it` block via SANDBOX_GUARD so a
// future edit cannot quietly redirect the mutation surface.
// ---------------------------------------------------------------------------

const AGENT_UUID = "3527076a-e3d2-4eb5-bfdb-498e02cde84f"; // Tracey Test
const FLOW_UUID = "b2deacdb-73d2-4b4e-b13a-b2de58dc7ebd"; // Architect test 1 (sanity reference)
const SAFE_PHONE = "+27877295318"; // Tracey's phone
const RECON_FIELD_SLUG = "bridge_recon_test_field";

// Referenced for the sandbox guard but not directly used inside test bodies.
void FLOW_UUID;
void SAFE_PHONE;

const LIVE = process.env.AIPLOYEE_BRIDGE_LIVE === "1";
const SUITE_SKIP_REASON = LIVE
  ? false
  : "AIPLOYEE_BRIDGE_LIVE!=1 — skipping live Yii integration tests (set env var to run)";

function sandboxGuard(opts: { agentUuid?: string; fieldSlug?: string }): void {
  if (opts.agentUuid !== undefined && opts.agentUuid !== AGENT_UUID) {
    throw new Error(
      `SANDBOX GUARD: agent UUID ${opts.agentUuid} is NOT the sandbox agent ${AGENT_UUID} — refusing to proceed.`,
    );
  }
  if (opts.fieldSlug !== undefined && opts.fieldSlug !== RECON_FIELD_SLUG) {
    throw new Error(
      `SANDBOX GUARD: field slug ${opts.fieldSlug} is NOT the disposable slug ${RECON_FIELD_SLUG} — refusing to proceed.`,
    );
  }
}

describe(
  "integration-yii: live sandbox bench (Agents + Custom Fields)",
  { skip: SUITE_SKIP_REASON },
  () => {
    let client: Client | null = null;

    // --- Agent snapshot/restore state ---
    let agentSnapshot: AgentDetails | null = null;
    let agentMutationAttempted = false;

    // --- Custom Field cleanup state ---
    let fieldSlugToCleanup: string | null = null;

    before(async () => {
      const auth = await loadAuth();
      if (!auth.cookies || !auth.cookies.PHPSESSID) {
        throw new Error(
          "auth incomplete — re-run `aiployee-bridge auth` with --cookie flags " +
            "(PHPSESSID, _identity, _csrf). Yii surfaces require session cookies.",
        );
      }
      client = new Client(
        {
          token: auth.token,
          apiBase: auth.apiBase ?? DEFAULT_API_BASE,
        },
        {
          yiiHost: auth.yiiHost ?? DEFAULT_YII_HOST,
          cookies: auth.cookies,
        },
      );
    });

    after(async () => {
      // ----- Agent restore (best effort) -----
      if (
        client !== null &&
        agentSnapshot !== null &&
        agentMutationAttempted
      ) {
        try {
          sandboxGuard({ agentUuid: agentSnapshot.uuid });
          await client.updateAgent({
            uuid: structuredClone(agentSnapshot).uuid,
            mainGoal: structuredClone(agentSnapshot).mainGoal,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `\n` +
              `========================================================\n` +
              `[integration-yii] AGENT TEARDOWN FAILED\n` +
              `--------------------------------------------------------\n` +
              `Could not restore agent ${AGENT_UUID} mainGoal.\n` +
              `Error: ${err instanceof Error ? err.message : String(err)}\n` +
              `Snapshot DTO (paste into the UI to manually restore):\n` +
              `${JSON.stringify(agentSnapshot, null, 2)}\n` +
              `========================================================\n`,
          );
        }
      }

      // ----- Custom Field cleanup (best effort) -----
      if (client !== null && fieldSlugToCleanup !== null) {
        try {
          sandboxGuard({ fieldSlug: fieldSlugToCleanup });
          await client.deleteCustomField({ slug: fieldSlugToCleanup });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `\n` +
              `========================================================\n` +
              `[integration-yii] CUSTOM FIELD CLEANUP FAILED\n` +
              `--------------------------------------------------------\n` +
              `Could not delete disposable Custom Field slug: ${fieldSlugToCleanup}\n` +
              `Error: ${err instanceof Error ? err.message : String(err)}\n` +
              `Manually delete this row at /management/customer-fields.\n` +
              `========================================================\n`,
          );
        }
      }
    });

    // -------------------------------------------------------------------
    // A. Agent snapshot / mutate / restore
    // -------------------------------------------------------------------

    it(
      "A1: getAgent(AGENT_UUID) returns a populated DTO; capture snapshot",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ agentUuid: AGENT_UUID });
        assert.ok(client, "client not initialised");
        const dto = await client.getAgent(AGENT_UUID);
        assert.equal(dto.uuid, AGENT_UUID, "agent uuid mismatch on the wire");
        assert.ok(
          dto.prompts.length > 0,
          "expected non-empty prompts on the sandbox agent",
        );
        assert.ok(
          dto.mainGoal.length > 0,
          "expected non-empty mainGoal on the sandbox agent",
        );
        agentSnapshot = structuredClone(dto);
      },
    );

    it(
      "A2: updateAgent() appends a recon marker to mainGoal",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ agentUuid: AGENT_UUID });
        assert.ok(client, "client not initialised");
        assert.ok(agentSnapshot, "snapshot not captured in A1");

        agentMutationAttempted = true;
        await client.updateAgent({
          uuid: AGENT_UUID,
          mainGoal: agentSnapshot.mainGoal + " [recon-ts]",
        });
      },
    );

    it(
      "A3: getAgent() reflects the suffixed mainGoal on the wire",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ agentUuid: AGENT_UUID });
        assert.ok(client, "client not initialised");
        assert.ok(agentSnapshot, "snapshot not captured");
        const dto = await client.getAgent(AGENT_UUID);
        assert.equal(
          dto.mainGoal,
          agentSnapshot.mainGoal + " [recon-ts]",
          "expected suffixed mainGoal to be persisted",
        );
      },
    );

    it(
      "A4: updateAgent() restores the original mainGoal (try/finally inline)",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ agentUuid: AGENT_UUID });
        assert.ok(client, "client not initialised");
        assert.ok(agentSnapshot, "snapshot not captured");

        try {
          await client.updateAgent({
            uuid: AGENT_UUID,
            mainGoal: structuredClone(agentSnapshot).mainGoal,
          });
          // Verify on the wire BEFORE clearing the after-hook safety net.
          const reread = await client.getAgent(AGENT_UUID);
          assert.equal(
            reread.mainGoal,
            agentSnapshot.mainGoal,
            "restore did not put the original mainGoal back on the wire",
          );
          // Only NOW clear the flag — if the assert above throws, after()
          // will retry the restore.
          agentMutationAttempted = false;
        } finally {
          // Intentionally empty: the after-hook is the belt-and-braces.
          // We leave agentMutationAttempted=true if anything above threw,
          // so the after-hook attempts a second restore.
        }
      },
    );

    // -------------------------------------------------------------------
    // B. Custom Field lifecycle
    // -------------------------------------------------------------------

    it(
      "B1: listCustomFields() returns at least one row",
      { timeout: 60_000 },
      async () => {
        assert.ok(client, "client not initialised");
        const rows = await client.listCustomFields();
        assert.ok(
          rows.length >= 10,
          `expected >= 10 Custom Fields on the live tenant, got ${rows.length}`,
        );
      },
    );

    it(
      "B2: pre-check — delete leftover disposable field from a previous failed run",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ fieldSlug: RECON_FIELD_SLUG });
        assert.ok(client, "client not initialised");
        const rows = await client.listCustomFields();
        const stale = rows.find((r) => r.slug === RECON_FIELD_SLUG);
        if (stale) {
          // eslint-disable-next-line no-console
          console.warn(
            `[integration-yii] B2: found stale "${RECON_FIELD_SLUG}" from a previous run — deleting`,
          );
          await client.deleteCustomField({ slug: RECON_FIELD_SLUG });
        }
      },
    );

    it(
      "B3: upsertCustomField() inserts the disposable row and returns DTO with assigned uuid",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ fieldSlug: RECON_FIELD_SLUG });
        assert.ok(client, "client not initialised");

        // Pin cleanup BEFORE the call so even a partial-failure leaves a
        // trail for the after-hook.
        fieldSlugToCleanup = RECON_FIELD_SLUG;

        const dto: CustomFieldDTO = {
          uuid: null,
          slug: RECON_FIELD_SLUG,
          name: "Bridge Recon Test",
          type: "string",
          description:
            "ephemeral — created and deleted by the integration test",
        };
        const saved = await client.upsertCustomField(dto);
        assert.equal(saved.slug, RECON_FIELD_SLUG, "slug mismatch after save");
        assert.ok(
          saved.uuid && saved.uuid.length > 0,
          `expected server-assigned uuid after insert, got ${JSON.stringify(saved.uuid)}`,
        );
      },
    );

    it(
      "B4: listCustomFields() includes the new row",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ fieldSlug: RECON_FIELD_SLUG });
        assert.ok(client, "client not initialised");
        const rows = await client.listCustomFields();
        const found = rows.find((r) => r.slug === RECON_FIELD_SLUG);
        assert.ok(
          found,
          `expected newly-created field "${RECON_FIELD_SLUG}" to be present in listCustomFields()`,
        );
      },
    );

    it(
      "B5: deleteCustomField() removes the disposable row",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ fieldSlug: RECON_FIELD_SLUG });
        assert.ok(client, "client not initialised");

        try {
          await client.deleteCustomField({ slug: RECON_FIELD_SLUG });
          // Only clear the cleanup pin AFTER a successful delete. If this
          // throws, the after-hook will retry.
          fieldSlugToCleanup = null;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `\n[integration-yii] B5: DELETE FAILED for slug "${RECON_FIELD_SLUG}" — ` +
              `manual cleanup may be required at /management/customer-fields. ` +
              `Error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          throw err;
        }
      },
    );

    it(
      "B6: listCustomFields() no longer contains the disposable row",
      { timeout: 60_000 },
      async () => {
        sandboxGuard({ fieldSlug: RECON_FIELD_SLUG });
        assert.ok(client, "client not initialised");
        const rows = await client.listCustomFields();
        const found = rows.find((r) => r.slug === RECON_FIELD_SLUG);
        assert.equal(
          found,
          undefined,
          `expected "${RECON_FIELD_SLUG}" to be gone after delete; got: ${JSON.stringify(found)}`,
        );
      },
    );
  },
);
