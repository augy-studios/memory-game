// Party games: two to four players, each on their own device, on the same
// network. One device hosts and shows a code, a link and a QR code; the
// others join with any of them. Players take turns; a match keeps the turn.
//
// Pairing is js/p2p.js, STUN only, per STUN-p2p-spec.md at the repo root,
// the way uwuPromptr's remote pairs: PeerJS's public broker introduces the
// devices, then they talk directly. So they have to be on the same wifi, or
// one on a hotspot from the other.
//
// The host is authoritative. Its device runs the game with js/rules.js and
// sends each guest a full snapshot on every change and 20 times a second.
// A snapshot shows only the pictures on face-up cards, and the seed only
// once the game is over, so a guest cannot read the board out of it. Guests
// send which card they picked, and the host applies it if it is their turn.
//
// Party scores never go on the leaderboard: the host holds the board.

import { CODE_LENGTH, Guest, Host, PROTOCOL_VERSION, generateCode, isValidCode, normaliseCode } from "./p2p.js";
import { qrToSvg } from "./qr.js";
import {
  ALL_TILES,
  DIFFICULTIES,
  JOIN,
  LEAVE,
  PACKS,
  TURN_LIMITS,
  advance,
  applyEntry,
  cleanDifficulty,
  cleanPack,
  cleanTurn,
  createGame,
  finalScores,
  flip,
  liveScore,
  tileLabel,
} from "./rules.js";
import { newSeed, parseSeed } from "./seed.js";
import { DOWN, MATCHED, UP } from "./board.js";
import { REPLAY_VERSION, cleanReplay, cleanText } from "./replay-format.js";
import { shareReplay } from "./replay.js";
import { getSettings } from "./settings.js";
import { copyText, currentView, escapeHtml, showView, store } from "./ui.js";

const MAX_PLAYERS = 4;
const SHOW_MISS_MS = 900;
const HOST_CODE_KEY = "uwumemy.hostCode";
const LAST_CODE_KEY = "uwumemy.lastCode";
const CLIENT_ID_KEY = "uwumemy.clientId";
// The host's game, in this tab only: a reload carries on with it.
const PARTY_KEY = "uwumemy.party";
const STALE_MS = 2000;
const SILENT_GUEST_MS = 6000;

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;
let role = null; // "host", "guest" or null

/* ---- shared ---- */

function clientId() {
  let id = store.get(CLIENT_ID_KEY);
  if (!/^[A-Za-z0-9]{12}$/.test(id ?? "")) {
    const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => abc[b % abc.length]).join("");
    store.set(CLIENT_ID_KEY, id);
  }
  return id;
}

const joinLink = (code) => `${location.origin}/join?id=${code}`;

const STATUS_TEXT = {
  idle: "",
  connecting: "Connecting.",
  waiting: "Waiting for players. Everyone has to be on the same wifi, or on a hotspot from this device.",
  connected: "Connected.",
  dropped: "The connection dropped. Reconnecting.",
  unreachable:
    "Could not reach the other device. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.",
};

function renderStatus(detail) {
  $("partyStatus").textContent = detail.status === "error" ? detail.message : STATUS_TEXT[detail.status] ?? "";
  $("partyStatus").classList.toggle("error", detail.status === "error" || detail.status === "unreachable");
  if (detail.status === "connected" || detail.status === "waiting") wakeLock(true);
  if (detail.status === "idle") wakeLock(false);
}

// Keeps the screen on while in a party: a phone that sleeps drops out.
let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && document.visibilityState === "visible") {
      lock = await navigator.wakeLock?.request("screen");
      lock?.addEventListener?.("release", () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    lock = null;
  }
}

function showPanel(name) {
  for (const p of ["partyChoose", "partyLobby", "partyGame", "partyOver"]) $(p).hidden = p !== name;
}

/* ---- drawing a snapshot, on both ends ---- */

let drawn = { game: -1, pulse: -1, sig: "" };

