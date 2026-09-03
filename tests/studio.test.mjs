import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
function load(path, mocks = {}, cwd = process.cwd()) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    URL,
    crypto: webcrypto,
    process: { cwd: () => cwd, pid: process.pid },
    require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : require(id)),
  });
  return module.exports;
}
const studio = load("../lib/studio.ts");
function fixture() {
  return {
    version: 1,
    avatars: [
      {
        id: "avatar",
        name: "Niki",
        imageUrl: "https://assets.example/day1.png",
        direction: "Locked camera.",
      },
    ],
    projects: [
      {
        id: "project",
        name: "Day 2",
        avatarId: "avatar",
        outfitUrl: "https://assets.example/outfit.png",
        lookPrompt: "Use the outfit from image 2.",
        imageModel: "gpt-image-2",
        firstFrameUrl: "https://assets.example/approved.png",
        source: "Reference breakdown",
        scenes: [
          {
            id: "scene",
            title: "Hook",
            dialogue: "Here is the first line.",
            motion: "A small hand gesture.",
            notes: "Add screen recording later.",
            duration: 7,
            approved: true,
            selectedTakeId: "",
          },
        ],
      },
    ],
  };
}
test("all scene jobs use the approved first frame, not the Day 1 image or prior output", () => {
  const doc = fixture();
  const { payload } = studio.prepareStudioJob(doc, "project", "scene");
  assert.equal(payload.startFrameUrl, doc.projects[0].firstFrameUrl);
  assert.equal(payload.sound, true);
  assert.equal(payload.videoModel, "kling-3.0");
  assert.ok(!payload.prompt.includes("Add screen recording"));
  doc.projects[0].firstFrameUrl = "https://assets.example/new.png";
  assert.equal(
    payload.startFrameUrl,
    "https://assets.example/approved.png",
    "old snapshot remains immutable",
  );
});
test("unapproved scenes, missing frames and rushed lines cannot be submitted", () => {
  const d = fixture();
  const s = d.projects[0].scenes[0];
  s.approved = false;
  assert.throws(
    () => studio.prepareStudioJob(d, "project", "scene"),
    /Approve/,
  );
  s.approved = true;
  d.projects[0].firstFrameUrl = "";
  assert.throws(
    () => studio.prepareStudioJob(d, "project", "scene"),
    /Approve/,
  );
  d.projects[0].firstFrameUrl = "https://a.example/image.png";
  s.dialogue = "word ".repeat(30);
  assert.throws(() => studio.prepareStudioJob(d, "project", "scene"), /rushed/);
});
test("image jobs preserve ordered reference roles and switch models", () => {
  const d = fixture();
  d.projects[0].imageModel = "seedream-5-pro";
  const job = studio.prepareStudioJob(d, "project");
  assert.equal(job.kind, "image");
  assert.equal(job.payload.model, "seedream-5-pro");
  assert.equal(job.payload.imageUrls[0], d.avatars[0].imageUrl);
  assert.equal(job.payload.imageUrls[1], d.projects[0].outfitUrl);
});
test("document validation rejects scripts, bad durations, foreign avatars and duplicate IDs", () => {
  const d = fixture();
  assert.equal(studio.parseStudioDocument(d).projects.length, 1);
  d.avatars[0].imageUrl = "javascript:alert(1)";
  assert.throws(() => studio.parseStudioDocument(d), /HTTPS/);
  d.avatars[0].imageUrl = "https://a.example/ok.png";
  d.projects[0].scenes[0].duration = 99;
  assert.throws(() => studio.parseStudioDocument(d), /duration/);
  d.projects[0].scenes[0].duration = 7;
  d.projects[0].avatarId = "missing";
  assert.throws(() => studio.parseStudioDocument(d), /missing avatar/);
  d.projects[0].avatarId = "avatar";
  d.avatars.push(d.avatars[0]);
  assert.throws(() => studio.parseStudioDocument(d), /Duplicate/);
});
test("director output is always unapproved and invalid output fails closed", () => {
  const text =
    '```json\n[{"title":"Hook","dialogue":"Hello there.","motion":"Wave.","duration":5}]\n```';
  const scenes = studio.parseDirectorScenes(text);
  assert.equal(scenes[0].approved, false);
  assert.equal(scenes[0].selectedTakeId, "");
  assert.throws(() => studio.parseDirectorScenes("not JSON"));
  assert.throws(
    () => studio.parseDirectorScenes('[{"duration":55}]'),
    /duration/,
  );
});
test("guest persistence survives reload, detects stale saves and reserves a request once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helios-studio-test-"));
  const mocks = {
    "server-only": {},
    "./guestMode": { GUEST_MODE: true },
    "./supabase/admin": {},
    "./studio": studio,
  };
  try {
    const storage = load("../lib/studioStorage.ts", mocks, dir);
    const first = await storage.saveStudio("guest", 0, fixture());
    assert.equal(first.revision, 1);
    await assert.rejects(
      storage.saveStudio("guest", 0, fixture()),
      /another tab/,
    );
    const reloaded = load("../lib/studioStorage.ts", mocks, dir);
    assert.equal(
      (await reloaded.readStudio("guest")).document.projects[0].name,
      "Day 2",
    );
    const take = {
      id: "request1",
      projectId: "project",
      sceneId: "scene",
      kind: "video",
      state: "submitting",
      snapshot: {},
      createdAt: new Date().toISOString(),
    };
    assert.equal(await storage.reserveTake("guest", take), true);
    assert.equal(await storage.reserveTake("guest", take), false);
    await storage.updateTake("guest", {
      ...take,
      taskId: "task1",
      state: "submitted",
    });
    assert.equal((await reloaded.getTakes("guest"))[0].taskId, "task1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function routes(user = "user-a", fail = false) {
  const records = [];
  let calls = 0;
  const adapter = async () => {
    calls++;
    if (fail) throw new Error("Network lost after submit");
    return Response.json({ taskId: "paid-task" });
  };
  const mocks = {
    "@/lib/guestMode": { GUEST_MODE: false, resolveUserId: async () => user },
    "@/lib/storageConfig": {
      isStoredAssetUrl: (url) => url.startsWith("https://assets.example/"),
    },
    "@/lib/studio": studio,
    "@/lib/studioStorage": {
      getTakes: async (uid) => {
        assert.equal(uid, user);
        return records;
      },
      readStudio: async (uid) => {
        assert.equal(uid, user);
        return { revision: 3, document: fixture() };
      },
      reserveTake: async (uid, t) => {
        assert.equal(uid, user);
        if (records.some((r) => r.id === t.id)) return false;
        records.push(t);
        return true;
      },
      updateTake: async (uid, t) => {
        assert.equal(uid, user);
        records[records.findIndex((r) => r.id === t.id)] = t;
      },
    },
    "@/app/api/generate/route": { POST: adapter },
    "@/app/api/generate-video/route": { POST: adapter },
    "@/app/api/job-status/route": {
      GET: async () => Response.json({ status: "pending" }),
    },
  };
  const route = load("../app/api/studio/jobs/route.ts", mocks);
  const { NextRequest } = require("next/server");
  const request = (body = {}) =>
    new NextRequest("https://app.example/api/studio/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project",
        sceneId: "scene",
        revision: 3,
        requestId: "request1",
        ...body,
      }),
    });
  return { route, request, records, calls: () => calls };
}
test("unauthenticated submissions cannot reach the paid adapter", async () => {
  const t = routes(null);
  assert.equal((await t.route.POST(t.request())).status, 401);
  assert.equal(t.calls(), 0);
});
test("replayed request ID returns the original take without another paid call", async () => {
  const t = routes();
  assert.equal((await t.route.POST(t.request())).status, 200);
  assert.equal((await t.route.POST(t.request())).status, 200);
  assert.equal(t.calls(), 1);
  assert.equal(t.records.length, 1);
  assert.equal(t.records[0].taskId, "paid-task");
});
test("stale workspace revision is rejected before reserving or generating", async () => {
  const t = routes();
  assert.equal((await t.route.POST(t.request({ revision: 2 }))).status, 409);
  assert.equal(t.calls(), 0);
  assert.equal(t.records.length, 0);
});
test("uncertain submissions remain reserved and are never automatically retried", async () => {
  const t = routes("user-a", true);
  await t.route.POST(t.request());
  await t.route.POST(t.request());
  assert.equal(t.records[0].state, "unknown");
  assert.equal(t.calls(), 1);
});

