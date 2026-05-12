import { Client } from "../dist/client/index.js";

const c = await Client.fromAuthFile();
const rows = await c.listCustomFields();
console.log(`listed ${rows.length} custom fields`);
const bad = rows.filter((r) => r.parseWarning);
console.log(`unknown-type rows: ${bad.length}`);
for (const r of bad) {
  console.log(`  slug=${r.slug} name=${r.name}  warning=${r.parseWarning}`);
}
