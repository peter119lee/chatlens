"use strict";

// Guards the failure mode that produced a blank knowledge page: the web/ files
// are CLASSIC scripts sharing one global scope, so two files declaring the same
// top-level `const` is a SyntaxError that kills the whole page. `node -c` cannot
// catch it (each file is valid alone) and no other test loads them together.
//
// This evaluates every page script in the real order inside one shared context,
// which is exactly how the browser loads them.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");

// The scripts the page actually loads, in the order it loads them.
const pageScripts = () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  return [...html.matchAll(/<script src="\/([^"]+)"><\/script>/gu)].map((match) => match[1]);
};

const makeNode = (tag) => ({
  tagName: String(tag).toUpperCase(),
  children: [],
  dataset: {},
  style: {},
  attributes: {},
  isConnected: true,
  classList: {
    _set: new Set(),
    add(...names) { for (const name of names) { this._set.add(name); } },
    remove(...names) { for (const name of names) { this._set.delete(name); } },
    toggle(name, on) { if (on) { this._set.add(name); } else { this._set.delete(name); } },
    contains(name) { return this._set.has(name); },
  },
  setAttribute(key, value) { this.attributes[key] = value; },
  addEventListener() {},
  removeEventListener() {},
  append(...kids) { this.children.push(...kids); },
  replaceChildren(...kids) { this.children = kids; },
  getBoundingClientRect() { return { top: 0, left: 0, width: 1200, height: 800 }; },
  get clientWidth() { return 1200; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  set textContent(value) { this._text = value; },
  get textContent() { return this._text ?? ""; },
  set className(value) { this._class = value; },
  get className() { return this._class ?? ""; },
  set innerHTML(value) { this._html = value; },
  get innerHTML() { return this._html ?? ""; },
  focus() {},
  scrollIntoView() {},
  remove() {},
  closest() { return null; },
  insertBefore() {},
});

const makeSandbox = () => {
  const nodes = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      createElement: makeNode,
      createDocumentFragment: () => makeNode("fragment"),
      querySelector: (selector) => {
        if (!nodes.has(selector)) { nodes.set(selector, makeNode("div")); }
        return nodes.get(selector);
      },
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      documentElement: makeNode("html"),
      body: makeNode("body"),
      head: makeNode("head"),
      activeElement: null,
      visibilityState: "visible",
    },
    localStorage: {
      _data: new Map(),
      getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
      setItem(key, value) { this._data.set(key, String(value)); },
      removeItem(key) { this._data.delete(key); },
    },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "test" },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    queueMicrotask(fn) { fn(); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    alert() {},
    confirm: () => false,
    prompt: () => null,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    URLSearchParams,
    URL,
    Intl,
    // el() checks `child instanceof Node`; without it, boot's async work throws
    // after the test ends and surfaces as an unhandled rejection.
    Node: class Node {},
    // Boot fetches state on DOMContentLoaded. Rejecting immediately keeps the
    // scripts from starting real work we do not want to assert on here.
    Promise,
    _nodes: nodes,
  };
  sandbox.window = {
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    location: { href: "http://127.0.0.1:8321/", search: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    open() {},
    devicePixelRatio: 1,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
};

test("every page script loads together without a global collision", () => {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  // app.js declares TOKEN itself from a meta tag, so the harness must NOT
  // pre-declare it or it would report a collision of its own making.

  const failures = [];
  for (const script of pageScripts()) {
    const file = path.join(WEB, script);
    assert.ok(fs.existsSync(file), `index.html references a missing script: ${script}`);
    try {
      vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: script });
    } catch (error) {
      // A ReferenceError deep in a render path is expected in a fake DOM; a
      // SyntaxError or a duplicate declaration is a genuine page-breaking bug.
      if (error instanceof SyntaxError || /already been declared/u.test(error.message)) {
        failures.push(`${script}: ${error.message}`);
      }
    }
  }

  assert.deepEqual(failures, [], `scripts cannot coexist in one global scope:\n${failures.join("\n")}`);
});

test("index.html references only scripts that exist", () => {
  for (const script of pageScripts()) {
    assert.ok(fs.existsSync(path.join(WEB, script)), `missing: ${script}`);
  }
});

test("the knowledge grid math module is reachable under its own global name", () => {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WEB, "knowledge_grid_math.js"), "utf8"), context, {
    filename: "knowledge_grid_math.js",
  });

  assert.equal(typeof sandbox.window.KnowledgeGridMath, "object");
  assert.equal(typeof sandbox.window.KnowledgeGridMath.windowFor, "function");
});

test("no two page scripts declare the same top-level const", () => {
  // Catches the collision class directly, with a readable message naming both
  // files, rather than only failing at evaluation time.
  const declarations = new Map();
  const duplicates = [];
  for (const script of pageScripts()) {
    const source = fs.readFileSync(path.join(WEB, script), "utf8");
    for (const match of source.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gmu)) {
      const name = match[1];
      const owner = declarations.get(name);
      if (owner !== undefined && owner !== script) {
        duplicates.push(`${name}: declared in both ${owner} and ${script}`);
      } else {
        declarations.set(name, script);
      }
    }
  }

  assert.deepEqual(duplicates, [], `top-level identifiers collide across classic scripts:\n${duplicates.join("\n")}`);
});
