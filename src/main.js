import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** ===== 基础参数 ===== */
const DOOR_TARGET_HEIGHT_M = 2.10;
const PLACE_DISTANCE_M = 1.60;
const DOOR_SCALE_MULT = 0.90;
const DOOR_YAW_OFFSET = Math.PI / 2;

/** ===== 门洞估算（自动） ===== */
const HOLE_WIDTH_FACTOR = 0.56;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;
const HOLE_CENTER_Y_BIAS_M = 0.00;

/** 自动估算后的“放大量”（解决 mask 偏小） */
const MASK_OVERSCAN_W = 1.22;
const MASK_OVERSCAN_H = 1.12;

/** 穿门判定区比视觉门洞更宽一些（提升触发稳定性） */
const TRIGGER_OVERSCAN_W = 1.36;
const TRIGGER_OVERSCAN_H = 1.30;

/** 如果你想精确手调门洞，打开这个开关 */
const USE_MANUAL_HOLE = false;
const MANUAL_HOLE = {
  width: 1.25,   // 米
  height: 1.72,  // 米
  centerY: 0.96, // 米（门底为0）
};

/** ===== 穿门阈值与防抖 ===== */
const ENTER_THRESHOLD_M = 0.03;
const EXIT_THRESHOLD_M = 0.03;
const TRANSITION_COOLDOWN_MS = 650;

/** ===== 星云/星点 ===== */
const WINDOW_STAR_COUNT = 3500;
const INSIDE_STAR_COUNT = 9000;
const WINDOW_NEBULA_COUNT = 7;
const INSIDE_NEBULA_COUNT = 12;

/** ===== 图层 ===== */
const LAYER_MAIN = 0;   // 门框/reticle
const LAYER_MASK = 1;   // stencil 写入
const LAYER_PORTAL = 2; // 门洞窗口内容
const LAYER_INSIDE = 3; // 门内全屏世界

/** ===== 调试开关 ===== */
const SHOW_DEBUG = true;

let scene, renderer;
let baseCamera, controller;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let doorModel = null;
let doorGroup = null;
let doorVisualGroup = null;

let portalMaskMesh = null;
let portalContentGroup = null;
let insideGroup = null;

let placed = false;
let isInside = false;
let lastTransitionMs = 0;

let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;
let triggerW = 1.2;
let triggerH = 2.2;

const portalCenterWorld = new THREE.Vector3();
const portalBackDirWorld = new THREE.Vector3(0, 0, 1);
let prevSignedBackDist = 0;

let panoTexture = null;
let debugEl = null;

// temp
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

init();
animate();

function init() {
  scene = new THREE.Scene();

  baseCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    stencil: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  // light
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  // reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.12, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.layers.set(LAYER_MAIN);
  scene.add(reticle);

  controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  loadDoorGLB();

  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: document.body },
    })
  );

  createResetButton();
  if (SHOW_DEBUG) createDebugPanel();

  window.addEventListener("resize", onWindowResize);
}

function createResetButton() {
  const btn = document.createElement("button");
  btn.textContent = "Reset";
  btn.style.position = "fixed";
  btn.style.left = "12px";
  btn.style.top = "12px";
  btn.style.zIndex = "9999";
  btn.style.padding = "10px 12px";
  btn.style.borderRadius = "10px";
  btn.style.border = "1px solid rgba(255,255,255,0.6)";
  btn.style.background = "rgba(0,0,0,0.35)";
  btn.style.color = "white";
  btn.style.backdropFilter = "blur(6px)";
  btn.onclick = () => resetAll();
  document.body.appendChild(btn);
}

function createDebugPanel() {
  debugEl = document.createElement("div");
  debugEl.style.position = "fixed";
  debugEl.style.left = "12px";
  debugEl.style.bottom = "12px";
  debugEl.style.zIndex = "9999";
  debugEl.style.padding = "8px 10px";
  debugEl.style.borderRadius = "8px";
  debugEl.style.fontFamily = "monospace";
  debugEl.style.fontSize = "12px";
  debugEl.style.lineHeight = "1.4";
  debugEl.style.color = "#fff";
  debugEl.style.background = "rgba(0,0,0,0.45)";
  debugEl.textContent = "debug...";
  document.body.appendChild(debugEl);
}

