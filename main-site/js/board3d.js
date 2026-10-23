// The 3D board: the same cards as the flat board, drawn with three.js as
// thick cards on a table that flip over. Packs with models (food, pets,
// holiday) stand a small 3D model on each face, turning slowly; the pets
// play their idle, happy and sad animations. Packs without models show
// their picture on the face.
//
// Loaded only when somebody picks the 3D view (js/board.js imports this
// file on demand). three.js is vendored under /vendor/three and mapped by
// the import map in index.html, so it is precached and works offline.
//
// Input: a tap or click picks the card under it, through a raycast. The
// flat board's buttons stay underneath, invisible, for the keyboard and
// screen readers; whichever has focus is ringed here.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { DOWN, MATCHED, layoutFor, placeOf, tileImage, tileModel } from "./board.js";
import { reducedMotion } from "./ui.js";

const CARD = 1;
const GAP = 0.16;
const THICK = 0.07;
const FLIP_MS = 380;
const LIFT = 0.45;
const SINK = -0.03; // a matched card settles into the table a little
// The camera looks down at the table from this far above the horizon.
const ELEVATION = (58 * Math.PI) / 180;
const FOV = 30;
const SPIN = 0.6; // radians a second, for a model on a face-up card

/* ---- colours, from the theme's own tokens ---- */

const probe = document.createElement("canvas");
probe.width = probe.height = 1;
const probeCtx = probe.getContext("2d", { willReadFrequently: true });

// Any CSS colour, var() and color-mix() included, as a three.js colour.
// The browser resolves it on an element, and a 1x1 canvas turns whatever
// colour syntax that gives back into plain sRGB bytes.
function themeColor(expression) {
  const el = document.createElement("span");
  el.style.display = "none";
  el.style.color = expression;
  document.body.append(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = "#000";
  probeCtx.fillStyle = resolved;
  probeCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
  return { three: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), css: `rgb(${r}, ${g}, ${b})` };
}

/* ---- models, loaded once per page and cloned per card ---- */

const loader = new GLTFLoader();
const models = new Map(); // url -> Promise<gltf>
const textures = new Map(); // url -> texture

function loadModel(url) {
  if (!models.has(url)) models.set(url, loader.loadAsync(url));
  return models.get(url);
}

function loadPicture(url) {
  if (!textures.has(url)) {
    const texture = new THREE.TextureLoader().load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    textures.set(url, texture);
  }
  return textures.get(url);
}

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

export class Board3D {
  constructor(host, { onFlip }) {
    this.host = host;
    this.onFlip = onFlip;
    this.cards = [];
    this.shape = null;
    this.layout = null;
    this.interactive = false;
    this.focused = -1;
    this.hovered = -1;
    this.frame = null;
    this.lastTime = 0;
    this.destroyed = false;

    // Throws where WebGL is unavailable; js/board.js falls back to flat.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "board-canvas";
    // The flat buttons underneath are what assistive tech reads.
    this.canvas.setAttribute("aria-hidden", "true");
    host.append(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9a90, 2.2));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.position.set(-3, 9, 5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);

