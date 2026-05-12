// Compare raw server response vs. what parseFlowNodesResult lets through.
import { loadAuth, DEFAULT_API_BASE } from "../dist/client/auth.js";
import { parseFlowNodesResult } from "../dist/schema/flow.js";

const uuid = process.argv[2] || "005f5116-be0b-4eb8-b8ad-b8acaf630e60"; // EZauto flow

const auth = await loadAuth();
const apiBase = auth.apiBase || DEFAULT_API_BASE;
const res = await fetch(`${apiBase}/flows/${encodeURIComponent(uuid)}/nodes`, {
  headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" },
});
const env = await res.json();
const raw = env.result;

console.log(`server returned ${raw.length} nodes:`);
for (const n of raw) {
  console.log(`  ${n.uuid}  ${n.type.padEnd(22)} #${n.number}  "${n.name}"`);
}

console.log("\nparsing with parseFlowNodesResult...");
const parsed = parseFlowNodesResult(raw);
console.log(`parser kept ${parsed.length} of ${raw.length}`);

const keptUuids = new Set(parsed.map((n) => n.uuid));
const dropped = raw.filter((n) => !keptUuids.has(n.uuid));
if (dropped.length) {
  console.log("\nDROPPED nodes (silently invisible to the LLM):");
  for (const n of dropped) {
    console.log(`  ${n.uuid}  ${n.type}  "${n.name}"`);
  }
}
