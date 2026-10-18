/**
 * Port simulation for the dsh-background v2 bundle (check 2).
 * Loads client.js the way window.__ModuleLoader__ would, applies it with a
 * stub rc.2 context (configForms/slots/locale/theme), then drives every
 * registered component against stub dispatch props, including the
 * rc.2 viewed-session selection (retainedBy.mainView, blank rows).
 * Run: node tools/port-sim.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// Minimal document stub with a body that records attribute writes — the
// palette-flip machinery drives `data-ds-dark-theme` on it.
const bodyAttrs = new Map();
const bodyChildren = [];
function makeEl(tag) {
  const el = {
    tag,
    style: {},
    dataset: {},
    className: "",
    children: [],
    setAttribute(name, value) { el.attributes.set(name, String(value)); },
    getAttribute(name) { return el.attributes.has(name) ? el.attributes.get(name) : null; },
    appendChild(child) { el.children.push(child); return child; },
    attributes: new Map(),
    classList: {
      _set: new Set(),
      add(c) { el.classList._set.add(c); },
      remove(c) { el.classList._set.delete(c); },
      toggle(c, force) {
        if (force === true) el.classList._set.add(c);
        else if (force === false) el.classList._set.delete(c);
        else if (el.classList._set.has(c)) el.classList._set.delete(c);
        else el.classList._set.add(c);
      },
      contains(c) { return el.classList._set.has(c); },
    },
  };
  return el;
}
const bodyEl = {
  hasAttribute: (name) => bodyAttrs.has(name),
  getAttribute: (name) => (bodyAttrs.has(name) ? bodyAttrs.get(name) : null),
  setAttribute: (name, value) => bodyAttrs.set(name, String(value)),
  removeAttribute: (name) => bodyAttrs.delete(name),
  appendChild(child) { bodyChildren.push(child); return child; },
  removeChild(child) {
    const at = bodyChildren.indexOf(child);
    if (at < 0) throw new Error("node is not a child of body");
    bodyChildren.splice(at, 1);
  },
  classList: { add() {}, remove() {} },
};
globalThis.document = {
  body: bodyEl,
  contains: () => false, // every paint rebuilds the layer — fine for the sim
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: makeEl,
  head: { appendChild() {} },
  styleSheets: [],
};

const factoryLog = [];
const react = {
  createElement(tag, props, ...children) {
    return { tag, props: props || {}, children: children.filter((c) => c !== null && c !== undefined) };
  },
  Fragment: "#fragment",
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useRef(initial) {
    return { current: initial === undefined ? null : initial };
  },
  // Effects are queued, not dropped: the sim runs them manually so the
  // painter's paint path (and with it the palette flip) actually executes.
  useEffect(fn) {
    effects.push(fn);
  },
  useLayoutEffect() {},
};
const effects = [];
const runEffects = () => {
  while (effects.length > 0) effects.shift()();
};
const miniStore = {
  createSnapshotStore(value) {
    let current = value;
    const listeners = new Set();
    return {
      getSnapshot: () => current,
      set(next) {
        current = next;
      },
      update(fn) {
        fn(current);
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  },
};
function fakeRequire(name) {
  if (name === "react") return react;
  if (name === "@deepseek-ai/dsh-client-store") return miniStore;
  return {}; // optional deps (primitives probes) degrade to empty
}

const source = readFileSync(join(root, "client.js"), "utf8");
new Function("window", "require", "console", source)(globalThis.window, fakeRequire, console);
if (captured === null) throw new Error("client.js never called window.__ModuleLoader__.load");
const exports = captured.factory(fakeRequire);
factoryLog.push(`module id: ${captured.id}`);

const assert = (cond, label) => {
  if (!cond) throw new Error("FAIL: " + label);
  console.log("ok   " + label);
};

assert(captured.id === "dsh-background", "ModuleLoader id is dsh-background");
assert(Array.isArray(exports.inject) && exports.inject.join(",") === ["sessions", "slots", "locale", "configForms", "theme"].join(","), "inject list = sessions,slots,locale,configForms,theme");

const registered = [];
const themeListeners = [];
const scope = { status: "ready", value: { language: "auto", panelTransparency: 30 }, writable: true, set(key, value) { scope.value = { ...scope.value, [key]: value }; } };
const ctx = {
  effect(fn) {
    fn();
  },
  on(event, fn) {
    if (event === "theme/change") themeListeners.push(fn);
  },
  locale: { register() {} },
  configForms: {
    get(ns) {
      assert(ns === "chat-background", "configForms.get(chat-background)");
      return scope;
    },
  },
  slots: {
    inject(slotName, maker) {
      try {
        maker();
      } catch (error) {
        throw new Error(`slot ${slotName} registration crashed: ${error && error.message}`);
      }
    },
    register(desc, component) {
      registered.push({ desc, component });
      return { desc, component };
    },
  },
  theme: { overrideTokens() { return () => {}; } },
};
exports.apply(ctx);

const byId = (desc) => desc.id;
assert(registered.map((r) => r.desc.name).join("|") === "shell.overlay|shell.overlay|conversation.session.header.utilities|plugins.bundle.config", "four slot registrations on the rc.2 slots");
assert(registered[3].desc.key === "dsh-background", "plugins.bundle.config keyed by the package name");
assert(registered.every((r) => r.desc.inject instanceof Function), "every registration shares the inject face");

const face = registered[0].desc.inject();
assert(face.hooks.config === scope, "face exposes the configForms scope as hooks.config");
assert(face.hooks.device !== undefined && typeof face.hooks.device.getSnapshot === "function", "face exposes the device store as hooks.device");
assert(typeof face.actions.setLanguage === "function" && typeof face.actions.setTransparencyLive === "function", "face actions present");
assert(face.actions.setEnabled === undefined, "removed the dead enabled action");

// ── per-device variants: patch routing, dialog selector, copy helper ─────────
const IMAGE_A = "a".repeat(20) + ".png";
const IMAGE_B = "b".repeat(20) + ".png";
face.actions.patch("s1", { imageId: IMAGE_A, offsetX: 5 }, "mobile");
face.actions.patch("s1", { imageId: IMAGE_B }, "desktop");
const routed = face.hooks.background.getSnapshot().sessions.s1;
assert(routed.desktop !== null && routed.desktop.imageId === IMAGE_B, "desktop patch lands in the desktop variant");
assert(routed.mobile !== null && routed.mobile.imageId === IMAGE_A && routed.mobile.offsetX === 5, "mobile patch lands in the mobile variant (desktop untouched)");

const walk = (node, fn) => {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (node.tag !== undefined || node.props !== undefined) fn(node);
  for (const child of Array.isArray(node.children) ? node.children : []) walk(child, fn);
  const inner = node.children !== undefined && !Array.isArray(node.children) ? [] : [];
  void inner;
};
const findNode = (tree, pred) => {
  let hit = null;
  walk(tree, (n) => {
    if (hit === null && pred(n)) hit = n;
  });
  return hit;
};

// ── viewed-session selection through the painter's useSessions selector ──────
const painter = registered.find((r) => byId(r.desc) === "chat-background-painter").component;
const dialog = registered.find((r) => byId(r.desc) === "chat-background-dialog").component;
const bundleConfig = registered.find((r) => byId(r.desc) === undefined || r.desc.name === "plugins.bundle.config").component;
const headerButton = registered.find((r) => byId(r.desc) === "chat-background-button").component;

const seen = [];
const bg = { status: "ready", sessions: { s1: { desktop: { imageId: IMAGE_B, offsetX: 0, offsetY: 0, zoom: 1, scrim: 0, fontColor: null }, mobile: { imageId: IMAGE_A, offsetX: 5, offsetY: 0, zoom: 1, scrim: 0, fontColor: null } } } };
const tp = { value: null };
const hookProps = (sessionsState, viewState, backgroundState) => ({
  useSessions: (sel) => {
    const value = sel(sessionsState);
    seen.push(value);
    return value;
  },
  useBackground: () => (backgroundState !== undefined ? backgroundState : bg),
  useConfig: () => scope,
  useView: () => viewState,
  useTp: () => tp,
  useDevice: () => ({ value: "desktop" }),
  t: (key) => key,
  actions: face.actions,
  sessionId: "s1",
  view: "page",
});

const mainRow = { ids: ["s1"], byId: { s1: { id: "s1", blank: false, retainedBy: { mainView: 1 } } } };
painter(hookProps(mainRow, { open: false, sessionId: null }));
assert(seen.pop() === "s1", "painter picks the mainView-retained row as the current chat");

const blankRow = { ids: ["b"], byId: { b: { id: "b", blank: true, retainedBy: { mainView: 1 } } } };
painter(hookProps(blankRow, { open: false, sessionId: null }));
assert(seen.pop() === null, "painter treats the blank New-session row as no session");

const noRetention = { ids: ["x"], byId: { x: { id: "x", blank: false, retainedBy: {} } } };
painter(hookProps(noRetention, { open: false, sessionId: null }));
assert(seen.pop() === null, "painter finds nothing when no row is mainView-retained");

const degraded = hookProps(mainRow, { open: false, sessionId: null });
degraded.useConfig = undefined;
degraded.useSessions = undefined;
painter(degraded);
assert(seen.length === 0, "missing dispatch hooks degrade to no-background, not a crash");

assert(painter(hookProps(mainRow, { open: false, sessionId: null })) === null, "painter renders null");

// ── palette flip: the font color drives the body palette attribute ───────────
assert(themeListeners.length === 1, "theme/change listener registered for the flip reassert");
const darkPhotoBg = { status: "ready", sessions: { s1: { desktop: { imageId: IMAGE_B, offsetX: 0, offsetY: 0, zoom: 1, scrim: 0, fontColor: "#ffffff" }, mobile: null } } };
painter(hookProps(mainRow, { open: false, sessionId: null }, darkPhotoBg));
runEffects();
assert(bodyAttrs.has("data-ds-dark-theme"), "light font color forces the dark palette attribute on body");
const presenterWrite = () => {
  for (const fn of themeListeners) fn();
};
presenterWrite();
assert(bodyAttrs.has("data-ds-dark-theme"), "flip reasserts after the theme presenter recomposes");
const lightPhotoBg = { status: "ready", sessions: { s1: { desktop: { imageId: IMAGE_B, offsetX: 0, offsetY: 0, zoom: 1, scrim: 0, fontColor: "#101010" }, mobile: null } } };
painter(hookProps(mainRow, { open: false, sessionId: null }, lightPhotoBg));
runEffects();
assert(!bodyAttrs.has("data-ds-dark-theme"), "dark font color forces the light palette (attribute removed)");
const noColorBg = { status: "ready", sessions: { s1: { desktop: { imageId: IMAGE_B, offsetX: 0, offsetY: 0, zoom: 1, scrim: 0, fontColor: null }, mobile: null } } };
painter(hookProps(mainRow, { open: false, sessionId: null }, noColorBg));
runEffects();
assert(!bodyAttrs.has("data-ds-dark-theme"), "clearing the font color hands the palette attribute back");

// dialog closed renders null; header button renders a button element
assert(dialog(hookProps(mainRow, { open: false, sessionId: null })) === null, "closed dialog renders null");
const btn = headerButton(hookProps(mainRow, { open: false, sessionId: null }));
assert(btn.tag === "button", "header button renders a button");

// dialog open with a photo-less chat renders the tree without /state round-trip
const openView = { open: true, sessionId: "s1", error: null };
const opened = dialog(hookProps(mainRow, openView));
assert(opened !== null && opened.tag !== null, "open dialog renders the panel tree");

// ── the dialog edits the detected device's variant, switchable ───────────────
const phoneProps = { ...hookProps(mainRow, openView), useDevice: () => ({ value: "mobile" }) };
const phoneDialog = dialog(phoneProps);
const phoneImg = findNode(phoneDialog, (n) => n.tag === "img");
assert(phoneImg !== null && String(phoneImg.props.src).endsWith("/" + IMAGE_A), "dialog on a phone edits the mobile variant (preview shows the mobile photo)");
const devButtons = [];
walk(phoneDialog, (n) => {
  if (n.tag === "button" && typeof n.props.className === "string" && n.props.className.indexOf("cbg-devBtn") >= 0) devButtons.push(n);
});
assert(devButtons.length === 2 && String(devButtons[0].children[0]) === "device.desktop" && String(devButtons[1].children[0]).indexOf("device.mobile") === 0, "device selector offers Desktop and Phone");
const phoneFrame = findNode(phoneDialog, (n) => typeof n.props.className === "string" && n.props.className.indexOf("cbg-previewFrameM") >= 0);
assert(phoneFrame !== null, "phone variant draws the phone-shaped replica frame");
const pcDialog = dialog(hookProps(mainRow, openView));
const pcImg = findNode(pcDialog, (n) => n.tag === "img");
assert(pcImg !== null && String(pcImg.props.src).endsWith("/" + IMAGE_B), "dialog on a desktop edits the desktop variant");
const emptyMobileBg = { status: "ready", sessions: { s1: { desktop: { imageId: IMAGE_B, offsetX: 0, offsetY: 0, zoom: 1, scrim: 0, fontColor: null }, mobile: null } } };
const copyProps = { ...hookProps(mainRow, openView), useDevice: () => ({ value: "mobile" }), useBackground: () => emptyMobileBg };
const copyDialog = dialog(copyProps);
const copyBtn = findNode(copyDialog, (n) => n.tag === "button" && String(n.children[0]).indexOf("device.desktop") >= 0);
assert(copyBtn !== null, "photo-less phone variant offers to copy the desktop photo");

// bundle config page: summary, page, loading
const cfgProps = hookProps(mainRow, { open: false, sessionId: null });
const summary = bundleConfig({ ...cfgProps, view: "summary" });
assert(summary.tag === "span" && String(summary.children[0]).length > 0, "summary view renders a one-liner");
const page = bundleConfig({ ...cfgProps, view: "page" });
assert(page.tag === "div", "page view renders the settings card");
const loadingScope = { ...scope, status: "loading" };
const loading = bundleConfig({ ...cfgProps, view: "page", useConfig: () => loadingScope });
assert(typeof loading.tag === "string", "loading scope renders a note, not a crash");
const readonlyScope = { ...scope, writable: false };
const readonlyPage = bundleConfig({ ...cfgProps, view: "page", useConfig: () => readonlyScope });
assert(readonlyPage.tag === "div", "read-only scope still renders (controls disabled)");

// config round-trip: the page writes through the same scope the painter reads
face.actions.setLanguage("ru");
assert(scope.value.language === "ru", "setLanguage writes language through the configForms scope");
face.actions.setTransparencyLive(55);
face.actions.setTransparencySoon(55, true);
assert(scope.value.panelTransparency === 55, "transparency commits through the configForms scope");

console.log("\nAll port-sim assertions passed.");
