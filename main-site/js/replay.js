// Instant replay, and shareable replays.
//
// A replay is played back on the same board, one moment at a time: every
// card turned over, every match and miss, every turn that ran out. Play and
// pause, a step back or forward, a timeline to drag, and 0.5x to 4x, as
// Word Rain's replay; the speed picked last is remembered in this browser.
// Every score shown is worked out again from the log by js/rules.js.
//
// Sharing: online, the API stores the replay and the link is short,
// /r/<id>, as MRT Station Guesser's. Offline, or when the API will not
// take it, the link carries the whole game, as chess-game's links do.

import { api } from "./api.js";
import { advance, applyEntry, createGame, finalScores, liveScore, nextDeadline, tileLabel } from "./rules.js";
import { cleanReplay, longLink, readLongLink, setupOf, shortLink } from "./replay-format.js";
import { DOWN, MATCHED, UP } from "./board.js";
import { currentView, escapeHtml, formatTime, setIcon, shareLink, showView, store } from "./ui.js";

const SPEEDS = [0.5, 1, 2, 4];
const SPEED_STORAGE = "uwumemy.replaySpeed";
// How long each moment shows at 1x: its real gap, held to this range so a
// long think does not stall the replay and a quick pair is still seen.
const MIN_GAP_MS = 350;
const MAX_GAP_MS = 2200;

const $ = (id) => document.getElementById(id);

/* ---- building the moments ---- */

