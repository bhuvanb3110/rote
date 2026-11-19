// Smoke test of the BUILT bank (dist/mock-app/index.js, what the image runs): a malformed login form with a fake
// credential, NODE_ENV=production as in the image. Prints the status, the response's first line and the bank's
// stderr summary, and whether the credential appears anywhere.
import { spawn } from "node:child_process";

const CRED = "fake-cred-smoke";
const PORT = 4171;
const child = spawn(process.execPath, ["dist/mock-app/index.js"], {
  env: { ...process.env, NODE_ENV: "production", MOCK_APP_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("bank did not start")), 15000);
  child.stdout.on("data", () => out.includes("listening") && (clearTimeout(t), resolve()));
});
const body = `a${"[b]".repeat(40)}=1&password=${CRED}`;
const res = await fetch(`http://127.0.0.1:${PORT}/login`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${CRED}` },
  body,
});
const text = await res.text();
await new Promise((r) => setTimeout(r, 300));
child.kill();
console.log(`status ${res.status}; x-request-id ${res.headers.get("x-request-id")}`);
console.log(`response: ${text.split("\n").find((l) => l.includes("<h1>"))}`);
console.log(`bank stderr: ${err.trim()}`);
console.log(`credential in response: ${text.includes(CRED)}; in bank stdout/stderr: ${(out + err).includes(CRED)}`);