    this.table = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.16 }));
    this.table.rotation.x = -Math.PI / 2;
    this.table.position.y = -THICK / 2 - 0.001;
    this.table.receiveShadow = true;
    this.scene.add(this.table);

    this.bodyGeometry = new RoundedBoxGeometry(CARD, THICK, CARD, 2, 0.06);
    this.faceGeometry = new THREE.PlaneGeometry(CARD * 0.9, CARD * 0.9);
    this.ringGeometry = new THREE.PlaneGeometry(CARD + 0.16, CARD + 0.16);
    this.backCanvas = document.createElement("canvas");
    this.backCanvas.width = this.backCanvas.height = 256;
    this.backTexture = new THREE.CanvasTexture(this.backCanvas);
    this.backTexture.colorSpace = THREE.SRGBColorSpace;
    this.materials = {
      edge: new THREE.MeshStandardMaterial({ roughness: 0.7 }),
      matchedEdge: new THREE.MeshStandardMaterial({ roughness: 0.7 }),
      back: new THREE.MeshStandardMaterial({ map: this.backTexture, roughness: 0.8 }),
      face: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
      ring: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
    };
    this.refreshColors();
    // The Jua "?" on the backs, once the font is ready.
    document.fonts?.load?.('150px "Jua"').then(() => this.refreshColors(), () => {});

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.down = null;
    this.canvas.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("pointerleave", () => this.setHover(-1));

    // The theme's swatch and mode, as they change.
    this.themeWatch = new MutationObserver(() => this.refreshColors());
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-color-theme", "style"] });
    this.onVisible = () => {
      if (document.visibilityState === "visible") this.kick();
    };
    document.addEventListener("visibilitychange", this.onVisible);
  }

  refreshColors() {
    const brand = themeColor("var(--brand)");
    const onBrand = themeColor("var(--on-brand)");
    const edge = themeColor("color-mix(in srgb, var(--brand) 70%, var(--on-brand))");
    this.materials.edge.color.copy(themeColor("color-mix(in srgb, var(--brand) 82%, var(--on-brand))").three);
    this.materials.matchedEdge.color.copy(edge.three);
    this.materials.face.color.copy(themeColor("var(--card-face)").three);
    this.materials.ring.color.copy(themeColor("var(--brand-ink)").three);

    const ctx = this.backCanvas.getContext("2d");
    ctx.fillStyle = brand.css;
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = edge.css;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.roundRect(22, 22, 212, 212, 26);
    ctx.stroke();
    ctx.fillStyle = onBrand.css;
    ctx.font = '150px "Jua", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", 128, 138);
    this.backTexture.needsUpdate = true;
    this.draw();
  }

  setup(shape) {
    for (const card of this.cards) this.scene.remove(card.group);
    this.cards = [];
    this.shape = shape;
    for (let i = 0; i < shape.count; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeometry, this.materials.edge);
      body.castShadow = true;
      body.receiveShadow = true;
      const back = new THREE.Mesh(this.faceGeometry, this.materials.back);
      back.rotation.x = -Math.PI / 2;
      back.position.y = THICK / 2 + 0.002;
      const face = new THREE.Mesh(this.faceGeometry, this.materials.face);
      face.rotation.x = Math.PI / 2;
      face.position.y = -THICK / 2 - 0.002;
      // Upside down under the card, so it stands upright once flipped.
      const holder = new THREE.Group();
      holder.position.y = -THICK / 2;
      holder.rotation.x = Math.PI;
      for (const mesh of [body, back, face]) mesh.userData.card = i;
      group.add(body, back, face, holder);

      const ring = new THREE.Mesh(this.ringGeometry, this.materials.ring);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -THICK / 2;
      ring.visible = false;

      this.scene.add(group, ring);
      this.cards.push({ group, body, face, holder, ring, tile: null, model: null, mixer: null, actions: null, status: DOWN, flip: 0, anim: null, spin: Math.random() * Math.PI * 2 });
    }
    this.relayout();
    // Models for the board, ahead of anybody turning a card over.
    for (const tile of new Set(shape.tiles ?? [])) {
      const url = tile && tileModel(tile);
      if (url) loadModel(url).catch(() => {});
    }
  }

  relayout() {
    if (!this.shape) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.layout = layoutFor(this.shape.cols, this.shape.rows);
    const step = CARD + GAP;
    this.cards.forEach((card, i) => {
      const { row, col } = placeOf(i, this.shape, this.layout);
      const x = (col - (this.layout.cols - 1) / 2) * step;
      const z = (row - (this.layout.rows - 1) / 2) * step;
      card.group.position.x = x;
      card.group.position.z = z;
      card.ring.position.x = x;
      card.ring.position.z = z;
    });

    // Just far enough back that every corner of the table, with a card
    // lifted mid-flip and a model standing on the far row, is on screen. A
    // perspective camera sees the near row wider than the far one, so this
    // is found by projecting the corners rather than by a formula.
    const boardW = this.layout.cols * step;
    const boardD = this.layout.rows * step;
    const corners = [];
    for (const x of [-boardW / 2, boardW / 2]) {
      for (const z of [-boardD / 2, boardD / 2]) {
        corners.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, LIFT + 0.2, z));
      }
    }
    const place = (dist) => {
      this.camera.position.set(0, dist * Math.sin(ELEVATION), dist * Math.cos(ELEVATION));
      this.camera.lookAt(0, 0.15, 0);
      this.camera.updateMatrixWorld();
    };
    const fits = (dist) => {
      place(dist);
      return corners.every((c) => {
        const p = c.clone().project(this.camera);
        return Math.abs(p.x) <= 0.96 && Math.abs(p.y) <= 0.96;
      });
    };
    this.camera.updateProjectionMatrix();
    let near = 1;
    let far = 200;
    for (let i = 0; i < 30; i++) {
      const mid = (near + far) / 2;
      if (fits(mid)) far = mid;
      else near = mid;
    }
    place(far);

    const cam = this.sun.shadow.camera;
    cam.left = -boardW;
    cam.right = boardW;
    cam.top = boardD;
    cam.bottom = -boardD;
    cam.far = 40;
    cam.updateProjectionMatrix();
    this.draw();
  }

  render({ tiles, status, interactive }) {
    this.interactive = interactive;
    this.canvas.style.cursor = interactive ? "pointer" : "default";
    const now = performance.now();
    this.cards.forEach((card, i) => {
      const s = status[i];
      const tile = tiles[i];
      if (tile && card.tile !== tile && s !== DOWN) this.dress(card, tile);
      if (s !== card.status) {
        const wasDown = card.status === DOWN;
        card.status = s;
        const target = s === DOWN ? 0 : 1;
        if (target !== card.flip || (wasDown && s !== DOWN)) this.animate(card, target, now);
        card.body.material = s === MATCHED ? this.materials.matchedEdge : this.materials.edge;
        if (s !== DOWN) this.playClip(card, "idle", true);
      }
    });
    if (this.hovered >= 0 && !interactive) this.setHover(-1);
    this.kick();
  }

  // Puts a tile's picture or model on a card's face.
  dress(card, tile) {
    card.tile = tile;
    if (card.model) {
      card.holder.clear();
      card.model = null;
      card.mixer = null;
      card.actions = null;
    }
    const url = tileModel(tile);
    if (!url) {
      card.face.material = new THREE.MeshStandardMaterial({ map: loadPicture(tileImage(tile)), roughness: 0.9 });
      return;
    }
    card.face.material = this.materials.face;
    loadModel(url)
      .then((gltf) => {
        if (this.destroyed || card.tile !== tile) return;
        const skinned = gltf.animations?.length > 0;
        const model = skinned ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.userData.card = this.cards.indexOf(card);
          }
        });
        // Fit the model to the card: a little narrower than the face, and
        // standing on it.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = Math.min((0.66 * CARD) / Math.max(size.x, size.z, 1e-3), (0.8 * CARD) / Math.max(size.y, 1e-3));
        model.scale.setScalar(scale);
        box.setFromObject(model);
        const centre = box.getCenter(new THREE.Vector3());
        model.position.set(-centre.x, -box.min.y + 0.004, -centre.z);
        const spinner = new THREE.Group();
        spinner.add(model);
        spinner.rotation.y = card.spin;
        card.holder.add(spinner);
        card.model = spinner;
        if (skinned) {
          card.mixer = new THREE.AnimationMixer(model);
          card.actions = Object.fromEntries(gltf.animations.map((clip) => [clip.name, card.mixer.clipAction(clip)]));
          card.mixer.addEventListener("finished", () => this.playClip(card, "idle", true));
          if (card.status !== DOWN) this.playClip(card, "idle", true);
        }
        this.kick();
      })
      .catch(() => {
        // No model: the picture instead, so the card can still be matched.
        if (card.tile === tile) card.face.material = new THREE.MeshStandardMaterial({ map: loadPicture(tileImage(tile)), roughness: 0.9 });
        this.kick();
      });
  }

  playClip(card, name, loop) {
    const action = card.actions?.[name];
    if (!action || reducedMotion()) return;
    const current = Object.values(card.actions).find((a) => a.isRunning());
    if (current === action && loop) return;
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    if (current && current !== action) action.crossFadeFrom(current, 0.2, false);
    action.play();
    this.kick();
  }

  animate(card, target, now) {
    if (reducedMotion()) {
      card.flip = target;
      card.anim = null;
      this.pose(card);
      return;
    }
    card.anim = { from: card.flip, to: target, start: now };
  }

  pose(card) {
    card.group.rotation.x = card.flip * Math.PI;
    // Face down, the model is under the card and would poke out of its edges.
    card.holder.visible = card.flip > 0.02;
    const lift = card.anim ? LIFT * Math.sin(Math.PI * ease(Math.min(1, (performance.now() - card.anim.start) / FLIP_MS))) : 0;
    const hover = this.hovered === this.cards.indexOf(card) && card.status === DOWN ? 0.05 : 0;
    card.group.position.y = lift + hover + (card.status === MATCHED && !card.anim ? SINK : 0);
  }

  // "match" makes the models hop (the pets cheer), "miss" makes the pets sulk.
  pulse(cards, kind) {
    for (const i of cards) {
      const card = this.cards[i];
      if (!card) continue;
      if (card.actions) this.playClip(card, kind === "match" ? "gesture-positive" : "gesture-negative", false);
      else if (kind === "match" && !reducedMotion()) card.hop = performance.now();
    }
    this.kick();
  }

  setFocus(i) {
    this.focused = i;
    this.cards.forEach((card, j) => (card.ring.visible = j === i));
    this.draw();
  }

  setHover(i) {
    if (this.hovered === i) return;
    this.hovered = i;
    this.kick();
  }

  pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.cards.map((c) => c.group), true).find((h) => h.object.userData.card !== undefined);
    return hit ? hit.object.userData.card : -1;
  }

  onPointerUp(e) {
    const down = this.down;
    this.down = null;
    // A drag, or a pinch, is not a tap.
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10 || !this.interactive) return;
    const i = this.pick(e);
    if (i >= 0 && this.cards[i].status === DOWN) this.onFlip?.(i);
  }

  onPointerMove(e) {
    if (e.pointerType !== "mouse" || !this.interactive) return;
    const i = this.pick(e);
    this.setHover(i >= 0 && this.cards[i].status === DOWN ? i : -1);
  }

  // Runs the loop while anything moves: a flip, a hop, a model turning on a
  // face-up card, an animation. Otherwise draws once and stops.
  kick() {
    if (this.frame !== null || this.destroyed) return;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  tick(now) {
    this.frame = null;
    if (this.destroyed || document.visibilityState === "hidden") return;
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const still = reducedMotion();
    let moving = false;

    for (const card of this.cards) {
      if (card.anim) {
        const p = Math.min(1, (now - card.anim.start) / FLIP_MS);
        card.flip = card.anim.from + (card.anim.to - card.anim.from) * ease(p);
        if (p >= 1) {
          card.flip = card.anim.to;
          card.anim = null;
        } else moving = true;
      }
      this.pose(card);
      if (card.hop) {
        const p = (now - card.hop) / 500;
        if (p >= 1) card.hop = 0;
        else {
          card.group.position.y += 0.25 * Math.sin(Math.PI * p);
          moving = true;
        }
      }
      if (card.model && card.status !== DOWN && !still) {
        card.spin += SPIN * dt;
        card.model.rotation.y = card.spin;
        moving = true;
      }
      if (card.mixer && card.status !== DOWN) {
        card.mixer.update(dt);
        moving = true;
      }
    }
    this.renderer.render(this.scene, this.camera);
    if (moving) this.kick();
  }

  draw() {
    if (this.frame === null && !this.destroyed) this.kick();
  }

  destroy() {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.themeWatch.disconnect();
    document.removeEventListener("visibilitychange", this.onVisible);
    this.scene.traverse((o) => {
      if (o.isMesh && o.material?.map && !o.material.map.isCanvasTexture && o.material !== this.materials.back) o.material.dispose();
    });
    for (const m of Object.values(this.materials)) m.dispose();
    this.bodyGeometry.dispose();
    this.faceGeometry.dispose();
    this.ringGeometry.dispose();
    this.backTexture.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