// Draws only while the party is on screen: a snapshot arriving while
// somebody watches the replay must not pull them away from it.
function renderParty(snap) {
  if (snap.phase === "over") lastReplay = snap.replay ? cleanReplay(snap.replay) : null;
  if (currentView() !== "party") return;
  const host = role === "host";
  document.querySelectorAll("#party .host-only").forEach((el) => (el.hidden = !host));
  document.querySelectorAll("#party .guest-only").forEach((el) => (el.hidden = host));

  const players = snap.players
    .map((p, i) => {
      const bits = [];
      if (i === snap.you) bits.push("you");
      if (i === 0) bits.push("host");
      if (!p.connected) bits.push("away");
      const turn = snap.phase === "game" && i === snap.current;
      return `<li class="${turn ? "turn" : ""}${p.connected ? "" : " away"}"><span class="pl-name">${escapeHtml(p.name)}${
        bits.length ? ` <small>(${bits.join(", ")})</small>` : ""
      }</span><span class="pl-score">${snap.phase === "lobby" ? "" : `${p.score} · ${p.pairs} pairs`}</span></li>`;
    })
    .join("");

  if (snap.phase === "lobby") {
    showPanel("partyLobby");
    $("lobbyPlayers").innerHTML = players;
    $("lobbyCount").textContent = `${snap.players.length} of ${MAX_PLAYERS} players`;
    const o = snap.options;
    const press = (id, attr, value) =>
      document.querySelectorAll(`#${id} [data-${attr}]`).forEach((el) => {
        const on = el.dataset[attr] === String(value);
        el.classList.toggle("active", on);
        el.setAttribute("aria-pressed", String(on));
        el.disabled = !host;
      });
    press("pDifficulty", "difficulty", o.difficulty);
    press("pPack", "pack", o.pack);
    press("pTurn", "turn", o.turn);
    const d = DIFFICULTIES[o.difficulty];
    $("lobbySummary").textContent = `${d.label}, ${d.cols} by ${d.rows}, ${PACKS[o.pack].label} pictures, ${o.turn ? `${o.turn} s turns` : "untimed turns"}.`;
    $("partyStartBtn").disabled = snap.players.length < 2;
    $("partyStartNote").textContent = snap.players.length < 2 ? "Waiting for at least one more player." : "";
    return;
  }

  if (snap.phase === "game") {
    showPanel("partyGame");
    // The board is shared with the solo game and the replay: taken back, it
    // is set up again for this game.
    const remount = $("partyStage") !== board.host.parentElement;
    if (remount) $("partyStage").append(board.host);
    board.onFlip = onBoardFlip;
    if (remount || drawn.game !== snap.game) {
      board.setup({ count: snap.shape.count, cols: snap.shape.cols, rows: snap.shape.rows, pack: snap.options.pack });
      drawn = { game: snap.game, pulse: snap.pulse?.n ?? -1, sig: "" };
    }
    const tiles = snap.status.map((_, i) => snap.faces[i] ?? null);
    const mine = snap.current === snap.you;
    const sig = `${snap.status.join("")}|${mine}`;
    if (sig !== drawn.sig) {
      board.render({ tiles, status: snap.status, interactive: mine });
      drawn.sig = sig;
    }
    if (snap.pulse && snap.pulse.n !== drawn.pulse) {
      drawn.pulse = snap.pulse.n;
      board.pulse(snap.pulse.cards, snap.pulse.kind);
    }
    $("partyPlayers").innerHTML = players;
    $("partyTurn").textContent = mine ? "Your turn." : `${snap.players[snap.current]?.name ?? ""}'s turn.`;
    $("partyTurn").classList.toggle("mine", mine);
    $("partyCaption").textContent = snap.caption;
    $("partyTurnBar").hidden = !snap.turnMs;
    if (snap.turnMs) {
      $("partyTurnFill").style.transform = `scaleX(${Math.max(0, Math.min(1, snap.turnLeft / snap.turnMs))})`;
      $("partyTurnBar").classList.toggle("low", snap.turnLeft < 1500);
    }
    return;
  }

  showPanel("partyOver");
  const results = snap.results ?? [];
  const best = Math.max(0, ...results.map((r) => r.score));
  $("partyStandings").innerHTML = results
    .map((r, i) => `<li class="${r.score === best ? "lead" : ""}"><span>${escapeHtml(r.name)}${i === snap.you ? " <small>(you)</small>" : ""}</span><span>${r.score} points, ${r.pairs} pairs</span></li>`)
    .join("");
  const winners = results.filter((r) => r.score === best).map((r) => r.name);
  $("partyOverTitle").textContent = winners.length > 1 ? "A draw" : `${winners[0] ?? "Nobody"} wins`;
  $("partySeed").textContent = snap.replay?.seed ?? "";
}

