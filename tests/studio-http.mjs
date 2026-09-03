// Run after a guest-mode build. No generation requests and no database writes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const port = 3032;
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    env: {
      ...process.env,
      GUEST_MODE: "true",
      NEXT_PUBLIC_GUEST_MODE: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-placeholder",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
try {
  let response;
  for (let i = 0; i < 80; i++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/studio`);
      if (response.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(response?.ok, logs);
  const envelope = await response.json();
  assert.equal(envelope.document.version, 1);
  const page = await fetch(`http://127.0.0.1:${port}/studio`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Persona Studio/);
  const jobs = await fetch(`http://127.0.0.1:${port}/api/studio/jobs`);
  assert.equal(jobs.status, 200);
  assert.ok(Array.isArray((await jobs.json()).takes));
  console.log(
    "PASS: production Studio page, workspace API and user-scoped jobs API respond successfully.",
  );
} finally {
  server.kill("SIGTERM");
}
