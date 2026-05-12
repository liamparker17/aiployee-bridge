const r = await fetch("https://aiployee.jobix.ai/general/js/nodular.js?v=81");
const js = await r.text();
console.log("nodular.js size:", js.length);

// Find every URL string in the bundle
const urls = [...js.matchAll(/['"`](\/(?:[a-z-]+\/)+[a-zA-Z0-9-_]+(?:\.[a-z]+)?)['"`]/g)].map((m) => m[1]);
const uniq = [...new Set(urls)];
console.log(`\nstring-literal paths in bundle (${uniq.length}):`);
uniq.slice(0, 80).forEach((u) => console.log("  " + u));

// Also look for axios/fetch/$.ajax calls
console.log("\nfetch/ajax/axios call sites (sample):");
const sites = [
  ...js.matchAll(/(?:fetch|\$\.ajax|axios\.[a-z]+|\.post|\.put|\.delete)\s*\([^)]{0,200}/g),
].map((m) => m[0]).slice(0, 15);
sites.forEach((s) => console.log("  " + s.replace(/\s+/g, " ").slice(0, 200)));
