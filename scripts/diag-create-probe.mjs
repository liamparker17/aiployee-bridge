// Probe likely "create flow" endpoints to figure out the shape.
import { loadAuth, DEFAULT_API_BASE } from "../dist/client/auth.js";

const auth = await loadAuth();
const apiBase = auth.apiBase || DEFAULT_API_BASE;
const cookieHeader = Object.entries(auth.cookies || {})
  .map(([k, v]) => `${k}=${v}`)
  .join("; ");

async function probe(label, url, init) {
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") || "";
  const body = (await res.text()).slice(0, 400);
  console.log(`\n[${label}] ${init.method || "GET"} ${url}`);
  console.log(`  ${res.status}  ${ct}`);
  console.log(`  ${body.replace(/\s+/g, " ")}`);
}

// 1) REST candidates against dashboard-api
const rest = {
  Authorization: `Bearer ${auth.token}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};
await probe("rest POST /flows", `${apiBase}/flows`, {
  method: "POST",
  headers: rest,
  body: JSON.stringify({ name: "bridge-create-probe-DELETE-ME" }),
});
await probe("rest POST /flows/create", `${apiBase}/flows/create`, {
  method: "POST",
  headers: rest,
  body: JSON.stringify({ name: "bridge-create-probe-DELETE-ME" }),
});

// 2) Yii UI candidates - GET the create page first to see the form action
await probe("yii GET /flows/create", "https://aiployee.jobix.ai/flows/create", {
  method: "GET",
  headers: { Cookie: cookieHeader, Accept: "text/html" },
});

// 3) Check if /flows page has a "create new" link to grok the URL
const listRes = await fetch("https://aiployee.jobix.ai/flows", {
  headers: { Cookie: cookieHeader, Accept: "text/html" },
});
const listHtml = await listRes.text();
const createLinks = listHtml.match(/href="[^"]*(?:create|new|add)[^"]*"/gi)?.slice(0, 6) ?? [];
console.log("\ncreate-ish links on /flows page:");
createLinks.forEach((l) => console.log(`  ${l}`));
const formActions = listHtml.match(/<form[^>]+action="[^"]+"[^>]*>/gi)?.slice(0, 5) ?? [];
console.log("\nforms on /flows page:");
formActions.forEach((l) => console.log(`  ${l}`));
