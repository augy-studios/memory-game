// Memory Game's rules. Shared by the game (js/game.js), party games
// (js/party.js), replays (js/replay.js) and the leaderboard API
// (api/leaderboard/submit.js), so a score the server checks was made under
// the same rules the page plays by. Pure: no DOM, no fetch, no storage, and
// integers wherever a score is worked out, so the page and the server agree
// to the point.
//
// A game is its setup (seed, time limits, players) and a log. Everything
// else, the board, the turns, the timeouts and every score, is worked out
// from those two by replaying the log through flip(), leave() and join().
//
// Changing anything here that affects the deal or a score means games
// played on the old build stop verifying. See the README.

/* ---- difficulty and picture packs ---- */

export const DIFFICULTIES = {
  easy: { id: "easy", letter: "E", label: "Easy", cols: 4, rows: 4, pairs: 8, percent: 100 },
  normal: { id: "normal", letter: "N", label: "Normal", cols: 6, rows: 4, pairs: 12, percent: 150 },
  hard: { id: "hard", letter: "H", label: "Hard", cols: 6, rows: 6, pairs: 18, percent: 225 },
  expert: { id: "expert", letter: "X", label: "Expert", cols: 8, rows: 6, pairs: 24, percent: 350 },
};

const list = (names) => names.trim().split(/\s+/);

// The order of each list is part of the deal: adding a picture at the end
// is safe, while reordering or removing one changes every seed's board.
// `models` packs have a 3D model per picture, in models/<pack>/, and are
// played on the 3D board; the others are flat. The two `mix` packs draw from
// every pack of their kind, so a board is never part flat and part 3D.
export const PACKS = {
  mixed: { id: "mixed", letter: "M", label: "Mixed", models: false, mix: true, tiles: [] },
  mixed3d: { id: "mixed3d", letter: "D", label: "Mixed 3D", models: true, mix: true, tiles: [] },
  jungle: {
    id: "jungle",
    letter: "J",
    label: "Jungle",
    models: false,
    tiles: list("anaconda bee chameleon cockatoo crocodile gorilla macaw monkey piranha sloth tiger toucan"),
  },
  animals: {
    id: "animals",
    letter: "A",
    label: "Animals",
    models: false,
    tiles: list(`bear buffalo chick chicken cow crocodile dog duck elephant frog giraffe goat gorilla hippo horse
      monkey moose narwhal owl panda parrot penguin pig rabbit rhino sloth snake walrus whale zebra`),
  },
  food: {
    id: "food",
    letter: "F",
    label: "Food",
    models: true,
    tiles: list(`apple banana cherries grapes lemon orange pear pineapple strawberry watermelon broccoli corn
      eggplant mushroom pumpkin croissant donut-sprinkles cupcake cake-birthday ice-cream pizza burger hot-dog
      sushi-salmon fries waffle egg-cooked cup-coffee soda-can cheese`),
  },
  pets: {
    id: "pets",
    letter: "P",
    label: "Pets",
    models: true,
    tiles: list(`beaver bee bunny cat caterpillar chick cow crab deer dog elephant fish fox giraffe hog koala
      lion monkey panda parrot penguin pig polar tiger`),
  },
  holiday: {
    id: "holiday",
    letter: "W",
    label: "Holiday",
    models: true,
    tiles: list(`candy-cane-red gingerbread-man hanukkah-dreidel hanukkah-menorah-candles kwanzaa-kinara
      nutcracker present-a-cube present-b-round reindeer sled snowflake-a snowman sock-red-cane sock-green
      train-locomotive tree-decorated wreath-decorated lantern`),
  },
};

// A tile id is "pack/name". A mix is every pack of its kind, in order.
for (const pack of Object.values(PACKS)) pack.tiles = pack.tiles.map((name) => `${pack.id}/${name}`);
export const ALL_TILES = Object.values(PACKS).flatMap((p) => p.tiles);
const tilesOfKind = (models) => Object.values(PACKS).filter((p) => !p.mix && p.models === models).flatMap((p) => p.tiles);
PACKS.mixed.tiles = tilesOfKind(false);
PACKS.mixed3d.tiles = tilesOfKind(true);

