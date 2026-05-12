// READ-ONLY probe: scrape the /flows listing page to find the
// delete-action URL and form for one existing flow. Does NOT submit.
import { loadAuth } from "../dist/client/auth.js";

const auth = await loadAuth();
const cookieHeader = Object.entries(auth.cookies || {})
  .map(([k, v]) => `${k}=${v}`)
  .join("; ");

const res = await fetch("https://aiployee.jobix.ai/flows", {
  headers: { Cookie: cookieHeader, Accept: "text/html" },
});
const html = await res.text();

// Find every form action AND every data-method="post" link with a delete-ish URL.
const formActions = [...html.matchAll(/<form[^>]+action="([^"]+)"[^>]*>/gi)]
  .map((m) => m[1])
  .filter((u) => /delete|destroy|remove/i.test(u));
console.log("forms with delete-ish action:");
formActions.slice(0, 10).forEach((a) => console.log("  " + a));

const deleteLinks = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*data-method="post"[^>]*>/gi)]
  .map((m) => m[1])
  .filter((u) => /delete|destroy|remove/i.test(u));
console.log("\nanchor links with data-method=post and delete-ish href:");
deleteLinks.slice(0, 10).forEach((a) => console.log("  " + a));

// Generic: every URL containing /flows/<uuid>/<verb>
const flowOps = [...html.matchAll(/\/flows\/[0-9a-fA-F-]{36}\/[a-z-]+/gi)]
  .map((m) => m[0]);
const uniq = [...new Set(flowOps)].slice(0, 15);
console.log("\nflow-scoped URLs seen (sample):");
uniq.forEach((u) => console.log("  " + u));
