import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const defaults = {
  STORAGE_PROVIDER: "supabase",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  R2_PUBLIC_URL: "https://old.r2.dev",
  R2_BUCKET_NAME: "old-bucket",
};

function loadTs(path, env, mocks = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const loadedModule = { exports: {} };
  const context = { module: loadedModule, exports: loadedModule.exports, process: { env }, Buffer, URL, console, __dirname: process.cwd(),
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id) };
  vm.runInNewContext(outputText, context, { filename: path });
  return loadedModule.exports;
}

function setup(options = {}) {
  const env = { ...defaults, ...options.env };
  const config = loadTs("../lib/storageConfig.ts", env);
  const calls = { uploads: [], cache: [], r2: [] };
  const storage = {
    upload: async (...args) => { calls.uploads.push(args); return { error: options.uploadError || null }; },
    getPublicUrl: (key) => ({ data: { publicUrl: `${config.supabaseStorageBase()}/${key}` } }),
  };
  const lib = loadTs("../lib/r2.ts", env, {
    "./storageConfig": config,
    "./supabase/admin": { supabaseAdmin: { storage: { from: (bucket) => {
      calls.bucket = bucket;
      return storage;
    } } } },
    "./assetCache": {
      hashBuffer: () => "test-hash",
      lookupAssetHash: async () => options.cached || null,
      storeAssetHash: async (...args) => {
        if (options.cacheError) throw new Error("cache unavailable");
        calls.cache.push(args);
      },
    },
    "./mediaMetadata": { stripMetadata: async (buffer) => buffer },
    "./guestMode": { GUEST_MODE: options.guest || false },
    "./guest/localStorage": { uploadBuffer: async () => "/generated/local.png" },
    "@aws-sdk/client-s3": {
      S3Client: class { async send(command) { calls.r2.push(command); } },
      PutObjectCommand: class { constructor(input) { this.input = input; } },
    },
  });
  return { lib, config, calls };
}

test("Supabase upload returns a public URL and records the cache without calling R2", async () => {
  const { lib, calls } = setup();
  const url = await lib.uploadBuffer(Buffer.from("test image"), "image/png", "uploads");
  assert.match(url, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/heliosgen-assets\/uploads\/.+\.png$/);
  assert.equal(calls.bucket, "heliosgen-assets");
  assert.equal(calls.uploads[0][2].contentType, "image/png");
  assert.equal(calls.uploads[0][2].upsert, false);
  assert.equal(calls.cache[0][1], url);
  assert.equal(calls.r2.length, 0);
});

test("Supabase upload errors are propagated and never cached", async () => {
  const { lib, calls } = setup({ uploadError: { message: "Bucket not found" } });
  await assert.rejects(lib.uploadBuffer(Buffer.from("test"), "image/png", "uploads"), /Supabase storage upload failed: Bucket not found/);
  assert.equal(calls.cache.length, 0);
});

test("files already cached in Supabase are reused", async () => {
  const cached = "https://example.supabase.co/storage/v1/object/public/heliosgen-assets/uploads/a.png";
  const { lib, calls } = setup({ cached });
  assert.equal(await lib.uploadBuffer(Buffer.from("test"), "image/png", "uploads"), cached);
  assert.equal(calls.uploads.length, 0);
});

test("re-uploading an old R2-cached file migrates its bytes to Supabase", async () => {
  const { lib, calls } = setup({ cached: "https://old.r2.dev/uploads/a.png" });
  await lib.uploadBuffer(Buffer.from("test"), "image/png", "uploads");
  assert.equal(calls.uploads.length, 1);
});

test("R2 remains the default when no storage provider is selected", async () => {
  const { lib, calls } = setup({ env: { STORAGE_PROVIDER: undefined } });
  assert.match(await lib.uploadBuffer(Buffer.from("test"), "video/mp4", "references"), /^https:\/\/old\.r2\.dev\/references\/.+\.mp4$/);
  assert.equal(calls.r2.length, 1);
  assert.equal(calls.r2[0].input.Bucket, "old-bucket");
  assert.equal(calls.uploads.length, 0);
});

test("guest uploads keep using local storage", async () => {
  const { lib, calls } = setup({ guest: true });
  assert.equal(await lib.uploadBuffer(Buffer.from("test"), "image/png", "uploads"), "/generated/local.png");
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.r2.length, 0);
});

test("existing Supabase and R2 URLs are not mirrored again", async () => {
  const { lib } = setup();
  for (const url of ["https://old.r2.dev/uploads/a.png", "https://example.supabase.co/storage/v1/object/public/heliosgen-assets/uploads/a.png"]) {
    assert.equal(await lib.ensureR2(url, "uploads"), url);
  }
});

test("storage allowlist rejects lookalike hosts and other buckets", () => {
  const { config } = setup();
  for (const url of [
    "https://old.r2.dev.evil.example/a.png",
    "https://old.r2.dev@evil.example/a.png",
    "http://old.r2.dev/a.png",
    "https://example.supabase.co/storage/v1/object/public/heliosgen-assets-other/a.png",
    "https://example.supabase.co/storage/v1/object/public/heliosgen-assets/../private/a.png",
    "https://example.supabase.co/auth/v1/user",
    "not a url",
  ]) assert.equal(config.isStoredAssetUrl(url), false, url);
});

test("custom bucket and trailing project slash are supported", () => {
  const { config } = setup({ env: { SUPABASE_STORAGE_BUCKET: "custom", NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co/" } });
  assert.equal(config.supabaseStorageBase(), "https://example.supabase.co/storage/v1/object/public/custom");
});

test("Next image configuration allows only this project's public storage bucket", () => {
  const { default: config } = loadTs("../next.config.ts", defaults);
  const pattern = config.images.remotePatterns[0];
  assert.equal(pattern.hostname, "example.supabase.co");
  assert.equal(pattern.pathname, "/storage/v1/object/public/heliosgen-assets/**");
  assert.equal(pattern.protocol, "https");
  assert.equal(pattern.search, "");
});

test("Next image configuration still loads without Supabase environment variables", () => {
  const { default: config } = loadTs("../next.config.ts", {});
  assert.equal(config.images.remotePatterns.length, 6);
});
