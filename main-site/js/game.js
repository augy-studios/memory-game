// The solo game: starting one, playing it, and its result.
//
// Starting asks /api/run/start for a run, which deals the seed and starts
// the server's clock, so the game can go on the leaderboard. Offline, or on
// a pasted seed, the game is dealt here and plays the same, unscored.
//
// The clock is the game's own: it stops while paused or while the tab is
// out of sight, and every move is logged in its milliseconds. The rules
// (js/rules.js) turn that log into the board, the turns and the score, the
// same way the server will.

import { api } from "./api.js";
import { getSettings, saveSettings } from "./settings.js";
import {
  DIFFICULTIES,
  GAME_LIMIT_LABELS,
  PACKS,
  advance,
  cleanLimit,
  cleanTurn,
  createGame,
  finalScores,
  flip,
  liveScore,
  tileLabel,
} from "./rules.js";
import { newSeed, parseSeed } from "./seed.js";
import { DOWN, MATCHED, UP } from "./board.js";
import { replayLinkFor, shareReplay } from "./replay.js";
import { REPLAY_VERSION } from "./replay-format.js";
import { copyText, currentView, escapeHtml, formatTime, setIcon, showView, store } from "./ui.js";

const SAVE_KEY = "uwumemy.game";
// How long a missed pair stays face up, unless the next card is turned first.
const SHOW_MISS_MS = 900;

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;

let g = null; // the game in play: { state, log, run, pasted, at, elapsed }
let last = null; // the game just finished, for its result, replay and submit
let running = false;
let clockFrom = 0; // performance.now() when the clock last started
let showing = null; // { cards, until } a missed pair still face up
let ticker = null;
let endArmed = 0;

const now = () => (running ? g.elapsed + (performance.now() - clockFrom) : g.elapsed);
const gameTime = () => Math.round(now());

/* ---- the setup card ---- */

function renderSetup() {
  const s = getSettings();
  const d = DIFFICULTIES[s.difficulty];
  const bits = [
    `${d.label}, ${d.cols} by ${d.rows}`,
    `${PACKS[s.pack].label} pictures`,
    s.turn ? `${s.turn} s turns` : "untimed turns",
    s.limit ? `${GAME_LIMIT_LABELS[s.limit].toLowerCase()} game clock` : "no game clock",
    s.view === "3d" ? "3D view" : "flat view",
  ];
  $("setupSummary").textContent = `${bits.join(", ")}.`;
  $("resumeBtn").hidden = !store.get(SAVE_KEY);
}

/* ---- starting ---- */

async function start({ seedText = null } = {}) {
  const s = getSettings();
  $("startBtn").disabled = true;
  $("startNote").textContent = "";
  let seed = null;
  let run = null;
  let pasted = false;

  if (seedText) {
    seed = parseSeed(seedText, s);
    pasted = true;
  } else {
    $("startNote").textContent = "Dealing.";
    try {
      const r = await api.startRun({ difficulty: s.difficulty, pack: s.pack, turn: s.turn, limit: s.limit });
      seed = parseSeed(r.seed);
      if (seed) run = { id: r.run_id };
    } catch {
      // Offline or refused: dealt here, unscored.
    }
    seed ??= newSeed(s.difficulty, s.pack);
  }
  $("startBtn").disabled = false;
  $("startNote").textContent = "";
  begin({ seed: seed.text, turn: s.turn, limit: s.limit, run, pasted, at: new Date().toISOString(), log: [], elapsed: 0 });
}

