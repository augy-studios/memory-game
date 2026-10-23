// The replay format, shared by the API that stores replays and the page that
// plays them. A replay is what happened, not what it scored: every score is
// worked out again from the log by js/rules.js, so a replay cannot claim
// points its moves do not add up to.
//
// {
//   v: 1,
//   kind: "solo" | "party",
//   seed: "NM-BXK4-M9TR",
//   turn: 0 | 10 | 5 | 3,          seconds per turn, 0 for no limit
//   limit: 0 | 12 | 8 | 5,         seconds per pair for the game, 0 for none
//   players: ["Augy", "Ben"],
//   log: [[t, card], [t, -1, p], ...],   js/rules.js's log
//   at: ISO time the game started, or null
// }
//
// Online, a replay is stored by /api/replay/create and shared as /r/<id>.
// Offline, or when the API will not take it, the whole game travels in the
// link instead, the way chess-game's replay links do: the seed and limits as
// they are, and the log packed a few bytes a move.

import { DIFFICULTIES, JOIN, LEAVE, MAX_LOG, cleanLimit, cleanTurn } from "./rules.js";
import { parseSeed } from "./seed.js";

export const REPLAY_VERSION = 1;
export const MAX_PLAYERS = 4;

// Control characters out, whitespace collapsed, cut to `max` characters.
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFKC").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, max).join("").trim();
}

// A replay from anywhere (a link, the API, a party host) made safe to use,
// or null if it is not one. The log is checked for shape here; whether its
// moves are legal is for rules.js when it plays them.
export function cleanReplay(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== REPLAY_VERSION) return null;
  const kind = raw.kind === "solo" || raw.kind === "party" ? raw.kind : null;
  const seed = parseSeed(raw.seed);
  if (!kind || !seed || typeof raw.seed !== "string" || seed.text !== raw.seed.toUpperCase()) return null;
  const cards = DIFFICULTIES[seed.difficulty].pairs * 2;

  const players = (Array.isArray(raw.players) ? raw.players.slice(0, MAX_PLAYERS) : []).map(
    (p, i) => cleanText(p, 20) || `Player ${i + 1}`
  );
  if (!players.length || (kind === "solo" && players.length !== 1)) return null;

  if (!Array.isArray(raw.log) || !raw.log.length || raw.log.length > MAX_LOG) return null;
  const log = [];
  let last = 0;
  for (const e of raw.log) {
    if (!Array.isArray(e)) return null;
    const [t, code, p] = e;
    if (!Number.isInteger(t) || t < last || !Number.isInteger(code)) return null;
    last = t;
    if (code >= 0 && code < cards && e.length === 2) log.push([t, code]);
    else if ((code === LEAVE || code === JOIN) && kind === "party" && Number.isInteger(p) && p >= 0 && p < players.length) {
      log.push([t, code, p]);
    } else return null;
  }

  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  return { v: REPLAY_VERSION, kind, seed: seed.text, turn: cleanTurn(raw.turn), limit: cleanLimit(raw.limit), players, log, at };
}

// What rules.js's createGame() wants for a replay.
export const setupOf = (replay) => ({
  seed: parseSeed(replay.seed),
  turn: replay.turn,
  limit: replay.limit,
  players: replay.players,
});

/* ---- packing a log into a link ----
   Each entry is one byte saying what happened, then the milliseconds since
   the entry before as a varint: 0-63 a card turned over, 64 + p player p
   left, 128 + p player p came back. Two or three bytes a move. */

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function packLog(log) {
  const bytes = [];
  let prev = 0;
  for (const [t, code, p] of log) {
    bytes.push(code === LEAVE ? 64 + p : code === JOIN ? 128 + p : code);
    let delta = t - prev;
    prev = t;
    do {
      let b = delta & 0x7f;
      delta = Math.floor(delta / 128);
      if (delta > 0) b |= 0x80;
      bytes.push(b);
    } while (delta > 0);
  }
  return toBase64Url(Uint8Array.from(bytes));
}

export function unpackLog(text) {
  const bytes = fromBase64Url(text ?? "");
  if (!bytes || !bytes.length) return null;
  const log = [];
  let t = 0;
  let i = 0;
  while (i < bytes.length) {
    const code = bytes[i++];
    let delta = 0;
    let scale = 1;
    for (;;) {
      if (i >= bytes.length || scale > 2 ** 35) return null;
      const b = bytes[i++];
      delta += (b & 0x7f) * scale;
      scale *= 128;
      if (!(b & 0x80)) break;
    }
    t += delta;
    if (code < 64) log.push([t, code]);
    else if (code < 128) log.push([t, LEAVE, code - 64]);
    else if (code < 192) log.push([t, JOIN, code - 128]);
    else return null;
  }
  return log;
}

// A link that holds the whole game.
export function longLink(origin, replay) {
  const params = new URLSearchParams({
    watch: packLog(replay.log),
    seed: replay.seed,
    turn: String(replay.turn),
    limit: String(replay.limit),
    names: replay.players.map((n) => n.replace(/,/g, " ")).join(","),
  });
  return `${origin}/?${params}`;
}

export const shortLink = (origin, id) => `${origin}/r/${id}`;

// Reads a long link's parameters. A replay, { damaged: true } if the link
// is broken, or null if it is not a replay link.
export function readLongLink(params) {
  if (!params.has("watch")) return null;
  const names = (params.get("names") ?? "").split(",").filter(Boolean);
  const replay = cleanReplay({
    v: REPLAY_VERSION,
    kind: names.length > 1 ? "party" : "solo",
    seed: params.get("seed") ?? "",
    turn: Number(params.get("turn")),
    limit: Number(params.get("limit")),
    players: names.length ? names : ["Player"],
    log: unpackLog(params.get("watch")),
    at: null,
  });
  return replay ?? { damaged: true };
}