let lastReplay = null;

function onBoardFlip(card) {
  if (role === "host") hostFlip(0, card);
  else if (role === "guest") guest?.send({ type: "flip", card });
}

/* ---- host ---- */

let hostConn = null;
let H = null; // the host's party
let retriedTaken = false;
let hostTimers = [];

function freshParty() {
  const s = getSettings();
  return {
    code: null,
    seats: [{ cid: clientId(), name: s.name ?? "Host", peer: null, connected: true, heard: 0 }],
    options: { difficulty: s.difficulty, pack: s.pack, turn: s.turn || 10 },
    phase: "lobby",
    game: null, // { setup, state, log, startEpoch, at }
    count: 0,
    showing: null,
    pulse: null,
    caption: "",
    replay: null,
  };
}

function saveParty() {
  if (!H) return;
  const g = H.game;
  const data = {
    code: H.code,
    seats: H.seats.map((s) => ({ cid: s.cid, name: s.name })),
    options: H.options,
    phase: H.phase,
    count: H.count,
    game: g && { seed: g.setup.seed.text, turn: g.setup.turn, limit: g.setup.limit, players: g.setup.players, log: g.log, startEpoch: g.startEpoch, at: g.at },
    replay: H.replay,
  };
  try {
    sessionStorage.setItem(PARTY_KEY, JSON.stringify(data));
  } catch {
    // Not kept across a reload.
  }
}

function loadParty() {
  try {
    const data = JSON.parse(sessionStorage.getItem(PARTY_KEY) ?? "null");
    if (!data || !isValidCode(data.code) || !Array.isArray(data.seats) || !data.seats.length) return null;
    const party = freshParty();
    party.code = data.code;
    party.seats = data.seats.slice(0, MAX_PLAYERS).map((s, i) => ({ cid: String(s.cid), name: cleanText(s.name, 20) || `Player ${i + 1}`, peer: null, connected: i === 0, heard: 0 }));
    party.options = { difficulty: cleanDifficulty(data.options?.difficulty), pack: cleanPack(data.options?.pack), turn: cleanTurn(data.options?.turn) };
    party.count = Number(data.count) || 0;
    party.replay = data.replay ? cleanReplay(data.replay) : null;
    const seed = data.game ? parseSeed(data.game.seed) : null;
    party.phase = seed && (data.phase === "game" || (data.phase === "over" && party.replay)) ? data.phase : "lobby";
    if (party.phase !== "lobby") {
      const setup = { seed, turn: cleanTurn(data.game.turn), limit: 0, players: party.seats.map((s) => s.name) };
      const state = createGame(setup);
      const log = Array.isArray(data.game.log) ? data.game.log : [];
      for (const entry of log) applyEntry(state, entry);
      party.game = { setup, state, log, startEpoch: Number(data.game.startEpoch), at: data.game.at };
      // Guests are away until they reconnect, so their turns are skipped.
      const t = Date.now() - party.game.startEpoch;
      if (party.phase === "game") {
        party.seats.forEach((_, i) => {
          if (i > 0 && state.players[i].active) logEntry(party, [t, LEAVE, i]);
        });
      }
    }
    return party;
  } catch {
    return null;
  }
}

function logEntry(party, entry) {
  const events = applyEntry(party.game.state, entry) ?? [];
  party.game.log.push(entry);
  return events;
}

const gameTime = () => Date.now() - H.game.startEpoch;

function displayStatus() {
  const state = H.game?.state;
  if (!state) return [];
  const status = state.status.map((s) => (s === 2 ? MATCHED : DOWN));
  for (const i of state.up) status[i] = UP;
  if (H.showing && performance.now() < H.showing.until) for (const i of H.showing.cards) if (status[i] === DOWN) status[i] = UP;
  return status;
}