// Sets a game up from its saved form, new or resumed.
function begin(saved, { paused = false } = {}) {
  const seed = parseSeed(saved.seed);
  const setup = { seed, turn: cleanTurn(saved.turn), limit: cleanLimit(saved.limit), players: [getSettings().name ?? "Player"] };
  const state = createGame(setup);
  for (const [t, card] of saved.log) flip(state, card, t);
  g = { state, log: [...saved.log], run: saved.run, pasted: saved.pasted, at: saved.at, elapsed: saved.elapsed };
  last = null;
  showing = null;
  endArmed = 0;

  showView("play");
  $("playStage").append(board.host);
  board.onFlip = onFlip;
  board.setup({ count: state.cards.length, cols: state.cols, rows: state.rows, tiles: state.cards });
  $("seedChip").textContent = seed.text;
  $("scoredChip").textContent = g.run ? "Scored" : g.pasted ? "Pasted seed, not scored" : "Offline, not scored";
  $("scoredChip").classList.toggle("muted", !g.run);
  $("turnBar").hidden = !state.turnMs;
  $("caption").textContent = paused ? "" : "Find the pairs.";
  save();
  draw();
  if (paused) pause();
  else resume();
  if (!paused) board.focus();
}

/* ---- playing ---- */

function displayStatus() {
  const { state } = g;
  const status = state.status.map((s) => (s === 2 ? MATCHED : DOWN));
  for (const i of state.up) status[i] = UP;
  if (showing) for (const i of showing.cards) if (status[i] === DOWN) status[i] = UP;
  return status;
}

function draw() {
  if (!g) return;
  const { state } = g;
  board.render({ tiles: state.cards, status: displayStatus(), interactive: running && state.phase === "play" });
  const p = state.players[0];
  $("hudScore").textContent = String(liveScore(state));
  $("hudPairs").textContent = `${p.pairs}/${state.pairs}`;
  $("hudTurns").textContent = String(p.turns);
  $("hudStreak").textContent = p.streak > 1 ? `${p.streak} in a row` : "";
  drawClock();
}

function drawClock() {
  const { state } = g;
  const t = now();
  $("hudTime").textContent = state.gameMs ? formatTime(Math.max(0, state.gameMs - t) + 999) : formatTime(t);
  $("hudTimeLabel").textContent = state.gameMs ? "Left" : "Time";
  if (state.turnMs && state.phase === "play") {
    const left = Math.max(0, state.turnStart + state.turnMs - t);
    $("turnFill").style.transform = `scaleX(${left / state.turnMs})`;
    $("turnBar").classList.toggle("low", left < 1500);
  }
}

function onFlip(card) {
  if (!g || !running || g.state.phase !== "play") return;
  const t = gameTime();
  const events = flip(g.state, card, t);
  if (!events) return;
  g.log.push([t, card]);
  showing = null;
  handle(events);
  save();
}

function handle(events) {
  for (const e of events) {
    if (e.type === "match") {
      board.pulse(e.cards, "match");
      say(`Match: ${tileLabel(e.tile)}, +${e.points}${e.streak > 1 ? `, ${e.streak} in a row` : ""}.`);
      popScore(e.points);
    } else if (e.type === "miss") {
      showing = { cards: e.cards, until: performance.now() + SHOW_MISS_MS };
      board.pulse(e.cards, "miss");
      say(e.slip ? "No match. Its pair had been seen already." : "No match.");
    } else if (e.type === "timeout") {
      say("Turn ran out.");
    } else if (e.type === "flip") {
      say(`${tileLabel(e.tile)}.`);
    }
  }
  draw();
  if (g.state.phase === "over") finish();
}

function say(text) {
  $("caption").textContent = text;
}

// The points a match earned, floating up from the score.
function popScore(points) {
  const pop = document.createElement("span");
  pop.className = "score-pop";
  pop.textContent = `+${points}`;
  pop.setAttribute("aria-hidden", "true");
  $("hudScoreBox").append(pop);
  setTimeout(() => pop.remove(), 900);
}

function tick() {
  if (!g || g.state.phase !== "play") return;
  if (running) {
    const events = advance(g.state, gameTime());
    if (events.length) {
      handle(events);
      save();
    }
  }
  if (showing && performance.now() >= showing.until) {
    showing = null;
    draw();
  }
  drawClock();
}

function resume() {
  if (!g || g.state.phase !== "play") return;
  if (!running) {
    running = true;
    clockFrom = performance.now();
  }
  $("playStage").classList.remove("paused");
  $("pauseOverlay").hidden = true;
  setIcon($("pauseBtn"), "pause");
  $("pauseBtn").setAttribute("aria-label", "Pause");
  clearInterval(ticker);
  ticker = setInterval(tick, 100);
  draw();
}

