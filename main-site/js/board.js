// The board on screen, in either view. The flat board is a grid of buttons
// that flip in CSS. The 3D board (js/board3d.js, three.js) draws the same
// cards on a table and is loaded only when needed. The pack decides which:
// a pack with 3D models is played in 3D, any other flat.
//
// The flat buttons are always there: in 3D they are invisible but still
// take keyboard focus and screen readers, and the 3D board shows which card
// has focus. So the keyboard and assistive tech work the same in both views.
//
// The board knows nothing about the rules. It is told the shape, which
// pictures it may show, and which cards are face up or matched, and it says
// which card somebody picked.

import { PACKS, isPack3d, tileLabel, tilePack } from "./rules.js";

export const tileImage = (tile) => `/tiles/${tile}.png`;
export const tileModel = (tile) => (PACKS[tilePack(tile)]?.models ? `/models/${tile}.glb` : null);

// Status per card: 0 face down, 1 face up, 2 matched.
export const DOWN = 0;
export const UP = 1;
export const MATCHED = 2;

// A wide board is turned on its side on a tall screen, so the cards stay a
// size a finger can hit. Card i stays card i; only where it sits moves.
// Decided by the window, not the board, whose own shape follows from this.
export function layoutFor(cols, rows) {
  const tall = window.innerHeight > window.innerWidth * 1.05;
  const turn = tall && cols > rows;
  return { cols: turn ? rows : cols, rows: turn ? cols : rows, turned: turn };
}

// Where card i sits in a layout, as { row, col }.
export function placeOf(i, shape, layout) {
  const row = Math.floor(i / shape.cols);
  const col = i % shape.cols;
  return layout.turned ? { row: col, col: row } : { row, col };
}

class FlatBoard {
  constructor(host, { onFlip, onFocus }) {
    this.host = host;
    this.onFlip = onFlip;
    this.onFocus = onFocus;
    this.grid = document.createElement("div");
    this.grid.className = "flat-board";
    this.grid.setAttribute("role", "grid");
    this.grid.setAttribute("aria-label", "Cards");
    host.append(this.grid);
    this.buttons = [];
    this.shown = [];
    this.shape = null;
    this.layout = null;

    this.grid.addEventListener("click", (e) => {
      const btn = e.target.closest(".mcard");
      if (btn && !btn.disabled) this.onFlip?.(Number(btn.dataset.i));
    });
    this.grid.addEventListener("focusin", (e) => {
      const btn = e.target.closest(".mcard");
      if (btn) this.onFocus?.(Number(btn.dataset.i));
    });
    this.grid.addEventListener("focusout", () => this.onFocus?.(-1));
    this.grid.addEventListener("keydown", (e) => this.onKey(e));
  }

  setup(shape) {
    this.shape = shape;
    this.grid.innerHTML = "";
    this.buttons = [];
    this.shown = new Array(shape.count).fill(null);
    for (let i = 0; i < shape.count; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mcard";
      btn.dataset.i = String(i);
      btn.tabIndex = i === 0 ? 0 : -1;
      btn.innerHTML = `<span class="mcard-inner"><span class="mcard-back" aria-hidden="true"><span class="mcard-mark">?</span></span><span class="mcard-face" aria-hidden="true"></span></span>`;
      this.grid.append(btn);
      this.buttons.push(btn);
    }
    this.relayout();
  }

  relayout() {
    if (!this.shape) return;
    this.layout = layoutFor(this.shape.cols, this.shape.rows);
    // On the board's host, which sizes itself to the layout's shape.
    const host = this.host.parentElement;
    host.style.setProperty("--cols", String(this.layout.cols));
    host.style.setProperty("--rows", String(this.layout.rows));
    this.buttons.forEach((btn, i) => {
      const { row, col } = placeOf(i, this.shape, this.layout);
      btn.style.gridRow = String(row + 1);
      btn.style.gridColumn = String(col + 1);
    });
  }

  render({ tiles, status, interactive }) {
    this.buttons.forEach((btn, i) => {
      const s = status[i];
      const tile = s === DOWN ? null : tiles[i];
      if (tile && this.shown[i] !== tile) {
        btn.querySelector(".mcard-face").innerHTML = `<img src="${tileImage(tile)}" alt="" draggable="false">`;
        this.shown[i] = tile;
      }
      // A card turned back loses its picture once the flip is over, so the
      // page holds no memory a player could look up instead of their own.
      if (s === DOWN && this.shown[i]) {
        this.shown[i] = null;
        setTimeout(() => {
          if (!this.shown[i] && !btn.classList.contains("up")) btn.querySelector(".mcard-face").innerHTML = "";
        }, 260);
      }
      btn.classList.toggle("up", s !== DOWN);
      btn.classList.toggle("matched", s === MATCHED);
      btn.disabled = !interactive;
      btn.setAttribute("aria-disabled", String(s !== DOWN));
      const name = tile ? tileLabel(tile) : null;
      btn.setAttribute(
        "aria-label",
        `Card ${i + 1}, ${s === MATCHED ? `${name}, matched` : s === UP ? name : "face down"}`
      );
    });
  }