function updateDebug(dist = 0, inOpening = false) {
  if (!debugEl) return;
  debugEl.textContent =
    `inside=${isInside} placed=${placed}\n` +
    `dist=${dist.toFixed(3)} inOpening=${inOpening}\n` +
    `hole=${holeW.toFixed(2)} x ${holeH.toFixed(2)} @y=${holeCenterY.toFixed(2)}\n` +
    `trigger=${triggerW.toFixed(2)} x ${triggerH.toFixed(2)}`;
}

function resetAll() {
  placed = false;
  isInside = false;
  prevSignedBackDist = 0;
  lastTransitionMs = 0;
  reticle.visible = false;

  if (doorGroup) scene.remove(doorGroup);
  if (insideGroup) scene.remove(insideGroup);

  doorGroup = null;
  doorVisualGroup = null;
  portalMaskMesh = null;
  portalContentGroup = null;
  insideGroup = null;
}

/* =========================
   模型
========================= */
function loadDoorGLB() {
  const loader = new GLTFLoader();
  loader.load(
    `${BASE}models/doorframe.glb`,
    (gltf) => {
      doorModel = gltf.scene;
      normalizeDoorModel(doorModel, DOOR_TARGET_HEIGHT_M);
    },
    undefined,
    (err) => console.error("Failed to load doorframe.glb", err)
  );
}

function normalizeDoorModel(model, targetHeightMeters) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!isFinite(size.y) || size.y <= 0) return;

  const scale = targetHeightMeters / size.y;
  model.scale.setScalar(scale);

  const box2 = new THREE.Box3().setFromObject(model);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);

  model.position.x += -center2.x;
  model.position.z += -center2.z;
  model.position.y += -box2.min.y;
}

function getPanoTexture() {
  if (panoTexture) return panoTexture;
  panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;
  return panoTexture;
}

/* =========================
   stencil helpers
========================= */
function setLayerRecursive(root, layer) {
  root.traverse((o) => {
    if (o.layers) o.layers.set(layer);
  });
}

function setMaskStencil(mat) {
  mat.colorWrite = false;
  mat.depthWrite = false;
  mat.depthTest = false;
  mat.side = THREE.DoubleSide;

  mat.stencilWrite = true;
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.AlwaysStencilFunc;
  mat.stencilFail = THREE.ReplaceStencilOp;
  mat.stencilZFail = THREE.ReplaceStencilOp;
  mat.stencilZPass = THREE.ReplaceStencilOp;
  mat.stencilWriteMask = 0xff;
  mat.stencilFuncMask = 0xff;
  mat.needsUpdate = true;
}

function setReadStencil(mat) {
  // three 的 stencil test 在材质层需要 stencilWrite=true 才生效
  mat.stencilWrite = true;
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.EqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
  mat.stencilWriteMask = 0x00; // 只读，不改写
  mat.stencilFuncMask = 0xff;
  mat.needsUpdate = true;
}

function applyStencilRead(root) {
  root.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) setReadStencil(m);
  });
}

function setXRCameraLayer(xrCam, layer) {
  xrCam.layers.set(layer);
  if (xrCam.isArrayCamera && xrCam.cameras) {
    for (const c of xrCam.cameras) c.layers.set(layer);
  }
}