function snapshot(you) {
  const state = H.game?.state;
  const status = displayStatus();
  const faces = {};
  status.forEach((s, i) => {
    if (s !== DOWN) faces[i] = state.cards[i];
  });
  const t = state ? gameTime() : 0;
  return {
    type: "state",
    v: PROTOCOL_VERSION,
    phase: H.phase,
    game: H.count,
    you,
    players: H.seats.map((s, i) => ({
      name: s.name,
      connected: s.connected,
      score: state ? liveScore(state, i) : 0,
      pairs: state ? state.players[i]?.pairs ?? 0 : 0,
    })),
    options: H.options,
    shape: state ? { count: state.cards.length, cols: state.cols, rows: state.rows } : null,
    current: state ? state.current : -1,
    status,
    faces,
    turnMs: state?.turnMs ?? 0,
    turnLeft: state?.turnMs ? Math.max(0, state.turnStart + state.turnMs - t) : 0,
    caption: H.caption,
    pulse: H.pulse,
    results: H.phase === "over" && H.game ? finalScores(H.game.state) : null,
    replay: H.phase === "over" ? H.replay : null,
  };
}

function broadcast() {
  if (!H) return;
  if (role === "host") renderParty(snapshot(0));
  H.seats.forEach((s, i) => {
    if (i > 0 && s.peer) hostConn?.send(snapshot(i), s.peer);
  });
}

function handleEvents(events) {
  const names = H.seats.map((s) => s.name);
  for (const e of events) {
    if (e.type === "flip") H.caption = `${names[e.player]} turned over ${tileLabel(e.tile)}.`;
    else if (e.type === "match") {
      H.caption = `${names[e.player]} found a pair: +${e.points}.`;
      H.pulse = { n: (H.pulse?.n ?? 0) + 1, cards: e.cards, kind: "match" };
    } else if (e.type === "miss") {
      H.caption = `${names[e.player]} missed.`;
      H.showing = { cards: e.cards, until: performance.now() + SHOW_MISS_MS };
      H.pulse = { n: (H.pulse?.n ?? 0) + 1, cards: e.cards, kind: "miss" };
    } else if (e.type === "timeout") H.caption = `${names[e.player]} ran out of time.`;
    else if (e.type === "over") {
      H.phase = "over";
      const g = H.game;
      H.replay = {
        v: REPLAY_VERSION,
        kind: "party",
        seed: g.setup.seed.text,
        turn: g.setup.turn,
        limit: 0,
        players: g.setup.players,
        log: g.log,
        at: g.at,
      };
    }
  }
  saveParty();
  broadcast();
}

function hostFlip(p, card) {
  const g = H?.game;
  if (H?.phase !== "game" || g.state.current !== p) return;
  const t = gameTime();
  const events = flip(g.state, card, t);
  if (!events) return;
  g.log.push([t, card]);
  H.showing = null;
  handleEvents(events);
}

function hostTick() {
  if (!H) return;
  const now = Date.now();
  // Guests heard from nothing for a while have gone, whatever PeerJS says.
  H.seats.forEach((s, i) => {
    if (i > 0 && s.peer && s.heard && now - s.heard > SILENT_GUEST_MS) {
      const link = hostConn?.links.get(s.peer);
      if (link) hostConn.drop(link);
      guestGone(s.peer);
    }
  });
  if (H.phase === "game") {
    const events = advance(H.game.state, gameTime());
    if (events.length) handleEvents(events);
  }
}

function seatOf(peer) {
  return H.seats.findIndex((s, i) => i > 0 && s.peer === peer);
}

function guestJoined(peer, metadata) {
  const cid = typeof metadata?.cid === "string" ? metadata.cid.slice(0, 32) : "";
  const name = cleanText(metadata?.name, 20);
  let i = cid ? H.seats.findIndex((s, j) => j > 0 && s.cid === cid) : -1;
  if (i > 0) {
    H.seats[i].peer = peer;
    H.seats[i].connected = true;
    H.seats[i].heard = Date.now();
    if (H.phase === "game") handleEvents(logEntry(H, [gameTime(), JOIN, i]));
  } else if (H.phase === "lobby" && H.seats.length < MAX_PLAYERS) {
    H.seats.push({ cid, name: name || `Player ${H.seats.length + 1}`, peer, connected: true, heard: Date.now() });
    i = H.seats.length - 1;
  } else {
    hostConn.send({ type: H.phase === "lobby" ? "full" : "started" }, peer);
    const link = hostConn.links.get(peer);
    setTimeout(() => link && hostConn.drop(link), 300);
    return;
  }
  saveParty();
  broadcast();
}

