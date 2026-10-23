#!/usr/bin/env node
// Everything the site serves is precached, so the game plays offline from
// the first visit. This fails on a PRECACHE entry in main-site/sw.js with no
// file on disk, on a file the app can load that is not precached, and on
// the worker's picture packs drifting from js/rules.js.
//
// sw.js builds part of its list from the pack names, so the list is read by
// running the worker's source with a stand-in `self`.
//
// Run: node scripts/check-precache.mjs

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site");
const source = readFileSync(join(ROOT, "sw.js"), "utf8");

const context = vm.createContext({ self: { addEventListener() {}, location: { origin: "https://example.test" } } });
vm.runInContext(`${source}\n;globalThis.__precache = PRECACHE; globalThis.__packs = PACKS; globalThis.__models = MODEL_PACKS;`, context);
const entries = [...context.__precache];

// cleanUrls is on, so "/" is index.html on disk.
const onDisk = (route) => (route === "/" ? "index.html" : route.replace(/^\//, ""));

const seen = new Set();
const missing = [];
const duplicates = [];
for (const route of entries) {
  if (seen.has(route)) duplicates.push(route);
  seen.add(route);
  if (!existsSync(join(ROOT, onDisk(route)))) missing.push(route);
}

function walk(dir) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).flatMap((name) => {
    const path = join(full, name);
    return statSync(path).isDirectory() ? walk(join(dir, name)) : [path];
  });
}

// What the app can load: its modules, styles, font, pictures, models and
// vendored libraries. Licence and readme text is not loaded.
const LOADED = /\.(js|css|woff2|png|glb)$/;
const unlisted = [];
for (const dir of ["js", "css", "fonts", "tiles", "models", "vendor"]) {
  for (const path of walk(dir)) {
    if (!LOADED.test(path)) continue;
    const route = `/${relative(ROOT, path).split(sep).join("/")}`;
    if (!seen.has(route)) unlisted.push(route);
  }
}

const { PACKS } = await import(pathToFileURL(join(ROOT, "js", "rules.js")).href);
const drift = [];
for (const [id, pack] of Object.entries(PACKS)) {
  if (pack.mix) continue;
  const want = pack.tiles.map((t) => t.split("/")[1]).join(" ");
  if (context.__packs[id] !== want) drift.push(`${id}: sw.js and js/rules.js list different pictures`);
  if (pack.models !== context.__models.includes(id)) drift.push(`${id}: models disagree`);
}
for (const id of Object.keys(context.__packs)) if (!PACKS[id]) drift.push(`${id}: in sw.js, not in js/rules.js`);

if (duplicates.length) console.error(`duplicate PRECACHE entries:\n  - ${duplicates.join("\n  - ")}`);
if (missing.length) console.error(`PRECACHE entries with no file on disk:\n  - ${missing.join("\n  - ")}`);
if (unlisted.length) console.error(`files the app loads that are not precached:\n  - ${unlisted.join("\n  - ")}`);
if (drift.length) console.error(`picture packs out of step:\n  - ${drift.join("\n  - ")}`);

if (missing.length || duplicates.length || unlisted.length || drift.length) process.exit(1);

console.log(`precache ok: ${entries.length} entries, all present, nothing left out, packs in step.`);
