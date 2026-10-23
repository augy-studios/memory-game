// Seeds: a short code that decides a game's board, so the same code deals
// the same cards again. Written "NM-BXK4-M9TR": the first letter is the
// difficulty, the second the picture pack, and the eight after the dash are
// the seed proper. The pack also decides flat or 3D, so a seed always plays
// in the view it was played in. Pure, so the API and Node can use it too.
//
// Integer arithmetic only. Math.random differs between browsers and would
// deal a different board on the server.

import { DIFFICULTIES, PACKS } from "./rules.js";

// No vowels, and no 0 O 1 I, as for pairing codes: a seed read aloud cannot
// be misheard and cannot spell a word.
export const ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
export const BODY_LENGTH = 8;

const DIFFICULTY_BY_LETTER = Object.fromEntries(Object.values(DIFFICULTIES).map((d) => [d.letter, d.id]));
const PACK_BY_LETTER = Object.fromEntries(Object.values(PACKS).map((p) => [p.letter, p.id]));

const isBody = (s) => s.length === BODY_LENGTH && [...s].every((c) => ALPHABET.includes(c));

function build(difficulty, pack, body) {
  const d = DIFFICULTIES[difficulty];
  const p = PACKS[pack];
  return {
    difficulty,
    pack,
    body,
    text: `${d.letter}${p.letter}-${body.slice(0, 4)}-${body.slice(4)}`,
  };
}

// A body from any source of random bytes: crypto.getRandomValues in the
// page, node:crypto on the server. Bytes at or above `limit` would make some
// characters likelier than others.
export function randomBody(nextByte) {
  const limit = 256 - (256 % ALPHABET.length);
  let body = "";
  while (body.length < BODY_LENGTH) {
    const byte = nextByte();
    if (byte < limit) body += ALPHABET[byte % ALPHABET.length];
  }
  return body;
}

const browserByte = () => globalThis.crypto.getRandomValues(new Uint8Array(1))[0];

export function newSeed(difficulty, pack, nextByte = browserByte) {
  return build(DIFFICULTIES[difficulty] ? difficulty : "normal", PACKS[pack] ? pack : "mixed", randomBody(nextByte));
}

// Whatever was typed or pasted, forgiving about case, spaces and dashes.
// Eight characters with no prefix take the difficulty and pack from
// `fallback`. null if it is not a seed.
export function parseSeed(input, fallback = {}) {
  const raw = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length === BODY_LENGTH + 2) {
    const difficulty = DIFFICULTY_BY_LETTER[raw[0]];
    const pack = PACK_BY_LETTER[raw[1]];
    const body = raw.slice(2);
    if (difficulty && pack && isBody(body)) return build(difficulty, pack, body);
    return null;
  }
  if (isBody(raw)) {
    return build(
      DIFFICULTIES[fallback.difficulty] ? fallback.difficulty : "normal",
      PACKS[fallback.pack] ? fallback.pack : "mixed",
      raw
    );
  }
  return null;
}