function guestGone(peer) {
  const i = seatOf(peer);
  if (i < 0) return;
  const seat = H.seats[i];
  seat.peer = null;
  seat.connected = false;
  if (H.phase === "lobby") H.seats.splice(i, 1);
  else if (H.phase === "game") handleEvents(logEntry(H, [gameTime(), LEAVE, i]));
  saveParty();
  broadcast();
}

function hostMessage({ message, from }) {
  const i = seatOf(from);
  if (i > 0) H.seats[i].heard = Date.now();
  switch (message.type) {
    case "hello":
      if (message.v !== PROTOCOL_VERSION) hostConn.send({ type: "reload" }, from);
      else if (i > 0) hostConn.send(snapshot(i), from);
      break;
    case "flip":
      if (i > 0 && Number.isInteger(message.card)) hostFlip(i, message.card);
      break;
    case "bye":
      guestGone(from);
      break;
    default:
      // ping, and anything unknown, which is never thrown on.
      break;
  }
}

async function startHosting() {
  if (hostConn) return;
  role = "host";
  H ??= loadParty() ?? freshParty();
  const stored = store.get(HOST_CODE_KEY);
  H.code ??= isValidCode(stored) ? stored : generateCode();
  store.set(HOST_CODE_KEY, H.code);
  showCode(H.code);
  saveParty();
  broadcast();

  hostConn = new Host({ maxGuests: MAX_PLAYERS - 1 });
  hostConn.addEventListener("status", ({ detail }) => {
    if (detail.taken && !retriedTaken) {
      retriedTaken = true;
      restartWithFreshCode();
      return;
    }
    if (detail.status === "waiting") retriedTaken = false;
    renderStatus(detail);
  });
  hostConn.addEventListener("join", ({ detail }) => guestJoined(detail.id, detail.metadata));
  hostConn.addEventListener("leave", ({ detail }) => guestGone(detail.id));
  hostConn.addEventListener("message", ({ detail }) => hostMessage(detail));
  hostTimers = [setInterval(hostTick, 100), setInterval(broadcast, 50)];

  try {
    await hostConn.start(H.code);
  } catch {
    renderStatus({ status: "error", message: "Could not load pairing. Check your connection." });
  }
}

function stopHosting() {
  hostTimers.forEach(clearInterval);
  hostTimers = [];
  hostConn?.close();
  hostConn = null;
}

async function restartWithFreshCode() {
  stopHosting();
  store.remove(HOST_CODE_KEY);
  if (H) H.code = null;
  await startHosting();
}

