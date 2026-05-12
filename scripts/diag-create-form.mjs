import { loadAuth } from "../dist/client/auth.js";
import { YiiTransport } from "../dist/client/yii.js";

const auth = await loadAuth();
const yt = new YiiTransport({
  yiiHost: auth.yiiHost || "https://aiployee.jobix.ai",
  cookies: auth.cookies,
});

const form = await yt.getForm("/flows/create", { formId: "save-flow-form" });
console.log("action:", form.action);
console.log("method:", form.method);
console.log("csrf:", form.csrf?.slice(0, 16) + "...");
console.log("fields:");
for (const [k, v] of Object.entries(form.fields)) {
  const display = typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v);
  console.log(`  ${k}: ${display}`);
}