function describe(events, players) {
  const party = players.length > 1;
  const who = (p) => (party ? `${players[p]}: ` : "");
  const parts = [];
  for (const e of events) {
    if (e.type === "flip") parts.push(`${who(e.player)}turned over ${tileLabel(e.tile)}`);
    else if (e.type === "match") parts.push(`Match, +${e.points}${e.streak > 1 ? `, ${e.streak} in a row` : ""}`);
    else if (e.type === "miss") parts.push(e.slip ? "No match. Its pair had been seen already" : "No match");
    else if (e.type === "timeout") parts.push(`${who(e.player)}ran out of time for that turn`);
    else if (e.type === "leave") parts.push(`${players[e.player]} left`);
    else if (e.type === "join") parts.push(`${players[e.player]} came back`);
    else if (e.type === "over") parts.push(e.reason === "done" ? "Board cleared" : "Time is up");
  }
  const text = parts.join(". ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One moment per log entry, and one per timeout between them.
export function buildMoments(replay) {
  const setup = setupOf(replay);
  const state = createGame(setup);
  const moments = [];
  const snap = (events) => {
    const status = state.status.map((s) => (s === 2 ? MATCHED : DOWN));
    for (const i of state.up) status[i] = UP;
    const miss = events.find((e) => e.type === "miss");
    if (miss) for (const i of miss.cards) status[i] = UP;
    const match = events.find((e) => e.type === "match");
    moments.push({
      t: events.length ? events[events.length - 1].at : 0,
      status,
      current: state.current,
      scores: state.players.map((_, p) => liveScore(state, p)),
      pairs: state.players.map((p) => p.pairs),
      caption: describe(events, setup.players),
      pulse: match ? { cards: match.cards, kind: "match" } : miss ? { cards: miss.cards, kind: "miss" } : null,
      miss: Boolean(miss) || events.some((e) => e.type === "timeout" && e.card !== null),
    });
  };

  snap([]);
  moments[0].caption = "The board, dealt from the seed.";
  for (const entry of replay.log) {
    while (nextDeadline(state) <= entry[0]) snap(advance(state, nextDeadline(state)));
    const events = applyEntry(state, entry);
    // A log entry the rules refuse ends the replay there.
    if (!events) break;
    snap(events);
    if (state.phase !== "play") break;
  }
  while (state.phase === "play" && nextDeadline(state) < Infinity) snap(advance(state, nextDeadline(state)));
  return { state, moments };
}

/* ---- sharing ---- */

const links = new WeakMap(); // replay -> link already made

export async function replayLinkFor(replay, runId) {
  if (links.has(replay)) return links.get(replay);
  let link;
  try {
    const { id } = await api.createReplay(replay, runId);
    link = shortLink(location.origin, id);
  } catch {
    link = longLink(location.origin, replay);
  }
  links.set(replay, link);
  return link;
}

export async function shareReplay(replay, runId, label) {
  const original = label?.textContent;
  if (label) label.textContent = "Making link";
  const link = await replayLinkFor(replay, runId);
  const outcome = await shareLink(link, "Memory Game replay");
  if (label) {
    label.textContent = { shared: "Shared", copied: "Link copied", cancelled: original, failed: "Copy failed" }[outcome];
    setTimeout(() => (label.textContent = original), 2500);
  }
}

// The replay a page address asks for: { id } for a short link, a replay or
// { damaged: true } for a long one, or null.
export function replayFromLocation() {
  const short = location.pathname.match(/^\/r\/([A-Za-z0-9]{8})\/?$/);
  if (short) return { id: short[1] };
  return readLongLink(new URLSearchParams(location.search));
}

/* ---- the player ---- */

export class ReplayPlayer {
  constructor({ board, onPlaySeed, onClose }) {
    this.board = board;
    this.onPlaySeed = onPlaySeed;
    this.onClose = onClose;
    this.replay = null;
    this.moments = [];
    this.index = 0;
    this.timer = null;
    this.returnTo = "setup";
    const saved = Number(store.get(SPEED_STORAGE));
    this.speed = SPEEDS.includes(saved) ? saved : 1;
    this.syncSpeed();

    $("rpSpeed").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });
    $("rpBack").addEventListener("click", () => this.step(-1));
    $("rpForward").addEventListener("click", () => this.step(1));
    $("rpPlay").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("rpSeek").addEventListener("input", (e) => {
      this.pause();
      this.show(Number(e.target.value));
    });
    $("rpDone").addEventListener("click", () => this.close());
    $("rpShare").addEventListener("click", () => shareReplay(this.replay, this.runId, $("rpShareLabel")));
    $("rpSeed").addEventListener("click", () => this.onPlaySeed?.(this.replay.seed));
    document.addEventListener("keydown", (e) => {
      if (currentView() !== "replay" || document.body.classList.contains("modal-open")) return;
      if (e.target.closest("input, textarea, .mcard")) return;
      if (e.key === " ") this.timer ? this.pause() : this.play();
      else if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else if (e.key === "Escape") this.close();
      else return;
      e.preventDefault();
    });
    document.addEventListener("memy:view", (e) => {
      if (e.detail !== "replay") this.pause();
    });
  }

  // Opens a replay: from a game just played (`own`), or from a link.
  // A link by id is fetched first.
  async open(source, { own = false, runId = null, verified = null, autoplay = true } = {}) {
    if (currentView() !== "replay") this.returnTo = currentView();
    this.pause();
    showView("replay");
    $("rpStage").append(this.board.host);
    this.board.onFlip = null;
    $("rpMeta").textContent = "Loading the replay.";
    $("rpTrust").textContent = "";
    $("rpCaption").textContent = "";
    $("rpSummary").innerHTML = "";

    let replay = source;
    try {
      if (source?.id) {
        const r = await api.replay(source.id);
        replay = cleanReplay(r.replay);
        verified = r.verified === true;
        if (replay) links.set(replay, shortLink(location.origin, r.id));
      }
    } catch (err) {
      $("rpMeta").textContent =
        err.code === "offline"
          ? "This replay link needs a connection to open."
          : err.code === "replay_not_found"
            ? "There is no replay at that link."
            : "The replay did not load. Try again in a moment.";
      return;
    }
    if (!replay || replay.damaged) {
      $("rpMeta").textContent = "That replay link is damaged or incomplete, so it cannot be played back.";
      return;
    }

    this.replay = replay;
    this.runId = runId;
    const { state, moments } = buildMoments(replay);
    this.moments = moments;
    this.final = state;
    const party = replay.players.length > 1;

    $("rpMeta").textContent = `${party ? `${replay.players.join(", ")}. ` : own ? "Your game. " : `${replay.players[0]}'s game. `}Seed ${replay.seed}.`;
    $("rpTrust").textContent = own
      ? ""
      : verified === true
        ? "Checked by the server."
        : "Not checked by the server: scores are worked out from the moves in the link.";
    $("rpSeed").hidden = own;
    $("rpSeek").max = String(moments.length - 1);
    $("rpMarks").innerHTML = moments
      .map((m, i) => (m.miss ? `<span style="left:${(i / Math.max(1, moments.length - 1)) * 100}%"></span>` : ""))
      .join("");

    this.board.setup({ count: state.cards.length, cols: state.cols, rows: state.rows, tiles: state.cards });
    this.tiles = state.cards;
    this.showSummary(false);
    if (autoplay && moments.length > 1) {
      this.show(0);
      this.timer = setTimeout(() => this.play(), 600);
      this.syncPlayButton(true);
    } else {
      this.show(autoplay ? 0 : moments.length - 1);
    }
  }

  showSummary(visible) {
    const box = $("rpSummary");
    if (!visible) {
      box.innerHTML = "";
      return;
    }
    const results = finalScores(this.final);
    const best = Math.max(...results.map((r) => r.score));
    box.innerHTML = `<ol class="standings">${results
      .map(
        (r) =>
          `<li${results.length > 1 && r.score === best ? ' class="lead"' : ""}><span>${escapeHtml(r.name)}</span><span>${r.score} points, ${r.pairs} pairs</span></li>`
      )
      .join("")}</ol>`;
  }

  show(i) {
    const m = this.moments[i];
    if (!m) return;
    this.index = i;
    this.board.render({ tiles: this.tiles, status: m.status, interactive: false });
    $("rpSeek").value = String(i);
    $("rpCaption").textContent = m.caption;
    $("rpTime").textContent = `${formatTime(m.t)} · ${i} of ${this.moments.length - 1}`;
    const party = this.replay.players.length > 1;
    $("rpScore").textContent = party
      ? this.replay.players.map((n, p) => `${n} ${m.scores[p]}`).join(" · ")
      : `Score ${m.scores[0]} · Pairs ${m.pairs[0]}`;
    $("rpBack").disabled = i === 0;
    $("rpForward").disabled = i === this.moments.length - 1;
    this.showSummary(i === this.moments.length - 1);
  }

  step(delta, fromTimer = false) {
    if (!fromTimer) this.pause();
    const next = this.index + delta;
    if (next < 0 || next >= this.moments.length) return false;
    this.show(next);
    const m = this.moments[next];
    if (delta > 0 && m.pulse) this.board.pulse(m.pulse.cards, m.pulse.kind);
    return true;
  }

  gapAfter(i) {
    const a = this.moments[i];
    const b = this.moments[i + 1];
    const real = b ? b.t - a.t : MIN_GAP_MS;
    return Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, real)) / this.speed;
  }

  play() {
    clearTimeout(this.timer);
    // Played to the end already: start over.
    if (this.index >= this.moments.length - 1) this.show(0);
    this.syncPlayButton(true);
    const tick = () => {
      if (!this.step(1, true) || this.index >= this.moments.length - 1) {
        this.pause();
        return;
      }
      this.timer = setTimeout(tick, this.gapAfter(this.index));
    };
    this.ticking = tick;
    this.timer = setTimeout(tick, this.gapAfter(this.index));
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ticking = null;
    this.syncPlayButton(false);
  }

  // A replay that is playing picks the new pace up from its next moment.
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store.set(SPEED_STORAGE, String(speed));
    this.syncSpeed();
    if (this.timer && this.ticking) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.ticking, this.gapAfter(this.index));
    }
  }

  syncSpeed() {
    document.querySelectorAll("#rpSpeed [data-speed]").forEach((el) => {
      const on = Number(el.dataset.speed) === this.speed;
      el.classList.toggle("active", on);
      el.setAttribute("aria-checked", String(on));
    });
  }

  syncPlayButton(playing) {
    const btn = $("rpPlay");
    btn.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    setIcon(btn, playing ? "pause" : "play");
  }

  close() {
    this.pause();
    // Off the address, so a reload does not open it again.
    if (location.pathname !== "/" || location.search) history.replaceState(null, "", "/");
    this.onClose?.(this.returnTo === "replay" ? "setup" : this.returnTo);
  }
}