function showCode(code) {
  const link = joinLink(code);
  $("partyCode").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  $("partyLink").textContent = link.replace(/^https?:\/\//, "");
  $("partyLink").href = link;
  $("partyQr").innerHTML = qrToSvg(link);
}

function hostStartGame() {
  if (!H || H.phase === "game" || H.seats.length < 2) return;
  const seed = newSeed(H.options.difficulty, H.options.pack);
  const setup = { seed, turn: H.options.turn, limit: 0, players: H.seats.map((s) => s.name) };
  H.game = { setup, state: createGame(setup), log: [], startEpoch: Date.now(), at: new Date().toISOString() };
  H.count += 1;
  H.phase = "game";
  H.caption = `${H.seats[0].name} goes first.`;
  H.pulse = null;
  H.showing = null;
  H.replay = null;
  saveParty();
  broadcast();
}

// Back to the lobby with the same players, for another game.
function hostAgain() {
  if (!H) return;
  H.seats = H.seats.filter((s, i) => i === 0 || s.connected);
  H.phase = "lobby";
  H.game = null;
  saveParty();
  broadcast();
}

let leaveArmed = 0;
function hostLeave() {
  if (H?.phase === "game" && Date.now() - leaveArmed > 3000) {
    leaveArmed = Date.now();
    $("partyLeaveLabel").textContent = "Tap again to end the party";
    setTimeout(() => ($("partyLeaveLabel").textContent = "Leave"), 3000);
    return;
  }
  stopHosting();
  H = null;
  role = null;
  try {
    sessionStorage.removeItem(PARTY_KEY);
  } catch {
    // Nothing kept.
  }
  wakeLock(false);
  showChoose();
}

/* ---- guest ---- */

let guest = null;
let guestCode = "";
let lastHeard = 0;
let staleTimer = null;
let rejoins = 0;

// A snapshot is input from another device: checked before it is drawn.
function cleanSnapshot(m) {
  if (m.phase !== "lobby" && m.phase !== "game" && m.phase !== "over") return null;
  if (!Array.isArray(m.players) || !m.players.length || m.players.length > MAX_PLAYERS) return null;
  const players = m.players.map((p, i) => ({
    name: cleanText(p?.name, 20) || `Player ${i + 1}`,
    connected: p?.connected === true,
    score: Math.max(0, Math.floor(Number(p?.score) || 0)),
    pairs: Math.max(0, Math.floor(Number(p?.pairs) || 0)),
  }));
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : lo);
  const snap = {
    phase: m.phase,
    game: int(m.game, 0, 1e6),
    you: int(m.you, 0, players.length - 1),
    players,
    options: { difficulty: cleanDifficulty(m.options?.difficulty), pack: cleanPack(m.options?.pack), turn: cleanTurn(m.options?.turn) },
    current: int(m.current, -1, players.length - 1),
    caption: cleanText(m.caption, 120),
    turnMs: int(m.turnMs, 0, Math.max(...TURN_LIMITS) * 1000),
    turnLeft: int(Math.round(Number(m.turnLeft) || 0), 0, 60000),
    shape: null,
    status: [],
    faces: {},
    pulse: null,
    results: null,
    replay: null,
  };
  if (m.phase === "game") {
    const d = Object.values(DIFFICULTIES).find((x) => x.pairs * 2 === m.shape?.count && x.cols === m.shape?.cols);
    if (!d || !Array.isArray(m.status) || m.status.length !== d.pairs * 2) return null;
    snap.shape = { count: d.pairs * 2, cols: d.cols, rows: d.rows };
    snap.status = m.status.map((s) => (s === UP || s === MATCHED ? s : DOWN));
    for (const [k, tile] of Object.entries(m.faces ?? {})) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0 && i < snap.status.length && ALL_TILES.includes(tile)) snap.faces[i] = tile;
    }
    if (m.pulse && Number.isInteger(m.pulse.n) && Array.isArray(m.pulse.cards) && (m.pulse.kind === "match" || m.pulse.kind === "miss")) {
      snap.pulse = { n: m.pulse.n, kind: m.pulse.kind, cards: m.pulse.cards.filter((c) => Number.isInteger(c) && c >= 0 && c < snap.status.length).slice(0, 2) };
    }
  }
  if (m.phase === "over") {
    snap.replay = cleanReplay(m.replay);
    snap.results = Array.isArray(m.results)
      ? m.results.slice(0, MAX_PLAYERS).map((r, i) => ({
          name: players[i]?.name ?? `Player ${i + 1}`,
          score: Math.max(0, Math.floor(Number(r?.score) || 0)),
          pairs: Math.max(0, Math.floor(Number(r?.pairs) || 0)),
        }))
      : [];
  }
  return snap;
}

async function join(input) {
  const code = normaliseCode(input);
  if (!isValidCode(code)) {
    renderStatus({ status: "error", message: `A code is ${CODE_LENGTH} characters.` });
    return;
  }
  guestCode = code;
  role = "guest";
  guest?.close();
  guest = new Guest();
  const mine = guest;
  guest.addEventListener("status", ({ detail }) => {
    if (guest !== mine) return;
    renderStatus(detail);
    if (detail.status === "connected") rejoins = 0;
    // Back by itself after a drop, a few times; never after unreachable,
    // since the network has not changed.
    if (detail.status === "dropped" && rejoins < 5) {
      rejoins += 1;
      setTimeout(() => guest === mine && join(guestCode), 1500);
    }
  });
  guest.addEventListener("message", ({ detail: { message } }) => {
    if (guest !== mine) return;
    lastHeard = Date.now();
    if (message.type === "state") {
      const snap = cleanSnapshot(message);
      if (snap) renderParty(snap);
    } else if (message.type === "full") renderStatus({ status: "error", message: "This party is full: four players at most." });
    else if (message.type === "started") renderStatus({ status: "error", message: "That game has already started. Join when it is back in the lobby." });
    else if (message.type === "reload") renderStatus({ status: "error", message: "The host is on a newer version. Reload this page to join." });
  });

  if (!$("partyChoose").hidden) $("partyStatus").textContent = "Connecting.";
  const name = cleanText($("joinName").value, 20) || getSettings().name || "";
  try {
    await guest.connect(code, { cid: clientId(), name });
    store.set(LAST_CODE_KEY, code);
  } catch {
    renderStatus({ status: "error", message: "Could not load pairing. Check your connection." });
  }
  clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    if (guest?.status !== "connected") return;
    guest.send({ type: "ping" });
    $("partyStale").hidden = Date.now() - lastHeard < STALE_MS;
  }, 1000);
}

