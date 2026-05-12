const r = await fetch("https://aiployee.jobix.ai/general/js/nodular.js?v=81");
const js = await r.text();

// Show all makePostRequest invocations with broader context
const calls = [...js.matchAll(/makePostRequest\s*\(\s*[`'"]([^`'"]+)[`'"]/g)];
console.log("makePostRequest endpoints:");
[...new Set(calls.map((c) => c[1]))].forEach((e) => console.log("  " + e));

// All POST/PATCH/PUT methods
const verbs = [...js.matchAll(/make(?:Get|Post|Put|Patch|Delete)Request\s*\(\s*[`'"]([^`'"]+)[`'"]/g)];
console.log("\nall requestMaker calls:");
[...new Set(verbs.map((c) => c[0]))].forEach((e) => console.log("  " + e));

// Search for createNode / addNode patterns
console.log("\ncontexts for createNode/addNode/newNode:");
const seen = new Set();
for (const m of js.matchAll(/(?:create|add|new|insert)[A-Z][a-zA-Z]*[Nn]ode/g)) {
  const ctx = js.slice(Math.max(0, m.index - 60), m.index + 200).replace(/\s+/g, " ");
  if (seen.has(ctx)) continue;
  seen.add(ctx);
  console.log("\n  " + ctx);
  if (seen.size >= 15) break;
}

// Also look at the addEventListener / event triggers around node creation
console.log("\nevent listeners or handlers mentioning 'add' or 'node-add':");
for (const m of js.matchAll(/(?:on|addEventListener|addNode|node-add|node-create)[^,;{]{0,200}/g)) {
  const s = m[0].replace(/\s+/g, " ");
  if (s.length < 30) continue;
  if (/node|drag/i.test(s)) {
    console.log("  " + s.slice(0, 200));
  }
}