// Stops the clock and hides the board, so a pause cannot be used to study it.
export function pause() {
  if (!g || g.state.phase !== "play") return;
  if (running) {
    g.elapsed = now();
    running = false;
  }
  clearInterval(ticker);
  $("playStage").classList.add("paused");
  $("pauseOverlay").hidden = false;
  setIcon($("pauseBtn"), "play");
  $("pauseBtn").setAttribute("aria-label", "Resume");
  save();
  draw();
}

export const isPlaying = () => Boolean(g && running && g.state.phase === "play" && currentView() === "play");

// Kept after every move, so a reload comes back to the game, paused.
function save() {
  if (!g || g.state.phase !== "play") return;
  const s = g.state.setup;
  store.set(
    SAVE_KEY,
    JSON.stringify({ seed: s.seed.text, turn: s.turn, limit: s.limit, run: g.run, pasted: g.pasted, at: g.at, log: g.log, elapsed: Math.round(now()) })
  );
}

function endGame() {
  // Two taps, so a stray one does not throw a game away.
  if (Date.now() - endArmed > 3000) {
    endArmed = Date.now();
    $("endLabel").textContent = "Tap again to end";
    setTimeout(() => ($("endLabel").textContent = "End game"), 3000);
    return;
  }
  clearInterval(ticker);
  running = false;
  g = null;
  store.remove(SAVE_KEY);
  $("endLabel").textContent = "End game";
  toSetup();
}

export function toSetup() {
  renderSetup();
  showView("setup");
}

/* ---- the result ---- */

function replayOf(game) {
  const s = game.state.setup;
  return {
    v: REPLAY_VERSION,
    kind: "solo",
    seed: s.seed.text,
    turn: s.turn,
    limit: s.limit,
    players: [getSettings().name ?? "Player"],
    log: game.log,
    at: game.at,
  };
}

function finish() {
  clearInterval(ticker);
  running = false;
  store.remove(SAVE_KEY);
  showing = null;
  // The finished board, no longer playable, for a moment before the result.
  draw();
  const game = g;
  const [r] = finalScores(game.state);
  last = { ...game, result: r, replay: replayOf(game), submitted: false };
  g = null;
  setTimeout(() => showResult(), 900);
}

