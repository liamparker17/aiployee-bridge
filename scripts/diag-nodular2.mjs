const r = await fetch("https://aiployee.jobix.ai/general/js/nodular.js?v=81");
const js = await r.text();

// Look for endpoint definitions: usually obj literals or string vars
const blocks = [
  ...js.matchAll(/(API_HOST|endpoint\s*[:=]|\/v1\/[a-z/]+|`\/[a-z/]+|'\/[a-z/]+'|"\/[a-z/]+")/g),
].map((m) => m[0]).slice(0, 60);
console.log("endpoint-ish tokens (sample):");
[...new Set(blocks)].forEach((b) => console.log("  " + b));

// Show context around getNodes/saveNodes/createNode patterns
console.log("\ncontexts around save/node terms (each 200-char window):");
const re = /(?:save|create|update|delete|fetch|get|put|patch|post)[a-zA-Z]*[Nn]ode|nodes?\/[a-zA-Z]+/g;
const seen = new Set();
for (const m of js.matchAll(re)) {
  const ctx = js.slice(Math.max(0, m.index - 80), m.index + 160).replace(/\s+/g, " ");
  if (seen.has(ctx)) continue;
  seen.add(ctx);
  console.log("\n  " + ctx);
  if (seen.size >= 18) break;
}
