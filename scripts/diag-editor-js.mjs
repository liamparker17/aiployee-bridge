// Pull editor JS bundles and grep for the node-save endpoint.
import { loadAuth } from "../dist/client/auth.js";

const auth = await loadAuth();
const cookieHeader = Object.entries(auth.cookies || {})
  .map(([k, v]) => `${k}=${v}`)
  .join("; ");

const uuid = "231e444a-14bf-442b-82a8-9335133f2758";
const editorRes = await fetch(`https://aiployee.jobix.ai/flows/${uuid}`, {
  headers: { Cookie: cookieHeader, Accept: "text/html" },
});
const html = await editorRes.text();

// Extract every <script src="..."> path
const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
const flowScripts = scriptSrcs.filter((s) => /flow|node|editor|graph/i.test(s));
console.log("flow-ish script bundles:");
flowScripts.forEach((s) => console.log("  " + s));

// Fetch each candidate and grep for endpoints
for (const src of flowScripts.slice(0, 5)) {
  const url = src.startsWith("http") ? src : `https://aiployee.jobix.ai${src}`;
  try {
    const r = await fetch(url, { headers: { Cookie: cookieHeader } });
    const body = await r.text();
    console.log(`\n=== ${url} (${body.length} bytes) ===`);
    const apiCalls = [...body.matchAll(/['"`](\/(?:flows|nodes|v1|api)\/[^'"`\s?]+)['"`]/gi)]
      .map((m) => m[1]);
    const uniq = [...new Set(apiCalls)];
    console.log("endpoints referenced:");
    uniq.slice(0, 25).forEach((u) => console.log("  " + u));

    // Look for fetch/$.ajax/axios usage near node/save keywords
    const lines = body.split(/\n/);
    const interesting = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /node.*save|save.*node|create.*node|node.*create|nodes\//i.test(l))
      .slice(0, 8);
    if (interesting.length > 0) {
      console.log("\nlines mentioning node save/create:");
      interesting.forEach(({ l, i }) =>
        console.log(`  L${i}: ${l.trim().slice(0, 180)}`),
      );
    }
  } catch (e) {
    console.log(`  FAIL fetching ${url}: ${e.message}`);
  }
}