function showResult() {
  if (!last) return;
  const { state, result: r } = last;
  showView("result");
  $("resultTitle").textContent = state.reason === "done" ? "Board cleared" : "Time is up";
  $("resultScore").textContent = String(r.score);
  $("resultStats").innerHTML = [
    ["Pairs", `${r.pairs} of ${state.pairs}`],
    ["Turns", r.turns],
    ["Time", formatTime(state.endedAt)],
    ["Slips", r.slips],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join("");
  $("resultBreakdown").innerHTML = [
    ["Matches", `${r.points} points`],
    r.completion ? ["Few turns bonus", `+${r.completion}`] : null,
    r.timeBonus ? ["Time to spare", `+${r.timeBonus}%`] : null,
    ["Difficulty", `${r.difficulty}%`],
    r.turn !== 100 ? ["Turn limit", `${r.turn}%`] : null,
    r.game !== 100 ? ["Game clock", `${r.game}%`] : null,
  ]
    .filter(Boolean)
    .map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`)
    .join("");
  document.querySelectorAll("#result .seed-code").forEach((el) => (el.textContent = state.setup.seed.text));

  const s = getSettings();
  $("nameInput").value = s.name ?? "";
  $("submitMsg").textContent = "";
  $("submitForm").hidden = !last.run;
  $("submitted").hidden = true;
  $("submitUnavailable").hidden = Boolean(last.run);
  $("submitUnavailable").textContent = last.pasted
    ? "Games on a pasted seed are not scored: the board could have been known in advance."
    : "This game started offline, so it is not scored. It plays the same.";
  $("shareLabel").textContent = "Share replay";

  if (last.run && s.auto_submit && s.name) submit(s.name);
  if (s.auto_replay) replayer.open(last.replay, { own: true, runId: last.run?.id });
  else $("playAgainBtn").focus();
  // Made now, while the run is fresh, so Share is instant later.
  if (last.run) replayLinkFor(last.replay, last.run.id).catch(() => {});
}

async function submit(name) {
  if (!last?.run || last.submitted) return;
  $("submitBtn").disabled = true;
  $("submitMsg").textContent = "Adding.";
  try {
    const res = await api.submit(last.run.id, name, last.log, last.state.endedAt);
    last.submitted = true;
    saveSettings({ name: res.name });
    $("submitForm").hidden = true;
    $("submitted").hidden = false;
    $("submittedText").textContent = `Added as ${res.name}: ${res.score} points. Best ${res.best_score}, rank ${res.rank}. Total ${res.total} over ${res.games} games, rank ${res.total_rank}.`;
  } catch (err) {
    $("submitMsg").textContent =
      err.code === "offline" ? "Adding a game needs a connection. Try again once you are back online." : err.message || "That did not go through.";
  } finally {
    $("submitBtn").disabled = false;
  }
}

/* ---- seeds ---- */

function wireSeedForms() {
  document.querySelectorAll(".seed-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector(".seed-input");
      const msg = form.querySelector(".seed-msg");
      const seed = parseSeed(input.value, getSettings());
      if (!seed) {
        msg.textContent = "That is not a seed. A seed looks like NM-BXK4-M9TR.";
        input.focus();
        return;
      }
      msg.textContent = "";
      input.value = "";
      start({ seedText: seed.text });
    });
  });
  document.querySelectorAll("[data-copy-seed]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.closest(".seed-line").querySelector(".seed-code").textContent;
      const label = btn.querySelector(".copy-label");
      label.textContent = (await copyText(text)) ? "Copied" : "Copy failed";
      setTimeout(() => (label.textContent = "Copy"), 2000);
    });
  });
}

export function playSeed(text) {
  start({ seedText: text });
}

export function initGame({ board: b, replayer: r }) {
  board = b;
  replayer = r;
  $("startBtn").addEventListener("click", () => start());
  $("resumeBtn").addEventListener("click", () => {
    try {
      const saved = JSON.parse(store.get(SAVE_KEY));
      if (!parseSeed(saved?.seed) || !Array.isArray(saved.log)) throw new Error("bad save");
      begin(saved, { paused: true });
    } catch {
      store.remove(SAVE_KEY);
      renderSetup();
    }
  });
  $("pauseBtn").addEventListener("click", () => (running ? pause() : resume()));
  $("continueBtn").addEventListener("click", resume);
  $("endBtn").addEventListener("click", endGame);
  $("playAgainBtn").addEventListener("click", () => start());
  $("sameSeedBtn").addEventListener("click", () => last && start({ seedText: last.state.setup.seed.text }));
  $("replayBtn").addEventListener("click", () => last && replayer.open(last.replay, { own: true, runId: last.run?.id }));
  $("shareBtn").addEventListener("click", () => last && shareReplay(last.replay, last.run?.id, $("shareLabel")));
  $("submitForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("nameInput").value.trim();
    if (!name) {
      $("submitMsg").textContent = "Enter a name.";
      $("nameInput").focus();
      return;
    }
    submit(name);
  });
  wireSeedForms();

  // Out of sight, the clock stops: a game in a background tab is paused.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isPlaying()) pause();
  });
  document.addEventListener("memy:view", (e) => {
    if (e.detail !== "play" && g && running) pause();
  });
  document.addEventListener("memy:settings", () => {
    if (currentView() === "setup") renderSetup();
  });
  document.addEventListener("keydown", (e) => {
    if (currentView() !== "play" || document.body.classList.contains("modal-open")) return;
    if ((e.key === "p" || e.key === "P") && !e.target.closest("input, textarea")) {
      e.preventDefault();
      running ? pause() : resume();
    }
  });
  renderSetup();
}

// Back from a replay to the result it came from.
export function backToResult() {
  if (last) {
    showView("result");
    return true;
  }
  return false;
}
