import { loadAuth } from "../dist/client/auth.js";
import { YiiTransport } from "../dist/client/yii.js";

const auth = await loadAuth();
const yt = new YiiTransport({
  yiiHost: auth.yiiHost || "https://aiployee.jobix.ai",
  cookies: auth.cookies,
});

const form = await yt.getForm("/flows/create", { formId: "save-flow-form" });
const name = `bridge-create-test-${Date.now()}`;
console.log("creating:", name);

const res = await yt.submitForm(form, {
  "SaveFlowForm[name]": name,
  "SaveFlowForm[description]": "bridge create endpoint probe — safe to delete",
});

console.log("status:", res.status);
console.log("finalUrl:", res.finalUrl);