// Exercise the real cloud storage functions against a small PostgREST test double.
// This checks application query scoping; it does not replace live RLS verification.
function cloudStorage() {
  const tables = { studio_workspaces: [], studio_takes: [] };
  const client = {
    from(name) {
      let action = "select", value, single = false;
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, expected) { filters.push([key, expected]); return query; },
        order() { return query; },
        limit() { return query; },
        maybeSingle() { single = true; return query; },
        insert(row) { action = "insert"; value = structuredClone(row); return query; },
        update(row) { action = "update"; value = structuredClone(row); return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            const rows = tables[name];
            if (action === "insert") {
              const duplicate = rows.some(r => r.user_id === value.user_id &&
                (name === "studio_workspaces" || r.id === value.id));
              if (duplicate) return { data: null, error: { code: "23505", message: "duplicate" } };
              rows.push(value);
              return { data: null, error: null };
            }
            const matched = rows.filter(r => filters.every(([k, v]) => r[k] === v));
            if (action === "update") matched.forEach(r => Object.assign(r, value));
            return { data: structuredClone(single ? matched[0] ?? null : matched), error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return load("../lib/studioStorage.ts", {
    "server-only": {},
    "./guestMode": { GUEST_MODE: false },
    "./supabase/admin": { supabaseAdmin: client },
    "./studio": studio,
  });
}

test("cloud workspaces isolate users and reject stale revisions without overwriting", async () => {
  const storage = cloudStorage();
  const a = fixture(), b = fixture();
  a.projects[0].name = "Alice private project";
  b.projects[0].name = "Bob private project";
  await storage.saveStudio("alice", 0, a);
  await storage.saveStudio("bob", 0, b);
  a.projects[0].name = "Alice updated";
  await storage.saveStudio("alice", 1, a);
  await assert.rejects(storage.saveStudio("alice", 1, b), /another tab/);
  await assert.rejects(storage.saveStudio("alice", 0, b), /another tab/);
  assert.equal((await storage.readStudio("alice")).document.projects[0].name, "Alice updated");
  assert.equal((await storage.readStudio("bob")).document.projects[0].name, "Bob private project");
  assert.equal((await storage.readStudio("stranger")).document.projects.length, 0);
});

test("cloud takes scope matching request IDs and updates to their owner", async () => {
  const storage = cloudStorage();
  const take = { id: "same-request", projectId: "project", kind: "video",
    state: "submitting", snapshot: {}, createdAt: new Date().toISOString() };
  assert.equal(await storage.reserveTake("alice", take), true);
  assert.equal(await storage.reserveTake("bob", take), true);
  assert.equal(await storage.reserveTake("alice", take), false);
  await storage.updateTake("alice", { ...take, state: "submitted", taskId: "alice-task" });
  await storage.updateTake("stranger", { ...take, taskId: "foreign-task" });
  assert.equal((await storage.getTakes("alice"))[0].taskId, "alice-task");
  assert.equal((await storage.getTakes("bob"))[0].state, "submitting");
  assert.equal((await storage.getTakes("stranger")).length, 0);
});

test("workspace endpoints reject unauthenticated reads and writes before accessing storage", async () => {
  let accessed = false;
  const route = load("../app/api/studio/route.ts", {
    "@/lib/guestMode": { resolveUserId: async () => null },
    "@/lib/studio": studio,
    "@/lib/studioStorage": {
      readStudio: async () => { accessed = true; },
      saveStudio: async () => { accessed = true; },
      StudioConflict: class extends Error {},
    },
  });
  const { NextRequest } = require("next/server");
  assert.equal((await route.GET(new NextRequest("https://app.example/api/studio"))).status, 401);
  assert.equal((await route.PUT(new NextRequest("https://app.example/api/studio", {
    method: "PUT", body: JSON.stringify({ revision: 0, document: fixture() }),
  }))).status, 401);
  assert.equal(accessed, false);
});
