import { loadAuth } from "../dist/client/auth.js";
import { YiiTransport } from "../dist/client/yii.js";

const auth = await loadAuth();
const yt = new YiiTransport({
  yiiHost: auth.yiiHost || "https://aiployee.jobix.ai",
  cookies: auth.cookies,
});

const uuid = process.argv[2] || "231e444a-14bf-442b-82a8-9335133f2758";

const form = await yt.getForm(`/flows/${uuid}`, { formId: "save-flow-form" });
console.log("action:", form.action);
console.log("method:", form.method);
console.log("csrf:", form.csrfToken?.slice(0, 16) + "...");
console.log("submissionToken:", form.submissionToken?.slice(0, 16));
console.log("\nfields:");
for (const [k, v] of Object.entries(form.fields)) {
  const display = typeof v === "string"
    ? v.length > 120
      ? `${v.slice(0, 80)}... (${v.length} chars)`
      : v
    : JSON.stringify(v).slice(0, 120);
  console.log(`  ${k.padEnd(40)} = ${display}`);
}
