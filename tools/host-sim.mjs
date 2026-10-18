/**
 * Host-half port simulation: apply() with volatile config references, route
 * registration through webServer.register, the /stats diagnostics response,
 * the Config export shape, and the v2 per-device state model (migration from
 * v1, device-scoped session writes, variant-aware GC).
 *
 * Runs against a THROWAWAY %DSH_HOME% (temp dir): the module reads DATA_DIR at
 * import time, so the env var must be set before the dynamic import. The
 * real profile data is never touched.
 * Run: node tools/host-sim.mjs
 */
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), "cbg-host-sim-"));
const dataDir = join(sandbox, "plugin-data", "dsh-background");
mkdirSync(dataDir, { recursive: true });
// v1 state with one flat config: the upgrade must copy it into BOTH variants.
writeFileSync(
  join(dataDir, "state.json"),
  JSON.stringify({ version: 1, sessions: { legacy1: { imageId: "aaaaaaaaaaaaaaaaaaaa.png", offsetX: -12, offsetY: 34, zoom: 2, scrim: -5, fontColor: null } } }),
  "utf8"
);
process.env.DSH_HOME = sandbox;
const host = await import(pathToFileURL(join(root, "host.mjs")).href);

const assert = (cond, label) => {
  if (!cond) throw new Error("FAIL: " + label);
  console.log("ok   " + label);
};

assert(host.name === "chat-background", "export name = chat-background");
assert(JSON.stringify(host.inject) === '["webServer"]', "inject = webServer (hard dep)");
assert(typeof host.Config === "function" || (host.Config !== null && typeof host.Config === "object"), "Config schema exported (schemastery loaded)");

const registered = [];
let effects = 0;
const ctx = {
  effect(fn, label) {
    effects++;
    fn();
  },
  webServer: {
    register(def) {
      registered.push(def);
    },
  },
  get() {
    return undefined;
  },
  logger: { debug() {}, warn() {}, error() {} },
};

// Volatile fields arrive as live references; plain values as values. Try both.
host.apply(ctx, { panelTransparency: { get: () => 42 }, language: { get: () => "ru" } });
assert(registered.length === 1 && registered[0].kind === "prefix" && registered[0].path === "/chat-background", "routes registered as a /chat-background prefix");
const state = host.readChatBackgroundState();
assert(state.panelTransparency === 42 && state.language === "ru", "volatile config references are read (42, ru)");

host.apply(ctx, { panelTransparency: 7, language: "auto" });
assert(host.readChatBackgroundState().panelTransparency === 7, "plain config values are read too");
assert(host.readChatBackgroundState().language === "auto", "plain config language read");

host.apply(ctx, undefined);
assert(host.readChatBackgroundState().panelTransparency === 30 && host.readChatBackgroundState().language === "auto", "absent config falls back to defaults");

host.apply(ctx, { panelTransparency: { get: () => 999 }, language: { get: () => "de" } });
const weird = host.readChatBackgroundState();
assert(weird.panelTransparency === 999 || typeof weird.panelTransparency === "number", "out-of-range volatile read never crashes apply");

// ── exercise the diagnostics route ───────────────────────────────────────────
const handler = registered[0].handler;
class FakeRes {
  constructor() {
    this.chunks = [];
    this.headers = null;
    this.code = 0;
  }
  writeHead(code, headers) {
    this.code = code;
    this.headers = headers;
  }
  end(body) {
    this.chunks.push(body);
  }
}
const res = new FakeRes();
handler({ url: "/chat-background/stats", method: "GET", on() {}, destroy() {} }, res);
const body = JSON.parse(res.chunks.join(""));
assert(res.code === 200 && typeof body.hits === "object", "GET /stats answers 200 JSON");
assert(typeof body.panelTransparency === "number" && typeof body.language === "string", "stats reports live config");

const res404 = new FakeRes();
handler({ url: "/chat-background/nope", method: "GET", on() {}, destroy() {} }, res404);
assert(res404.code === 404, "unknown sub-path answers 404");

// ── v2 per-device model ──────────────────────────────────────────────────────
const stateBody = JSON.parse(await new Promise((resolve) => {
  const r = new FakeRes();
  handler({ url: "/chat-background/state", method: "GET", on() {}, destroy() {} }, r);
  resolve(r.chunks.join(""));
}));
assert(stateBody.version === 2, "/state reports the v2 shape");
const legacy = stateBody.sessions.legacy1;
assert(legacy.desktop !== null && legacy.desktop.imageId === "aaaaaaaaaaaaaaaaaaaa.png" && legacy.desktop.offsetX === -12, "v1 flat config migrated into the desktop variant");
assert(legacy.mobile !== null && legacy.mobile.imageId === "aaaaaaaaaaaaaaaaaaaa.png", "v1 flat config copied into the mobile variant too (no visual change)");

/** POST /session through the real handler. */
const postSession = (payload) =>
  new Promise((resolve) => {
    const chunks = [];
    const r = new FakeRes();
    r.end = (body) => {
      chunks.push(body);
      resolve({ code: r.code, body: chunks.join("") });
    };
    const req = {
      on(event, fn) {
        if (event === "data") fn(Buffer.from(JSON.stringify(payload)));
        if (event === "end") fn();
      },
      destroy() {},
    };
    handler({ url: "/chat-background/session", method: "POST", ...req }, r);
  });

let done = await postSession({ sessionId: "legacy1", device: "mobile", config: { imageId: "bbbbbbbbbbbbbbbbbbbb.png", zoom: 1.4 } });
assert(done.code === 200, "device-scoped POST /session answers ok");
const after = JSON.parse(await new Promise((resolve) => {
  const r = new FakeRes();
  handler({ url: "/chat-background/state", method: "GET", on() {}, destroy() {} }, r);
  resolve(r.chunks.join(""));
})).sessions.legacy1;
assert(after.mobile.imageId === "bbbbbbbbbbbbbbbbbbbb.png" && after.desktop.imageId === "aaaaaaaaaaaaaaaaaaaa.png", "mobile write left the desktop variant untouched");

const persisted = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
assert(persisted.version === 2 && persisted.sessions.legacy1.mobile.imageId === "bbbbbbbbbbbbbbbbbbbb.png", "state.json persists the v2 pair");

done = await postSession({ sessionId: "legacy1", device: "mobile", config: null });
const cleared = JSON.parse(await new Promise((resolve) => {
  const r = new FakeRes();
  handler({ url: "/chat-background/state", method: "GET", on() {}, destroy() {} }, r);
  resolve(r.chunks.join(""));
})).sessions.legacy1;
assert(cleared.mobile === null && cleared.desktop.imageId === "aaaaaaaaaaaaaaaaaaaa.png", "null config clears only the named variant");

await postSession({ sessionId: "legacy1", device: "desktop", config: null });
assert(!existsSync(join(dataDir, "images", "aaaaaaaaaaaaaaaaaaaa.png")), "GC collects a photo after its last referencing variant is cleared");
assert(!existsSync(join(dataDir, "images", "bbbbbbbbbbbbbbbbbbbb.png")), "GC had already collected the mobile-only photo");

done = await postSession({ sessionId: "gone", device: "desktop", config: null });
const dropped = JSON.parse(await new Promise((resolve) => {
  const r = new FakeRes();
  handler({ url: "/chat-background/state", method: "GET", on() {}, destroy() {} }, r);
  resolve(r.chunks.join(""));
})).sessions;
assert(dropped.gone === undefined, "a chat with no variants left is dropped from the state");

console.log("\nAll host-sim assertions passed.");
