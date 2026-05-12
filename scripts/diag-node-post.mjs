const r = await fetch("https://aiployee.jobix.ai/general/js/nodular.js?v=81");
const js = await r.text();

// Find the POST /v1/nodes (without /save) call and show the surrounding 600 chars
const re = /makePostRequest\s*\(\s*['"`]\/v1\/nodes['"`]/g;
for (const m of js.matchAll(re)) {
  console.log("\n=== POST /v1/nodes context (~600 chars) ===");
  console.log(js.slice(Math.max(0, m.index - 200), m.index + 600));
}

console.log("\n\n=== PUT /v1/nodes/<uuid> context ===");
const re2 = /makePutRequest\s*\(\s*[`'"]\/v1\/nodes\/\$\{[^}]+\}[`'"]/g;
for (const m of js.matchAll(re2)) {
  console.log(js.slice(Math.max(0, m.index - 200), m.index + 600));
  break;
}