// Whether a pack is played on the 3D board.
export const isPack3d = (pack) => PACKS[pack]?.models === true;

export const tilePack = (tile) => String(tile).split("/")[0];
export const tileName = (tile) => String(tile).split("/")[1] ?? "";

// Names that do not read well with the dashes taken out.
const LABELS = {
  "donut-sprinkles": "Donut",
  "cake-birthday": "Birthday cake",
  "sushi-salmon": "Sushi",
  "egg-cooked": "Fried egg",
  "cup-coffee": "Coffee",
  "candy-cane-red": "Candy cane",
  "hanukkah-dreidel": "Dreidel",
  "hanukkah-menorah-candles": "Menorah",
  "kwanzaa-kinara": "Kinara",
  "present-a-cube": "Present",
  "present-b-round": "Round present",
  "snowflake-a": "Snowflake",
  "sock-red-cane": "Red stocking",
  "sock-green": "Green stocking",
  "train-locomotive": "Toy train",
  "tree-decorated": "Christmas tree",
  "wreath-decorated": "Wreath",
  polar: "Polar bear",
  hog: "Boar",
};

// "ice-cream" -> "Ice cream", for captions and screen readers.
export function tileLabel(tile) {
  const name = tileName(tile);
  if (LABELS[name]) return LABELS[name];
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ---- time limits ----
   A turn limit is seconds per turn; running out ends the turn. A game limit
   is seconds per pair on the board, so it means the same at every size;
   running out ends the game. Tighter limits score more. */

export const TURN_LIMITS = [0, 10, 5, 3];
export const TURN_PERCENT = { 0: 100, 10: 110, 5: 125, 3: 150 };
export const GAME_LIMITS = [0, 12, 8, 5];
export const GAME_PERCENT = { 0: 100, 12: 110, 8: 125, 5: 150 };
export const GAME_LIMIT_LABELS = { 0: "None", 12: "Relaxed", 8: "Brisk", 5: "Tight" };

export const cleanDifficulty = (v) => (DIFFICULTIES[v] ? v : "normal");
export const cleanPack = (v) => (PACKS[v] ? v : "mixed");
export const cleanTurn = (v) => (TURN_LIMITS.includes(Number(v)) ? Number(v) : 0);
export const cleanLimit = (v) => (GAME_LIMITS.includes(Number(v)) ? Number(v) : 0);

export const gameLimitMs = (difficulty, limit) => DIFFICULTIES[difficulty].pairs * limit * 1000;

/* ---- randomness ---- */

// cyrb53's mixing, one 32 bit half of it: a string to a well mixed number.
export function hashString(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// mulberry32, seeded from a string. Returns unsigned 32 bit integers.
export function randomSource(key) {
  let a = hashString(key);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function shuffle(items, next) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// The board a seed deals: a tile id per card, in reading order. A pack with
// fewer pictures than the board needs is topped up from the other packs of
// its kind, flat from flat and 3D from 3D.
export function deal(seed) {
  const d = DIFFICULTIES[seed.difficulty];
  const next = randomSource(`deal|${seed.text}`);
  const pack = PACKS[seed.pack];
  const own = pack.tiles;
  const chosen = shuffle([...own], next).slice(0, d.pairs);
  if (chosen.length < d.pairs) {
    const others = tilesOfKind(pack.models).filter((t) => !own.includes(t));
    chosen.push(...shuffle(others, next).slice(0, d.pairs - chosen.length));
  }
  return shuffle([...chosen, ...chosen], next);
}

/* ---- scoring ----
   The score grows as the game goes on. Each match earns points, more for a
   streak of matches and for a quick turn. A miss on a card whose partner
   had already been seen, a memory slip, costs a little. Finishing the board
   adds a bonus for few turns and a bonus for time to spare. Then the whole
   thing is scaled by the difficulty and by each time limit. */

export const MATCH_POINTS = 100;
export const STREAK_STEP = 20; // percent per match in a row, after the first
export const STREAK_MAX = 100;
export const QUICK_MS = 1500; // a turn this quick earns the full speed bonus
export const SLOW_MS = 10000; // and one this slow, or the turn limit, none
export const SPEED_MAX = 50;
export const SLIP_POINTS = 25;
export const EFFICIENCY_POINTS = 60; // times pairs, at one turn per pair
export const TIME_BONUS_MAX = 50; // percent, with all the time left
export const BONUS_WINDOW_PER_PAIR_MS = 12000; // the time bonus's clock without a game limit

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function matchPoints(streak, turnTime, turnMs) {
  const streakPct = 100 + Math.min(STREAK_MAX, STREAK_STEP * (streak - 1));
  const cap = turnMs ? Math.min(turnMs, SLOW_MS) : SLOW_MS;
  const used = clamp(turnTime, QUICK_MS, cap);
  const speedPct = 100 + Math.floor((SPEED_MAX * (cap - used)) / (cap - QUICK_MS));
  return Math.floor((MATCH_POINTS * streakPct * speedPct) / 10000);
}

export function percents(setup) {
  return {
    difficulty: DIFFICULTIES[setup.seed.difficulty].percent,
    turn: TURN_PERCENT[setup.turn] ?? 100,
    game: GAME_PERCENT[setup.limit] ?? 100,
  };
}

// Raw points to score: each percentage in turn, rounding down at each step.
export function scale(raw, setup) {
  const p = percents(setup);
  return Math.floor((Math.floor((Math.floor((raw * p.difficulty) / 100) * p.turn) / 100) * p.game) / 100);
}

/* ---- playing ---- */

// setup: { seed, turn, limit, players: [names] }. One player is a solo game.
export function createGame(setup) {
  const d = DIFFICULTIES[setup.seed.difficulty];
  const cards = deal(setup.seed);
  const partner = cards.map((tile, i) => cards.findIndex((other, j) => j !== i && other === tile));
  const names = setup.players?.length ? setup.players : ["Player"];
  return {
    setup,
    cards,
    partner,
    cols: d.cols,
    rows: d.rows,
    pairs: d.pairs,
    turnMs: setup.turn * 1000,
    gameMs: gameLimitMs(setup.seed.difficulty, setup.limit),
    status: new Array(cards.length).fill(0), // 0 face down, 2 matched
    up: [], // face up this turn, in order
    seen: new Array(cards.length).fill(false),
    players: names.map((name) => ({ name, raw: 0, pairs: 0, turns: 0, streak: 0, slips: 0, active: true })),
    current: 0,
    matched: 0,
    turnStart: 0,
    lastT: 0,
    phase: "play",
    reason: null,
    endedAt: null,
    // Matches on a card whose partner had never been seen, and the chance
    // of each such try. Checked by the server, see checkGame().
    luck: { hits: 0, chances: [] },
  };
}

function passTurn(state) {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.current + k) % n;
    if (state.players[i].active) {
      state.current = i;
      return;
    }
  }
}

function end(state, reason, at, events) {
  state.phase = "over";
  state.reason = reason;
  state.endedAt = at;
  state.up = [];
  events.push({ type: "over", reason, at });
}

// When the clock next does something by itself: a turn running out, or the
// game. Infinity when nothing is due.
export function nextDeadline(state) {
  if (state.phase !== "play") return Infinity;
  const turn = state.turnMs ? state.turnStart + state.turnMs : Infinity;
  const game = state.gameMs || Infinity;
  return Math.min(turn, game);
}

// Everything the clock did up to `t`. Each timeout happens exactly at its
// deadline whenever this is called, so the page, a replay and the server
// always see the same game.
export function advance(state, t, events = []) {
  while (state.phase === "play") {
    const turn = state.turnMs ? state.turnStart + state.turnMs : Infinity;
    const game = state.gameMs || Infinity;
    if (game <= t && game <= turn) {
      end(state, "time", game, events);
      break;
    }
    if (turn > t) break;
    const player = state.players[state.current];
    const card = state.up[0] ?? null;
    if (card !== null) player.turns += 1;
    player.streak = 0;
    state.up = [];
    events.push({ type: "timeout", at: turn, player: state.current, card });
    state.turnStart = turn;
    passTurn(state);
  }
  return events;
}

// One card turned over at `t` ms into the game. Returns what happened, as
// events, or null if that card cannot be turned over now.
export function flip(state, index, t) {
  const events = advance(state, t);
  if (state.phase !== "play") return null;
  if (!Number.isInteger(index) || index < 0 || index >= state.cards.length) return null;
  if (state.status[index] !== 0 || state.up.includes(index) || t < state.lastT) return null;
  state.lastT = t;
  const player = state.players[state.current];
  const who = state.current;
  events.push({ type: "flip", at: t, player: who, card: index, tile: state.cards[index] });

  if (state.up.length === 0) {
    state.up = [index];
    state.seen[index] = true;
    return events;
  }

  const a = state.up[0];
  const b = index;
  const partner = state.partner[a];
  const knewPartner = state.seen[partner];

  if (!knewPartner && !state.seen[b]) {
    let unseen = 0;
    for (let i = 0; i < state.cards.length; i++) if (state.status[i] === 0 && !state.seen[i] && i !== a) unseen++;
    state.luck.chances.push(1 / unseen);
    if (b === partner) state.luck.hits += 1;
  }
  state.seen[b] = true;

  const turnTime = t - state.turnStart;
  state.turnStart = t;
  state.up = [];
  player.turns += 1;

  if (b === partner) {
    state.status[a] = 2;
    state.status[b] = 2;
    state.matched += 1;
    player.pairs += 1;
    player.streak += 1;
    const points = matchPoints(player.streak, turnTime, state.turnMs);
    player.raw += points;
    events.push({ type: "match", at: t, player: who, cards: [a, b], tile: state.cards[a], points, streak: player.streak });
    if (state.matched === state.pairs) end(state, "done", t, events);
  } else {
    player.streak = 0;
    const slip = knewPartner;
    if (slip) {
      player.slips += 1;
      player.raw = Math.max(0, player.raw - SLIP_POINTS);
    }
    events.push({ type: "miss", at: t, player: who, cards: [a, b], slip });
    passTurn(state);
  }
  return events;
}

// A party player dropping out at `t`, or coming back. Leaving on their own
// turn hands it on; their score stays.
export function leave(state, p, t) {
  const events = advance(state, t);
  const player = state.players[p];
  if (state.phase !== "play" || !player || !player.active) return events;
  player.active = false;
  events.push({ type: "leave", at: t, player: p });
  if (state.current === p) {
    state.up = [];
    player.streak = 0;
    state.turnStart = t;
    passTurn(state);
  }
  return events;
}

export function join(state, p, t) {
  const events = advance(state, t);
  const player = state.players[p];
  if (state.phase !== "play" || !player || player.active) return events;
  player.active = true;
  events.push({ type: "join", at: t, player: p });
  return events;
}

/* ---- the log ----
   [t, card] a card turned over; [t, -1, p] player p left; [t, -2, p] player
   p came back. Solo games only ever log the first. */

export const LEAVE = -1;
export const JOIN = -2;

export function applyEntry(state, entry) {
  const [t, code, p] = entry;
  if (code === LEAVE) return leave(state, p, t);
  if (code === JOIN) return join(state, p, t);
  return flip(state, code, t);
}

/* ---- results ---- */

// The score so far, as shown while playing.
export const liveScore = (state, p = 0) => scale(state.players[p].raw, state.setup);

// Every player's final score, with how it was made. Solo games add the
// finishing bonuses; party games are the points as they stand.
export function finalScores(state) {
  const solo = state.players.length === 1;
  const done = state.reason === "done";
  return state.players.map((player) => {
    let completion = 0;
    let timeBonus = 0;
    if (solo && done && player.turns > 0) {
      completion = Math.floor((EFFICIENCY_POINTS * state.pairs * state.pairs) / player.turns);
      const window = state.gameMs || state.pairs * BONUS_WINDOW_PER_PAIR_MS;
      const left = Math.max(0, window - state.endedAt);
      timeBonus = Math.floor((TIME_BONUS_MAX * left) / window);
    }
    const base = player.raw + completion;
    const timed = Math.floor((base * (100 + timeBonus)) / 100);
    return {
      name: player.name,
      points: player.raw,
      completion,
      timeBonus,
      pairs: player.pairs,
      turns: player.turns,
      slips: player.slips,
      ...percents(state.setup),
      score: scale(timed, state.setup),
    };
  });
}

/* ---- checking a finished game (server side) ---- */

// A leaderboard run can be submitted for this long after it started.
export const RUN_TTL_MS = 3 * 60 * 60 * 1000;
// Vercel's clock and Supabase's, and a slow request, all in one allowance.
export const CLOCK_SLACK_MS = 15000;
export const MAX_LOG = 4000;
// Two cards turned over closer together than this is quicker than a hand
// moves, a few times in a game is a double tap, and often is a script.
export const MIN_FLIP_GAP_MS = 120;
export const QUICK_FLIPS_ALLOWED = 4;
export const QUICK_FLIPS_SHARE = 0.1;
// Matches on never-seen cards: a game is refused when chance would give at
// least that many less than once in this many games. Honest play is refused
// that rarely by definition; a script that knows the board is refused every
// time, even on the smallest board, where perfect blind play is about one
// game in two million. scripts/test-rules.mjs measures both sides.
export const LUCK_ODDS = 1e-6;

// The chance of at least `k` successes from independent tries with these
// chances (a Poisson binomial tail), worked out exactly.
export function chanceOfAtLeast(chances, k) {
  if (k <= 0) return 1;
  let dist = [1];
  for (const p of chances) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((q, i) => {
      next[i] += q * (1 - p);
      next[i + 1] += q * p;
    });
    dist = next;
  }
  return dist.slice(k).reduce((a, b) => a + b, 0);
}