function guestLeave() {
  guest?.leave();
  guest = null;
  role = null;
  clearInterval(staleTimer);
  store.remove(LAST_CODE_KEY);
  wakeLock(false);
  showChoose();
}

/* ---- the choose panel ---- */

function showChoose() {
  showView("party");
  showPanel("partyChoose");
  $("partyStatus").textContent = navigator.onLine === false ? "Party games need a connection to pair." : "";
  $("partyStale").hidden = true;
  if (!$("joinName").value) $("joinName").value = getSettings().name ?? "";
}

export function openParty() {
  if (!role) {
    showChoose();
    return;
  }
  showView("party");
  if (role === "host") broadcast();
}

// Picks a party back up on load: a host's game in this tab, or a join link.
// True when the page opens on the party.
export function resumeParty() {
  const code = normaliseCode(new URLSearchParams(location.search).get("id"));
  if (location.pathname === "/join") {
    history.replaceState(null, "", "/");
    showChoose();
    $("joinCode").value = code;
    if (isValidCode(code)) join(code);
    return true;
  }
  const saved = (() => {
    try {
      return sessionStorage.getItem(PARTY_KEY);
    } catch {
      return null;
    }
  })();
  if (saved) {
    showView("party");
    startHosting();
    return true;
  }
  return false;
}

export function initParty({ board: b, replayer: r }) {
  board = b;
  replayer = r;
  const remembered = store.get(LAST_CODE_KEY) ?? "";
  if (remembered) $("joinCode").value = remembered;

  $("hostBtn").addEventListener("click", () => startHosting());
  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinCode").value);
  });
  $("partyStartBtn").addEventListener("click", hostStartGame);
  $("newCodeBtn").addEventListener("click", () => restartWithFreshCode());
  $("copyJoinBtn").addEventListener("click", async () => {
    const label = $("copyJoinLabel");
    label.textContent = (await copyText(joinLink(H.code))) ? "Copied" : "Copy failed";
    setTimeout(() => (label.textContent = "Copy link"), 2000);
  });
  const option = (id, attr, clean) =>
    $(id).addEventListener("click", (e) => {
      const btn = e.target.closest(`[data-${attr}]`);
      if (!btn || role !== "host" || H?.phase !== "lobby") return;
      H.options[attr] = clean(btn.dataset[attr]);
      saveParty();
      broadcast();
    });
  option("pDifficulty", "difficulty", cleanDifficulty);
  option("pPack", "pack", cleanPack);
  option("pTurn", "turn", cleanTurn);
  document.querySelectorAll("[data-party-leave]").forEach((btn) =>
    btn.addEventListener("click", () => (role === "host" ? hostLeave() : guestLeave()))
  );
  $("partyAgainBtn").addEventListener("click", hostAgain);
  $("partyReplayBtn").addEventListener("click", () => lastReplay && replayer.open(lastReplay, { verified: false }));
  $("partyShareBtn").addEventListener("click", () => lastReplay && shareReplay(lastReplay, null, $("partyShareLabel")));
  $("partyBackBtn").addEventListener("click", () => document.dispatchEvent(new CustomEvent("memy:home")));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (role) wakeLock(true);
    if (role === "guest" && guest?.status === "dropped") join(guestCode);
  });
}

export const inParty = () => role !== null;
