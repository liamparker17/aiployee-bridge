// Probe what the flow editor page uses to save nodes. Read-only.
import { loadAuth } from "../dist/client/auth.js";

const auth = await loadAuth();
const cookieHeader = Object.entries(auth.cookies || {})
  .map(([k, v]) => `${k}=${v}`)
  .join("; ");

const uuid = "231e444a-14bf-442b-82a8-9335133f2758"; // Inbound Dealership (has nodes)

const res = await fetch(`https://aiployee.jobix.ai/flows/${uuid}`, {
  headers: { Cookie: cookieHeader, Accept: "text/html" },
});
const html = await res.text();
console.log("status:", res.status, "len:", html.length);

// Forms
const forms = [...html.matchAll(/<form[^>]+>/gi)].map((m) => m[0]);
console.log("\nforms:");
forms.slice(0, 8).forEach((f) => console.log("  " + f));

// JS URLs - find any /flows/<uuid>/... or /v1/... or /nodes/... references
const apiRefs = [...html.matchAll(/["'`](\/(?:flows|nodes|v1|api)\/[^"'`\s?]+)["'`]/gi)]
  .map((m) => m[1]);
const uniq = [...new Set(apiRefs)].slice(0, 30);
console.log("\nbackend URLs referenced in editor HTML:");
uniq.forEach((u) => console.log("  " + u));

// CSRF
const csrf = /<meta\s+name="csrf-token"\s+content="([^"]+)"/i.exec(html)?.[1];
console.log("\ncsrf-token:", csrf?.slice(0, 16) + "...");

// Search for "save", "node", "create" keywords in script blobs
const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] || "");
const saveContexts = [];
for (const s of scriptMatches) {
  for (const m of s.matchAll(/['"`](\/[^'"`\s]+(?:save|node|create|persist)[^'"`\s]*)['"`]/gi)) {
    saveContexts.push(m[1]);
  }
}
console.log("\nsave/node/create-ish URL strings in scripts:");
[...new Set(saveContexts)].slice(0, 20).forEach((u) => console.log("  " + u));
