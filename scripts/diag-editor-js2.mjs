import { loadAuth } from "../dist/client/auth.js";

const auth = await loadAuth();
const cookieHeader = Object.entries(auth.cookies || {})
  .map(([k, v]) => `${k}=${v}`)
  .join("; ");

const uuid = "231e444a-14bf-442b-82a8-9335133f2758";
const r = await fetch(`https://aiployee.jobix.ai/flows/${uuid}`, {
  headers: { Cookie: cookieHeader },
});
const html = await r.text();

// All script srcs
const allSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
console.log("all script srcs (count " + allSrcs.length + "):");
allSrcs.forEach((s) => console.log("  " + s));

// All API-ish strings in the page itself (including inline scripts)
const apiRefs = [...html.matchAll(/['"`](\/(?:flows|nodes|v1|api|node)\/[^'"`\s?]+)['"`]/gi)]
  .map((m) => m[1]);
const uniq = [...new Set(apiRefs)];
console.log("\nAPI-ish URLs in full HTML:");
uniq.slice(0, 50).forEach((u) => console.log("  " + u));

// Search inline scripts for create/save/upsert keywords
const inlineScripts = [...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]);
console.log(`\ninline scripts: ${inlineScripts.length}, total chars: ${inlineScripts.reduce((a, b) => a + b.length, 0)}`);
for (let i = 0; i < inlineScripts.length; i++) {
  const s = inlineScripts[i];
  if (/save|create|upsert|persist|node/i.test(s)) {
    console.log(`\n  --- inline #${i} (${s.length} chars) — interesting ---`);
    console.log(s.slice(0, 600));
  }
}