// Whether a solo game could have come from real play in the time the
// server saw pass. Returns { reason } when it could not, or { reason: null,
// state, result } with the score the server works out itself.
//
// Bounds cheating rather than preventing it: the board is dealt in the
// browser from the seed, so a script can know it. What it cannot do is play
// as if it knew it, quicker than a hand, or longer than the run has lasted.
export function checkGame(setup, log, durationMs, elapsedMs) {
  if (!Array.isArray(log) || log.length === 0 || log.length > MAX_LOG) return { reason: "bad_log" };
  if (!Number.isInteger(durationMs) || durationMs < 0) return { reason: "bad_duration" };
  const state = createGame(setup);
  let prev = -Infinity;
  let quick = 0;
  for (const entry of log) {
    if (!Array.isArray(entry) || entry.length !== 2) return { reason: "bad_log" };
    const [t, card] = entry;
    if (!Number.isInteger(t) || !Number.isInteger(card) || t < 0 || t < prev) return { reason: "bad_log" };
    if (t - prev < MIN_FLIP_GAP_MS) quick += 1;
    prev = t;
    if (!flip(state, card, t)) return { reason: "bad_flip" };
  }
  advance(state, durationMs);
  if (state.phase !== "over") return { reason: "not_finished" };
  if (state.endedAt !== durationMs) return { reason: "bad_duration" };
  if (durationMs > elapsedMs + CLOCK_SLACK_MS) return { reason: "too_long" };
  if (quick > QUICK_FLIPS_ALLOWED + QUICK_FLIPS_SHARE * log.length) return { reason: "too_fast" };
  if (chanceOfAtLeast(state.luck.chances, state.luck.hits) < LUCK_ODDS) return { reason: "too_lucky" };
  return { reason: null, state, result: finalScores(state)[0] };
}
