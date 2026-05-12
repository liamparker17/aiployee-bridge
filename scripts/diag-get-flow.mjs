// Diagnostic: call getFlowNodes against one active UUID and dump the
// raw HTTP response so we can see what the server actually returns.
import { loadAuth, DEFAULT_API_BASE, DEFAULT_YII_HOST } from "../dist/client/auth.js";

const uuid = process.argv[2] || "231e444a-14bf-442b-82a8-9335133f2758"; // Inbound Dealership

const auth = await loadAuth();
const apiBase = auth.apiBase || DEFAULT_API_BASE;
const yiiHost = auth.yiiHost || DEFAULT_YII_HOST;

console.log("--- auth ---");
console.log("apiBase:", apiBase);
console.log("yiiHost:", yiiHost);
console.log("token len:", auth.token?.length);
console.log("cookie keys:", Object.keys(auth.cookies || {}));

const url = `${apiBase}/flows/${encodeURIComponent(uuid)}/nodes`;
console.log("\n--- REST call ---");
console.log("GET", url);
const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
  },
});
console.log("status:", res.status);
console.log("content-type:", res.headers.get("content-type"));
const body = await res.text();
console.log("body (first 1200 chars):");
console.log(body.slice(0, 1200));

console.log("\n--- Yii call (same path via aiployee.jobix.ai) ---");
const cookieHeader = Object.entries(auth.cookies || {})
  .map(([k, v]) => `${k}=${v}`)
  .join("; ");
const yiiUrl = `${yiiHost.replace(/\/$/, "")}/flows/${encodeURIComponent(uuid)}/nodes`;
console.log("GET", yiiUrl);
const yiiRes = await fetch(yiiUrl, {
  headers: { Cookie: cookieHeader, Accept: "application/json" },
});
console.log("status:", yiiRes.status);
console.log("content-type:", yiiRes.headers.get("content-type"));
const yiiBody = await yiiRes.text();
console.log("body (first 1200 chars):");
console.log(yiiBody.slice(0, 1200));
