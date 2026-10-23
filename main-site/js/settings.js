// Player settings, kept in this browser, after MRT Station Guesser's. The
// game reads them through getSettings() and hears about changes on the
// "memy:settings" event. Game options apply from the next game.

import { api } from "./api.js";
import {
  DIFFICULTIES,
  GAME_LIMIT_LABELS,
  cleanDifficulty,
  cleanLimit,
  cleanPack,
  cleanTurn,
  gameLimitMs,
} from "./rules.js";
import { formatTime, openModal, store } from "./ui.js";

const STORAGE = "uwumemy.settings";

const DEFAULTS = {
  name: null,
  auto_submit: false,
  auto_replay: false,
  difficulty: "normal",
  pack: "mixed",
  turn: 0,
  limit: 0,
};

let current = null;

function load() {
  let saved = {};
  try {
    saved = JSON.parse(store.get(STORAGE) ?? "{}") ?? {};
  } catch {
    // Unreadable: the defaults.
  }
  const out = { ...DEFAULTS };
  if (typeof saved.name === "string" && saved.name.trim()) out.name = saved.name.trim();
  out.auto_submit = saved.auto_submit === true;
  out.auto_replay = saved.auto_replay === true;
  out.difficulty = cleanDifficulty(saved.difficulty);
  out.pack = cleanPack(saved.pack);
  out.turn = cleanTurn(saved.turn);
  out.limit = cleanLimit(saved.limit);
  // Adding games automatically needs a name to add them under.
  if (!out.name) out.auto_submit = false;
  return out;
}

export function getSettings() {
  current ??= load();
  return { ...current };
}

export function saveSettings(changes) {
  current = { ...getSettings(), ...changes };
  if (!current.name) current.auto_submit = false;
  store.set(STORAGE, JSON.stringify(current));
  render();
  document.dispatchEvent(new CustomEvent("memy:settings", { detail: getSettings() }));
  return getSettings();
}

const $ = (id) => document.getElementById(id);

function render() {
  const s = getSettings();
  $("clearNameBtn").classList.toggle("hidden", !s.name);
  $("savedName").textContent = `Now: ${s.name ?? "Not set"}`;

  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    const on = s[el.dataset.setting];
    el.setAttribute("aria-checked", String(on));
    el.querySelector(".switch-state").textContent = on ? "On" : "Off";
  });
  document.querySelector('[data-setting="auto_submit"]').disabled = !s.name;
  $("autoNote").classList.toggle("hidden", Boolean(s.name));

  const press = (selector, attr, value) =>
    document.querySelectorAll(selector).forEach((el) => {
      const on = el.dataset[attr] === String(value);
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    });
  press("#difficultyToggle [data-difficulty]", "difficulty", s.difficulty);
  press("#packToggle [data-pack]", "pack", s.pack);
  press("#turnToggle [data-turn]", "turn", s.turn);
  press("#limitToggle [data-limit]", "limit", s.limit);

  const d = DIFFICULTIES[s.difficulty];
  $("limitNote").textContent = s.limit
    ? `${GAME_LIMIT_LABELS[s.limit]} on ${d.label} is ${formatTime(gameLimitMs(s.difficulty, s.limit))} for ${d.pairs} pairs.`
    : `No game limit. Finishing quickly still earns a time bonus.`;
}

async function onSaveName(event) {
  event.preventDefault();
  const input = $("settingsName");
  const msg = $("nameMsg");
  const name = input.value.trim();
  if (!name) {
    msg.textContent = "Enter a name.";
    input.focus();
    return;
  }
  $("saveNameBtn").disabled = true;
  msg.textContent = "";
  try {
    // The API cleans and checks it, the same check a submission gets.
    const result = await api.checkName(name);
    saveSettings({ name: result.name });
    input.value = "";
    msg.textContent = "Saved.";
  } catch (err) {
    msg.textContent =
      err.code === "offline" ? "Checking a name needs a connection." : err.message || "That did not go through. Try again in a moment.";
  } finally {
    $("saveNameBtn").disabled = false;
  }
}

export function openSettings() {
  $("nameMsg").textContent = "";
  $("settingsName").value = "";
  render();
  openModal("settingsModal");
}

export function initSettings() {
  $("nameForm").addEventListener("submit", onSaveName);
  $("clearNameBtn").addEventListener("click", () => {
    saveSettings({ name: null });
    $("nameMsg").textContent = "Name cleared.";
  });
  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    el.addEventListener("click", () => saveSettings({ [el.dataset.setting]: !getSettings()[el.dataset.setting] }));
  });
  const pick = (id, attr, clean) =>
    $(id).addEventListener("click", (e) => {
      const btn = e.target.closest(`[data-${attr}]`);
      if (btn) saveSettings({ [attr]: clean(btn.dataset[attr]) });
    });
  pick("difficultyToggle", "difficulty", cleanDifficulty);
  pick("packToggle", "pack", cleanPack);
  pick("turnToggle", "turn", cleanTurn);
  pick("limitToggle", "limit", cleanLimit);
  render();
}
