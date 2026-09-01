// UI acceptance test. All model, storage and auth calls are mocked; no credits used.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const port = 3022;
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
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
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/studio`)).ok) break;
    } catch {}
    if (i === 99) throw new Error(`Server did not start: ${logs}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  let state = {
    revision: 0,
    document: { version: 1, avatars: [], projects: [] },
  };
  let uploads = 0;
  let jobs = [];
  let generated = [];
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7V8AAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("**/generated/**", (r) =>
    r.fulfill({ contentType: "image/png", body: png }),
  );
  await page.route("**/api/studio", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      assert.equal(body.revision, state.revision);
      state = { ...body, revision: state.revision + 1 };
    }
    await route.fulfill({ json: state });
  });
  await page.route("**/api/upload-asset", (r) =>
    r.fulfill({ json: { cdnUrl: `/generated/test-${++uploads}.png` } }),
  );
  await page.route("**/api/studio/jobs**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      generated.push(body);
      const p = state.document.projects.find((p) => p.id === body.projectId);
      const scene = p.scenes.find((s) => s.id === body.sceneId);
      const take = {
        id: body.requestId,
        projectId: p.id,
        sceneId: scene.id,
        kind: "video",
        state: "submitted",
        status: "done",
        taskId: "fake-task",
        createdAt: new Date().toISOString(),
        videoUrl: "/generated/clip.mp4",
        snapshot: { prompt: scene.dialogue, startFrameUrl: p.firstFrameUrl },
      };
      jobs.push(take);
      return route.fulfill({ json: { take } });
    }
    return route.fulfill({ json: { takes: jobs } });
  });
  await page.route("**/api/download?**", (r) =>
    r.fulfill({ contentType: "video/mp4", body: Buffer.from("mock-mp4") }),
  );
  page.on("dialog", (d) => d.accept());
  await page.goto(`http://127.0.0.1:${port}/studio`);
  await page
    .getByRole("button", { name: "Add your first avatar", exact: true })
    .click();
  await page.getByLabel("Avatar name", { exact: true }).fill("Test persona");
  await page
    .getByLabel("Day 1 image", { exact: true })
    .setInputFiles({ name: "day1.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: /^Saved$/ }).waitFor();
  await page.getByRole("button", { name: /^Projects/ }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByText("Already have an approved first frame?").click();
  await page
    .getByLabel("Upload finished first frame", { exact: true })
    .setInputFiles({
      name: "approved.png",
      mimeType: "image/png",
      buffer: png,
    });
  await page.getByRole("button", { name: /^Saved$/ }).waitFor();
  await page.getByRole("button", { name: "Add scene manually" }).click();
  await page
    .getByLabel("Exact spoken dialogue", { exact: true })
    .fill("Here is the first line.");
  await page.getByLabel("Script & motion approved").check();
  await page.getByRole("button", { name: "Generate unstarted scenes" }).click();
  await page
    .getByRole("button", { name: "Approve this take", exact: true })
    .click();
  await page.getByRole("button", { name: /^Saved$/ }).waitFor();
  assert.equal(generated.length, 1);
  assert.equal(
    jobs[0].snapshot.startFrameUrl,
    state.document.projects[0].firstFrameUrl,
  );
  assert.notEqual(
    jobs[0].snapshot.startFrameUrl,
    state.document.avatars[0].imageUrl,
  );
  const completed = page.waitForEvent("download");
  await page.getByRole("button", { name: "Approved clips ZIP" }).click();
  assert.match((await completed).suggestedFilename(), /approved\.zip$/);
  await page.reload();
  await page.getByLabel("Exact spoken dialogue", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByLabel("Exact spoken dialogue", { exact: true })
      .inputValue(),
    "Here is the first line.",
  );
  await page
    .getByLabel("Exact spoken dialogue", { exact: true })
    .fill("A changed line.");
  assert.equal(
    await page.getByLabel("Script & motion approved").isChecked(),
    false,
  );
  mkdirSync("/tmp/helios-studio-qa", { recursive: true });
  await page.screenshot({
    path: "/tmp/helios-studio-qa/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "/tmp/helios-studio-qa/mobile.png",
    fullPage: true,
  });
  console.log(
    "PASS: avatar upload, first-frame approval, scene editing, batch submission, take approval, ZIP export, reload, approval invalidation, mobile overflow.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
