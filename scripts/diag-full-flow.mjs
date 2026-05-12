import { Client } from "../dist/client/index.js";
import { getFlow, listFlows } from "../dist/tools/flows.js";

const c = await Client.fromAuthFile();
const flows = await listFlows(c);
console.log(`listed ${flows.length} flows\n`);

const active = flows.filter((f) => f.status === "Active");
for (const f of active) {
  process.stdout.write(`\n=== ${f.name} (${f.uuid}) ===\n`);
  try {
    const dto = await getFlow(c, f.uuid, f);
    console.log(`nodes: ${dto.nodes.length}, connections: ${dto.connections.length}`);
    console.log("description:", dto.description.slice(0, 200));
    if (dto.nodes.length > 0) {
      const types = dto.nodes.map((n) => n.config.kind);
      console.log("node types:", types.join(", "));
    }
  } catch (err) {
    console.log("ERR:", err instanceof Error ? err.message : String(err));
  }
}