  // A short animation on some cards: "match" pops, "miss" shakes.
  pulse(cards, kind) {
    for (const i of cards) {
      const btn = this.buttons[i];
      if (!btn) continue;
      btn.classList.remove("pulse-match", "pulse-miss");
      // Restart the animation if the class was already there.
      void btn.offsetWidth;
      btn.classList.add(`pulse-${kind}`);
    }
  }

  // Arrow keys move between cards as they are laid out, Home and End to the
  // first and last. Only one card is in the tab order at a time.
  onKey(e) {
    const btn = e.target.closest(".mcard");
    if (!btn || !this.layout) return;
    const i = Number(btn.dataset.i);
    const here = placeOf(i, this.shape, this.layout);
    let row = here.row;
    let col = here.col;
    if (e.key === "ArrowLeft") col -= 1;
    else if (e.key === "ArrowRight") col += 1;
    else if (e.key === "ArrowUp") row -= 1;
    else if (e.key === "ArrowDown") row += 1;
    else if (e.key === "Home") (row = 0), (col = 0);
    else if (e.key === "End") (row = this.layout.rows - 1), (col = this.layout.cols - 1);
    else return;
    e.preventDefault();
    row = Math.max(0, Math.min(this.layout.rows - 1, row));
    col = Math.max(0, Math.min(this.layout.cols - 1, col));
    const next = this.buttons.findIndex((_, j) => {
      const p = placeOf(j, this.shape, this.layout);
      return p.row === row && p.col === col;
    });
    if (next < 0) return;
    this.buttons.forEach((b, j) => (b.tabIndex = j === next ? 0 : -1));
    this.buttons[next].focus();
  }

  focusFirst() {
    (this.buttons.find((b) => b.tabIndex === 0) ?? this.buttons[0])?.focus();
  }
}

export class Board {
  // onFallback: called when a 3D pack has to be shown flat.
  constructor(host, { onFlip, onFallback }) {
    this.host = host;
    this.onFlip = onFlip;
    this.onFallback = onFallback;
    this.layer = document.createElement("div");
    this.layer.className = "board-layer";
    host.append(this.layer);
    this.flat = new FlatBoard(this.layer, { onFlip: (i) => this.onFlip?.(i), onFocus: (i) => this.three?.setFocus(i) });
    this.three = null;
    this.view = "flat";
    this.shape = null;
    this.last = null;
    this.loading = null;

    const resize = () => {
      this.flat.relayout();
      this.three?.relayout();
    };
    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(host);
    else window.addEventListener("resize", resize);
  }

  // "flat" or "3d". Resolves to the view actually showing: 3D falls back to
  // flat where WebGL or the library is not available.
  async setView(view) {
    this.view = view;
    if (view !== "3d") {
      this.three?.destroy();
      this.three = null;
      this.host.classList.remove("is-3d");
      return "flat";
    }
    if (this.three) return "3d";
    this.loading ??= import("./board3d.js")
      .then(({ Board3D }) => Board3D)
      .finally(() => {
        this.loading = null;
      });
    try {
      const Board3D = await this.loading;
      // Asked for flat again while loading.
      if (this.view !== "3d" || this.three) return this.three ? "3d" : "flat";
      this.three = new Board3D(this.host, { onFlip: (i) => this.onFlip?.(i) });
      this.host.classList.add("is-3d");
      if (this.shape) this.three.setup(this.shape);
      if (this.last) this.three.render(this.last);
      return "3d";
    } catch (err) {
      console.warn("3D board unavailable:", err);
      this.view = "flat";
      this.host.classList.remove("is-3d");
      this.onFallback?.();
      return "flat";
    }
  }

  // shape: { count, cols, rows, pack, tiles? } where the pack picks the view,
  // and tiles, when known, let the 3D board load its models before they are
  // needed.
  setup(shape) {
    this.shape = shape;
    this.last = null;
    this.flat.setup(shape);
    const view = isPack3d(shape.pack) ? "3d" : "flat";
    if (view === "3d" && this.three) {
      this.three.setup(shape);
      return;
    }
    this.setView(view);
  }

  render(state) {
    this.last = state;
    this.flat.render(state);
    this.three?.render(state);
  }

  pulse(cards, kind) {
    this.flat.pulse(cards, kind);
    this.three?.pulse(cards, kind);
  }

  focus() {
    this.flat.focusFirst();
  }
}
