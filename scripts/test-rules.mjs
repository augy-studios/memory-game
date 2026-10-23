#!/usr/bin/env node
// The rules, the seeds and the replay links, without a browser or a
// database: the same seed deals the same board, honest play passes the
// API's check, a player who knows the board does not, and a replay link
// unpacks to the game it was made from.
//
// Run: node scripts/test-rules.mjs

import { randomInt } from "node:crypto";
import {
  ALL_TILES,
  DIFFICULTIES,
  PACKS,
  advance,
  checkGame,
  createGame,
  deal,
  finalScores,
  flip,
  gameLimitMs,
  leave,
  nextDeadline,
} from "../main-site/js/rules.js";
import { newSeed, parseSeed } from "../main-site/js/seed.js";
import { cleanReplay, packLog, unpackLog } from "../main-site/js/replay-format.js";

let failed = 0;
function check(label, ok, extra = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? `: ${extra}` : ""}`);
}

const byte = () => randomInt(256);

// Seeds and the deal.
const seed = newSeed("hard", "jungle", byte);
check("seed text round trips", parseSeed(seed.text)?.text === seed.text, seed.text);
check("seed forgives case and spacing", parseSeed(` ${seed.text.toLowerCase().replace(/-/g, " ")} `)?.text === seed.text);
check("bare body takes the fallback", parseSeed(seed.body, { difficulty: "easy", pack: "food" })?.text.startsWith("EF-"));
check("rubbish is not a seed", parseSeed("hello") === null && parseSeed("NM-AAAA-AAAA") === null);
check("same seed, same board", JSON.stringify(deal(seed)) === JSON.stringify(deal(parseSeed(seed.text))));
check("different seed, different board", JSON.stringify(deal(seed)) !== JSON.stringify(deal(newSeed("hard", "jungle", byte))));
for (const d of Object.values(DIFFICULTIES)) {
  for (const p of Object.keys(PACKS)) {
    const cards = deal(newSeed(d.id, p, byte));
    const counts = new Map();
    cards.forEach((c) => counts.set(c, (counts.get(c) ?? 0) + 1));
    const pairsOk = cards.length === d.pairs * 2 && [...counts.values()].every((n) => n === 2) && cards.every((c) => ALL_TILES.includes(c));
    if (!pairsOk) check(`deal ${d.id}/${p}`, false);
  }
}
check("every difficulty and pack deals whole pairs of real pictures", true);

// Players. `memory` is the chance a seen card is remembered; `knows` plays
// as if it could see every card.
function play(setup, { memory = 1, knows = false, gap = () => 700 + randomInt(900) } = {}) {
  const state = createGame(setup);
  const log = [];
  const known = new Map(); // card -> tile, as remembered
  let t = 0;
  const turn = (card) => {
    t += gap();
    const events = flip(state, card, t);
    if (!events && state.phase === "over") return null;
    if (!events) throw new Error(`refused flip ${card} at ${t}`);
    log.push([t, card]);
    if (Math.random() < memory) known.set(card, state.cards[card]);
    return events;
  };
  while (state.phase === "play" && log.length < 3000) {
    const open = state.cards.map((_, i) => i).filter((i) => state.status[i] === 0);
    let first;
    let second;
    if (knows) {
      first = open[0];
      second = state.partner[first];
    } else {
      const pair = open.find((i) => known.has(i) && open.some((j) => j !== i && known.get(j) === known.get(i)));
      if (pair !== undefined) {
        first = pair;
        second = open.find((j) => j !== pair && known.get(j) === known.get(pair));
      } else {
        const unseen = open.filter((i) => !known.has(i));
        first = (unseen.length ? unseen : open)[randomInt((unseen.length ? unseen : open).length)];
      }
    }
    turn(first);
    if (state.phase !== "play") break;
    if (second === undefined) {
      const tile = state.cards[first];
      const mate = open.find((j) => j !== first && known.get(j) === tile);
      const unseen = open.filter((i) => i !== first && !known.has(i));
      second = mate ?? (unseen.length ? unseen : open.filter((i) => i !== first))[0];
    }
    turn(second);
  }
  return { state, log, duration: state.endedAt ?? t };
}

const setupOf = (difficulty, turn = 0, limit = 0) => ({ seed: newSeed(difficulty, "mixed", byte), turn, limit, players: ["Test"] });

let honestPassed = 0;
let honestTotal = 0;
for (const d of Object.keys(DIFFICULTIES)) {
  for (let i = 0; i < 1000; i++) {
    const setup = setupOf(d);
    const { log, duration } = play(setup, { memory: [1, 0.9, 0.7][i % 3] });
    const result = checkGame(setup, log, duration, duration + 5000);
    honestTotal += 1;
    if (!result.reason) honestPassed += 1;
    else console.log(`     honest ${d} refused: ${result.reason}`);
  }
}
check("honest play passes the check", honestPassed === honestTotal, `${honestPassed} of ${honestTotal}`);

let cheatsCaught = 0;
for (const d of Object.keys(DIFFICULTIES)) {
  for (let i = 0; i < 10; i++) {
    const setup = setupOf(d);
    const { log, duration } = play(setup, { knows: true });
    if (checkGame(setup, log, duration, duration + 5000).reason === "too_lucky") cheatsCaught += 1;
  }
}
check("knowing the board is refused as too lucky", cheatsCaught === 40, `${cheatsCaught} of 40`);

{
  const setup = setupOf("normal");
  const { log, duration } = play(setup, { gap: () => 40 });
  check("flipping faster than a hand is refused", checkGame(setup, log, duration, duration + 5000).reason === "too_fast");
}
{
  const setup = setupOf("normal");
  const { log, duration } = play(setup);
  check("a game longer than the run is refused", checkGame(setup, log, duration, duration - 60000).reason === "too_long");
  const tampered = log.map((e) => [...e]);
  tampered[3][1] = tampered[2][1];
  check("a log that turns a card twice is refused", checkGame(setup, tampered, duration, duration + 5000).reason === "bad_flip");
  check("an unfinished game is refused", checkGame(setup, log.slice(0, -2), duration, duration + 5000).reason === "not_finished");
  const { state: played, log: log2, duration: duration2 } = play(setup);
  const result = checkGame(setup, log2, duration2, duration2 + 5000);
  check("the server's score matches the page's", result.result?.score === finalScores(played)[0].score, String(result.result?.score));
}

// Time limits.
{
  const setup = setupOf("easy", 3, 5);
  const state = createGame(setup);
  advance(state, 10000);
  check("an idle turn times out at its deadline", state.turnStart === 9000 && nextDeadline(state) === 12000);
  advance(state, gameLimitMs("easy", 5) + 1);
  check("the game limit ends the game exactly", state.phase === "over" && state.reason === "time" && state.endedAt === 40000);
  const slow = setupOf("expert", 0, 5);
  const { state: ran, log, duration } = play(slow, { memory: 0.5, gap: () => 2500 });
  const result = checkGame(slow, log, duration, duration + 5000);
  check("a game that runs out of time ends and still checks", ran.reason === "time" && result.reason === null, result.reason ?? "");
  check("running out earns no finishing bonus", result.result?.completion === 0 && result.result?.timeBonus === 0);
}

// Scores scale with difficulty and limits.
{
  const seedE = newSeed("easy", "food", byte);
  const base = { seed: seedE, turn: 0, limit: 0, players: ["A"] };
  const tight = { ...base, turn: 3, limit: 5 };
  const run = (setup) => {
    const state = createGame(setup);
    let t = 0;
    for (let i = 0; i < state.cards.length; i++) {
      if (state.status[i] !== 0) continue;
      t += 600;
      flip(state, i, t);
      t += 600;
      flip(state, state.partner[i], t);
    }
    return finalScores(state)[0].score;
  };
  const relaxed = run(base);
  const strict = run(tight);
  check("tighter limits score more for the same play", strict > relaxed, `${relaxed} -> ${strict}`);
  const hard = run({ ...base, seed: newSeed("expert", "food", byte) });
  check("a bigger board scores more", hard > relaxed, `${relaxed} -> ${hard}`);
}

// Party: leaving hands the turn on.
{
  const setup = { seed: newSeed("easy", "pets", byte), turn: 10, limit: 0, players: ["A", "B", "C"] };
  const state = createGame(setup);
  leave(state, 0, 100);
  check("leaving on your turn hands it on", state.current === 1);
  advance(state, 10100);
  check("a timeout skips players who left", state.current === 2);
}

// Replay links.
{
  const setup = { seed: newSeed("hard", "mixed", byte), turn: 5, limit: 8, players: ["Augy", "Ben"] };
  const log = [[0, 3], [812, 7], [1500, -1, 1], [2600, 9], [9000, -2, 1], [70000, 11]];
  const packed = packLog(log);
  check("a log packs and unpacks", JSON.stringify(unpackLog(packed)) === JSON.stringify(log), `${packed.length} chars`);
  const replay = cleanReplay({ v: 1, kind: "party", seed: setup.seed.text, turn: 5, limit: 8, players: setup.players, log });
  check("a replay cleans to itself", replay && replay.log.length === log.length && replay.seed === setup.seed.text);
  check("a damaged replay is refused", cleanReplay({ v: 1, kind: "solo", seed: "nope", log }) === null);
}

if (failed) {
  console.error(`\n${failed} failed.`);
  process.exit(1);
}
console.log("\nrules ok.");