/* =========================
   stars / nebula
========================= */
function makeStarSpriteTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");

  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.9)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.18)");
  grd.addColorStop(1.0, "rgba(255,255,255,0)");

  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStarFieldPoints(count = 4000, radius = 10, size = 0.095, depthTest = true) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.72 + 0.28 * Math.random());

    pos[i * 3 + 0] = r * s * Math.cos(t);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(t);
  }

  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  const mat = new THREE.PointsMaterial({
    map: makeStarSpriteTexture(),
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
    depthTest,
    size,
    sizeAttenuation: true,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function makeNebulaTexture(seed = 0) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, 256, 256);

  for (let i = 0; i < 12; i++) {
    const x = 128 + Math.sin(seed * 10 + i * 2.1) * 70;
    const y = 128 + Math.cos(seed * 7 + i * 1.6) * 70;
    const r = 60 + i * 10;

    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.10 - i * 0.005})`);
    g.addColorStop(0.55, `rgba(255,255,255,${0.04 - i * 0.002})`);
    g.addColorStop(1, "rgba(255,255,255,0)");

    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeNebulaBillboard(seed = 0, size = 6.0, depthTest = true) {
  const mat = new THREE.MeshBasicMaterial({
    map: makeNebulaTexture(seed),
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    depthTest,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.frustumCulled = false;
  return mesh;
}

/* =========================
   portal math
========================= */
function computePortalCenterWorld(out) {
  out.set(0, holeCenterY, 0);
  doorGroup.localToWorld(out);
  return out;
}

function initPortalBackDirection(xrCam) {
  doorGroup.getWorldQuaternion(_q1);

  const forward = _v1.set(0, 0, -1).applyQuaternion(_q1).normalize();
  portalBackDirWorld.copy(forward).multiplyScalar(-1); // back = +Z(local)

  computePortalCenterWorld(portalCenterWorld);
  xrCam.getWorldPosition(_v2);

  const d0 = _v2.sub(portalCenterWorld).dot(portalBackDirWorld);
  if (d0 > 0) portalBackDirWorld.multiplyScalar(-1); // 保证放门时在门前
}

function signedBackDistance(xrCam) {
  xrCam.getWorldPosition(_v1);
  computePortalCenterWorld(portalCenterWorld);
  return _v1.sub(portalCenterWorld).dot(portalBackDirWorld);
}

function cameraInDoorOpening(xrCam) {
  xrCam.getWorldPosition(_v1);
  doorGroup.worldToLocal(_v1);

  const halfW = triggerW * 0.5 + 0.06;
  const yMin = holeCenterY - triggerH * 0.5 - 0.12;
  const yMax = holeCenterY + triggerH * 0.5 + 0.20;

  return Math.abs(_v1.x) <= halfW && _v1.y >= yMin && _v1.y <= yMax;
}

/* =========================
   arch geometry
========================= */
function makeArchMaskGeometry(width, height) {
  const w = width;
  const h = height;
  const r = w * 0.5;
  const rectH = Math.max(0.01, h - r);

  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -rectH / 2);
  shape.lineTo(w / 2, -rectH / 2);
  shape.lineTo(w / 2, rectH / 2);
  shape.absarc(0, rectH / 2, r, 0, Math.PI, false);
  shape.lineTo(-w / 2, rectH / 2);
  shape.lineTo(-w / 2, -rectH / 2);

  return new THREE.ShapeGeometry(shape, 64);
}

/* =========================
   build scene objects
========================= */
function buildOnce() {
  if (doorGroup) return;

  doorGroup = new THREE.Group();
  doorGroup.layers.set(LAYER_MAIN);
  scene.add(doorGroup);

  // 只让视觉模型做 yaw 修正，避免影响 mask/portal plane
  doorVisualGroup = new THREE.Group();
  doorVisualGroup.rotation.y = DOOR_YAW_OFFSET;
  doorVisualGroup.scale.setScalar(DOOR_SCALE_MULT);
  doorVisualGroup.layers.set(LAYER_MAIN);
  doorGroup.add(doorVisualGroup);

  if (doorModel) {
    const m = doorModel.clone(true);
    setLayerRecursive(m, LAYER_MAIN);
    doorVisualGroup.add(m);
  } else {
    // fallback
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.7, metalness: 0.1 });
    const h = DOOR_TARGET_HEIGHT_M;
    const postW = 0.16;
    const spanW = 1.10;
    const depth = 0.12;

    const left = new THREE.Mesh(new THREE.BoxGeometry(postW, h, depth), mat);
    left.position.set(-spanW * 0.5 + postW * 0.5, h * 0.5, 0);

    const right = new THREE.Mesh(new THREE.BoxGeometry(postW, h, depth), mat);
    right.position.set(spanW * 0.5 - postW * 0.5, h * 0.5, 0);

    const top = new THREE.Mesh(new THREE.BoxGeometry(spanW, postW, depth), mat);
    top.position.set(0, h - postW * 0.5, 0);

    left.layers.set(LAYER_MAIN);
    right.layers.set(LAYER_MAIN);
    top.layers.set(LAYER_MAIN);

    doorVisualGroup.add(left, right, top);
  }

  // 估算门洞尺寸
  doorGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(doorVisualGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  if (USE_MANUAL_HOLE) {
    holeW = MANUAL_HOLE.width;
    holeH = MANUAL_HOLE.height;
    holeCenterY = MANUAL_HOLE.centerY;
  } else {
    const baseW = Math.max(0.85, size.x * HOLE_WIDTH_FACTOR);
    const baseH = Math.max(1.60, size.y * HOLE_HEIGHT_FACTOR);

    holeW = baseW * MASK_OVERSCAN_W;
    holeH = baseH * MASK_OVERSCAN_H;

    holeCenterY = size.y * HOLE_YCENTER_FACTOR + HOLE_CENTER_Y_BIAS_M;
    const minCY = holeH * 0.5;
    const maxCY = Math.max(minCY + 0.01, size.y - holeH * 0.45);
    holeCenterY = THREE.MathUtils.clamp(holeCenterY, minCY, maxCY);
  }

  triggerW = holeW * TRIGGER_OVERSCAN_W;
  triggerH = holeH * TRIGGER_OVERSCAN_H;

  // 1) mask（只写 stencil）
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial();
  setMaskStencil(maskMat);

  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(0, holeCenterY, -0.02); // 向用户侧微移，避免共面
  portalMaskMesh.layers.set(LAYER_MASK);
  portalMaskMesh.frustumCulled = false;
  doorGroup.add(portalMaskMesh);

  // 2) 门洞窗口内容（跟随 doorGroup）
  portalContentGroup = new THREE.Group();
  portalContentGroup.layers.set(LAYER_PORTAL);
  doorGroup.add(portalContentGroup);

  const pano = getPanoTexture();

  const windowSphereMat = new THREE.MeshBasicMaterial({
    map: pano,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
  setReadStencil(windowSphereMat);

  const windowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(10.5, 48, 36),
    windowSphereMat
  );
  windowSphere.position.set(0, holeCenterY, +6.3);
  windowSphere.layers.set(LAYER_PORTAL);
  portalContentGroup.add(windowSphere);

  const windowStars = makeStarFieldPoints(WINDOW_STAR_COUNT, 12.5, 0.095, true);
  windowStars.position.set(0, holeCenterY, +6.3);
  windowStars.layers.set(LAYER_PORTAL);
  setReadStencil(windowStars.material);
  portalContentGroup.add(windowStars);

  for (let i = 0; i < WINDOW_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(i * 0.41, 5.6 + Math.random() * 2.4, true);
    neb.position.set(
      (Math.random() - 0.5) * 3.8,
      holeCenterY + (Math.random() - 0.15) * 3.0,
      5.6 + Math.random() * 5.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_PORTAL);
    setReadStencil(neb.material);
    portalContentGroup.add(neb);
  }
  applyStencilRead(portalContentGroup);

  // 3) inside 全屏世界（进入后渲染）
  insideGroup = new THREE.Group();
  insideGroup.layers.set(LAYER_INSIDE);
  scene.add(insideGroup);

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(40.0, 64, 48),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  insideSphere.layers.set(LAYER_INSIDE);
  insideSphere.frustumCulled = false;
  insideSphere.renderOrder = 1000;
  insideGroup.add(insideSphere);

  const insideStars = makeStarFieldPoints(INSIDE_STAR_COUNT, 38.0, 0.11, false);
  insideStars.layers.set(LAYER_INSIDE);
  insideStars.renderOrder = 1001;
  insideGroup.add(insideStars);

  for (let i = 0; i < INSIDE_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(20 + i * 0.57, 8.0 + Math.random() * 5.0, false);
    neb.position.set(
      (Math.random() - 0.5) * 18.0,
      (Math.random() - 0.2) * 14.0,
      (Math.random() - 0.5) * 18.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_INSIDE);
    neb.renderOrder = 1002;
    insideGroup.add(neb);
  }
}

/* =========================
   interaction
========================= */
function onSelect() {
  if (placed || !reticle.visible) return;

  if (!doorGroup) buildOnce();

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 命中点（用于地面高度）
  const hitPos = _v1.setFromMatrixPosition(reticle.matrix);

  xrCam.getWorldPosition(_v2);
  xrCam.getWorldDirection(_v3);

  _v3.y = 0;
  if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, -1);
  _v3.normalize();

  const targetPos = _v2.clone().add(_v3.multiplyScalar(PLACE_DISTANCE_M));
  targetPos.y = hitPos.y;
  doorGroup.position.copy(targetPos);

  // 门朝向用户
  const lookAtPos = _v2.clone();
  lookAtPos.y = targetPos.y;
  doorGroup.lookAt(lookAtPos);

  initPortalBackDirection(xrCam);

  isInside = false;
  prevSignedBackDist = signedBackDistance(xrCam);
  lastTransitionMs = 0;

  placed = true;
  reticle.visible = false;
}

function updatePortalState(xrCam) {
  if (!placed || !doorGroup) return;

  const dist = signedBackDistance(xrCam);
  const inOpening = cameraInDoorOpening(xrCam);
  const now = performance.now();

  if (now - lastTransitionMs > TRANSITION_COOLDOWN_MS) {
    if (!isInside) {
      const crossedToBack = prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M;
      const failSafeEnter = inOpening && dist > 0.22; // 防止偶发漏触发
      if (inOpening && (crossedToBack || failSafeEnter)) {
        isInside = true;
        lastTransitionMs = now;
      }
    } else {
      const crossedToFront = prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M;
      const failSafeExit = inOpening && dist < -0.22;
      if (inOpening && (crossedToFront || failSafeExit)) {
        isInside = false;
        lastTransitionMs = now;
      }
    }
  }

  prevSignedBackDist = dist;
  if (SHOW_DEBUG) updateDebug(dist, inOpening);
}

/* =========================
   hit-test
========================= */
function updateHitTest(frame) {
  const session = renderer.xr.getSession();
  const referenceSpace = renderer.xr.getReferenceSpace();

  if (!hitTestSourceRequested) {
    session.requestReferenceSpace("viewer").then((viewerSpace) => {
      session.requestHitTestSource({ space: viewerSpace }).then((source) => {
        hitTestSource = source;
      });
    });

    session.addEventListener("end", () => {
      if (hitTestSource) {
        hitTestSource.cancel?.();
        hitTestSource = null;
      }
      hitTestSourceRequested = false;
      resetAll();
    });

    hitTestSourceRequested = true;
  }

  if (!hitTestSource) return;

  const hits = frame.getHitTestResults(hitTestSource);
  if (hits.length > 0) {
    const pose = hits[0].getPose(referenceSpace);
    reticle.visible = true;
    reticle.matrix.fromArray(pose.transform.matrix);
  } else {
    reticle.visible = false;
  }
}

/* =========================
   render
========================= */
function render(_, frame) {
  if (frame && !placed) updateHitTest(frame);

  const xrCam = renderer.xr.getCamera(baseCamera);

  if (placed) updatePortalState(xrCam);
  else if (SHOW_DEBUG) updateDebug(0, false);

  // 清屏（含 stencil）
  renderer.clear(true, true, true);

  // 主 pass：门框 + reticle
  setXRCameraLayer(xrCam, LAYER_MAIN);
  renderer.render(scene, xrCam);

  if (!placed) return;

  // 门外：写 stencil -> 画窗口
  if (!isInside && portalMaskMesh && portalContentGroup) {
    renderer.clear(false, false, true); // 只清 stencil

    setXRCameraLayer(xrCam, LAYER_MASK);
    renderer.render(scene, xrCam);

    setXRCameraLayer(xrCam, LAYER_PORTAL);
    renderer.render(scene, xrCam);
  }

  // 门内：全屏世界（持续）
  if (isInside && insideGroup) {
    xrCam.getWorldPosition(_v1);
    insideGroup.position.copy(_v1); // 跟随相机，保证一直包裹

    renderer.clearDepth(); // 避免主 pass 深度影响 inside
    setXRCameraLayer(xrCam, LAYER_INSIDE);
    renderer.render(scene, xrCam);
  }
}

function animate() {
  renderer.setAnimationLoop(render);
}

function onWindowResize() {
  baseCamera.aspect = window.innerWidth / window.innerHeight;
  baseCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
