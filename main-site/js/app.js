import { COLOR_THEMES, applyColorTheme, applyMode, getStoredColorTheme, getStoredMode, getModePreference, initTheme } from "./theme.js";
import { closeModal, closeTopModal, currentView, hydrateIcons, openModal, showView } from "./ui.js";
import { initUpdateBar } from "./update-bar.js";
import { Board } from "./board.js";
import { backToResult, initGame, pause, playSeed, toSetup } from "./game.js";
import { initLeaderboard, openLeaderboard } from "./leaderboard.js";
import { initSettings, openSettings } from "./settings.js";
import { initParty, inParty, openParty, resumeParty } from "./party.js";
import { ReplayPlayer, replayFromLocation } from "./replay.js";
import { initFullscreen } from "./fullscreen.js";

/* Theme modal, per uwuapps-theme.md section 6. */

function buildThemeModal() {
  const grid = document.getElementById("swatchGrid");
  grid.innerHTML = COLOR_THEMES.map(
    (t) => `
      <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
        <span class="swatch-dot"></span>
        <span class="swatch-label">${t.label}</span>
      </button>`
  ).join("");

  syncThemeModalState();

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-id]");
    if (!btn) return;
    applyColorTheme(btn.dataset.themeId);
    syncThemeModalState();
  });

  document.getElementById("modeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    applyMode(btn.dataset.mode);
    syncThemeModalState();
  });

  // A tab left open across 09:00 or 18:00 re-resolves itself; redraw the
  // modal so the note and pressed state stay in step with the change.
  document.addEventListener("uwu:modechange", syncThemeModalState);
}

function syncThemeModalState() {
  const activeTheme = getStoredColorTheme();
  const activePreference = getModePreference();
  const resolvedMode = getStoredMode();

  document.querySelectorAll("#swatchGrid .swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeId === activeTheme);
  });
  document.querySelectorAll("#modeToggle .mode-btn").forEach((el) => {
    const isActive = el.dataset.mode === activePreference;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });

  const note = document.getElementById("modeNote");
  if (note) {
    note.hidden = activePreference !== "time";
    if (activePreference === "time") {
      note.textContent = `Following the clock. Currently ${resolvedMode}.`;
    }
  }

  updateThemeButtonIcon();
}

function updateThemeButtonIcon() {
  const span = document.querySelector("#themeBtn [data-icon]");
  span.setAttribute("data-icon", getStoredMode() === "dark" ? "moon" : "sun");
  hydrateIcons(document.getElementById("themeBtn"));
}

function wireModals() {
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener("keydown", (e) => {
    // Handled, so nothing else takes the same Esc.
    if (e.key === "Escape" && closeTopModal()) e.preventDefault();
  });

  // Every window stops a solo game's clock first. Closing it leaves the
  // game paused, so the board is not studied behind a window.
  const pausing = (open) => () => {
    pause();
    open();
  };
  document.getElementById("themeBtn").addEventListener("click", pausing(() => openModal("themeModal")));
  document.getElementById("boardBtn").addEventListener("click", pausing(() => openLeaderboard()));
  document.getElementById("settingsBtn").addEventListener("click", pausing(openSettings));
  document.getElementById("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  document.getElementById("setupSettingsBtn").addEventListener("click", openSettings);
}

function goHome() {
  pause();
  toSetup();
}

function boot() {
  initTheme();
  hydrateIcons();
  updateThemeButtonIcon();
  buildThemeModal();
  wireModals();
  initFullscreen();
  initLeaderboard();
  initSettings();

  // The pack picks the view. Where 3D cannot run, a 3D pack plays flat and
  // the new game card says so.
  const board = new Board(document.getElementById("boardHost"), {
    onFlip: null,
    onFallback: () => {
      document.getElementById("viewNote").textContent = "3D is not available in this browser, so 3D packs play flat.";
    },
  });

  const replayer = new ReplayPlayer({
    board,
    onPlaySeed: (seed) => {
      history.replaceState(null, "", "/");
      playSeed(seed);
    },
    onClose: (back) => {
      if (back === "result" && backToResult()) return;
      if (back === "party" && inParty()) {
        openParty();
        return;
      }
      toSetup();
    },
  });

  initGame({ board, replayer });
  initParty({ board, replayer });
  document.getElementById("partyBtn").addEventListener("click", () => {
    pause();
    openParty();
  });
  document.getElementById("setupPartyBtn").addEventListener("click", openParty);
  document.getElementById("homeBtn").addEventListener("click", goHome);
  document.addEventListener("memy:home", goHome);

  // A replay link or a join link opens on that; a host's party in this tab
  // carries on; otherwise the new game card.
  const link = replayFromLocation();
  if (link) replayer.open(link.id ? { id: link.id } : link, { verified: false });
  else if (!resumeParty()) {
    toSetup();
    showView("setup");
  }
  if (currentView() === "setup") document.getElementById("startBtn").focus({ preventScroll: true });

  initUpdateBar();
}

boot();
