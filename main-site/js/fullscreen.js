// Full screen. The page goes full screen where the browser allows it, and
// fills the window where it does not (Safari on iPhone lets only video do
// that; added to the home screen, the app is full screen already). Either
// way the header and footer go, the board grows to the height of the
// screen, and the header's buttons become the Edge Tray, as sg-psi's and
// per edge-tray-spec.md: a column top right that slides off the edge and
// leaves an arrow tab to bring it back. Whether the tray is open is
// remembered in this browser. After chess-game's fullscreen.js.

import { setIcon, store } from "./ui.js";

const TRAY_KEY = "uwumemy.trayOpen";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

// Full screen without the Fullscreen API: on until turned off.
let fallback = false;

const canReallyGoFull = () => Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fullElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
export const isFull = () => Boolean(fullElement()) || fallback;

async function enter() {
  if (canReallyGoFull()) {
    try {
      await (root.requestFullscreen?.call(root, { navigationUI: "hide" }) ?? root.webkitRequestFullscreen?.call(root));
      return;
    } catch {
      // Refused: fill the window instead.
    }
  }
  fallback = true;
  sync();
}

async function leave() {
  fallback = false;
  if (fullElement()) {
    try {
      await (document.exitFullscreen?.call(document) ?? document.webkitExitFullscreen?.call(document));
    } catch {
      // Already out.
    }
  }
  sync();
}

function setTray(open, { save = true } = {}) {
  const full = isFull();
  $("topbar").classList.toggle("collapsed", full && !open);
  $("trayTab").setAttribute("aria-expanded", String(open));
  const label = open ? "Hide menu" : "Show menu";
  $("trayTab").setAttribute("aria-label", label);
  $("trayTab").title = label;
  // Buttons slid off screen must not take focus.
  $("trayButtons").inert = full && !open;
  document.body.classList.toggle("tray-open", full && open);
  if (save) store.set(TRAY_KEY, open ? "1" : "0");
}

const trayOpen = () => store.get(TRAY_KEY) !== "0";

function sync() {
  const full = isFull();
  // Changing between layouts is not a tray movement: no slide for that frame.
  root.classList.add("tray-switching");
  root.classList.toggle("is-full", full);
  const btn = $("fullBtn");
  const label = full ? "Leave full screen" : "Full screen";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  setIcon(btn, full ? "shrink" : "expand");
  setTray(trayOpen(), { save: false });
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("tray-switching")));
  window.dispatchEvent(new Event("resize"));
}

export function initFullscreen() {
  $("fullBtn").addEventListener("click", () => (isFull() ? leave() : enter()));
  $("trayTab").addEventListener("click", () => setTray($("topbar").classList.contains("collapsed")));
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);
  document.addEventListener("keydown", (e) => {
    // Esc already leaves real full screen; this covers the window-filling kind.
    if (e.key === "Escape" && fallback && !document.body.classList.contains("modal-open")) leave();
  });
  sync();
}
