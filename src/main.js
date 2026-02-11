import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/* =========================
   基础参数
========================= */
const DOOR_TARGET_HEIGHT_M = 2.10;
const PLACE_DISTANCE_M = 1.60;
const DOOR_SCALE_MULT = 0.90;
const DOOR_YAW_OFFSET = Math.PI / 2;

/* =========================
   门洞参数（建议先手动）
========================= */
const USE_MANUAL_HOLE = true;
const MANUAL_HOLE = {
  width: 1.48,   // 门洞宽：调大=更宽
  height: 1.52,  // 门洞高：调大=更高
  centerY: 0.88, // 门洞中心Y：调大=上移
  offsetX: 0.00, // 左右微调
  offsetY: 0.00, // 上下微调（叠加到centerY）
};

// 自动估算备用（USE_MANUAL_HOLE=false时生效）
const HOLE_WIDTH_FACTOR = 0.60;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.50;
const MASK_OVERSCAN_W = 1.16;
const MASK_OVERSCAN_H = 1.06;

/* =========================
   过门判定参数（稳定切换）
========================= */
const ENTER_THRESHOLD_M = 0.02; // 进入阈值
const EXIT_THRESHOLD_M = 0.12;  // 退出阈值（滞回，防抖）
const FORCE_ENTER_M = 0.30;     // 兜底进入
const FORCE_EXIT_M = 0.30;      // 兜底退出
const TRANSITION_COOLDOWN_MS = 650;
const CROSSING_Z_GATE_M = 1.4;  // 必须在门平面附近才允许切换

/* =========================
   门外预览 & 门内世界
========================= */
const PREVIEW_CENTER_DISTANCE_M = 6.4; // 预览球在“门后”6.4m
const PREVIEW_RADIUS_M = 12.0;         // 保证门前相机也在球内，避免“圆盘感”

const INSIDE_RADIUS_M = 70.0;          // 门内沉浸球半径（大）
const INSIDE_STAR_COUNT = 9000;
const PREVIEW_STAR_COUNT = 3200;
const INSIDE_NEBULA_COUNT = 12;
const PREVIEW_NEBULA_COUNT = 7;

/* =========================
   图层
========================= */
const LAYER_MAIN = 0;    // 门框 + reticle
const LAYER_MASK = 1;    // stencil写入mask
const LAYER_PREVIEW = 2; // 门外预览内容（受stencil）
const LAYER_INSIDE = 3;  // 门内沉浸世界

/* =========================
   调试
========================= */
const SHOW_DEBUG = false;

/* =========================
   全局状态
========================= */
let scene, renderer;
let baseCamera, controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let doorModel = null;
let doorGroup = null;
let doorVisualGroup = null;

let portalMaskMesh = null;
let portalPreviewRoot = null;
let insideWorldRoot = null;

let placed = false;
let isInside = false;
let lastTransitionMs = 0;

// 以放门时相机所在侧作为“门前”
let frontSign = 1;
let prevSignedFrontDist = 0;

// 门洞参数
let holeW = 1.2;
let holeH = 1.8;
let holeCenterY = 0.9;
let holeOffsetX = 0;
let holeOffsetY = 0;

let panoTexture = null;
let debugEl = null;

// temp
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

init();
animate();

/* =========================
   init
========================= */
function init() {
  scene = new THREE.Scene();

  baseCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 120);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    stencil: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;
  renderer.xr.enabled = true;
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
  btn.style.color = "#fff";
  btn.style.backdropFilter = "blur(6px)";
  btn.onclick = resetAll;
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
  debugEl.style.lineHeight = "1.35";
  debugEl.style.color = "#fff";
  debugEl.style.background = "rgba(0,0,0,0.45)";
  debugEl.textContent = "debug...";
  document.body.appendChild(debugEl);
}

function updateDebug(localCam, signedFrontDist, gate) {
  if (!debugEl) return;
  debugEl.textContent =
    `inside=${isInside} placed=${placed}\n` +
    `frontSign=${frontSign} signed=${signedFrontDist.toFixed(3)} gate=${gate}\n` +
    `local=(${localCam.x.toFixed(2)}, ${localCam.y.toFixed(2)}, ${localCam.z.toFixed(2)})\n` +
    `hole=${holeW.toFixed(2)} x ${holeH.toFixed(2)} @y=${holeCenterY.toFixed(2)}`;
}

function resetAll() {
  placed = false;
  isInside = false;
  lastTransitionMs = 0;
  frontSign = 1;
  prevSignedFrontDist = 0;
  reticle.visible = false;

  if (doorGroup) scene.remove(doorGroup);
  if (insideWorldRoot) scene.remove(insideWorldRoot);

  doorGroup = null;
  doorVisualGroup = null;
  portalMaskMesh = null;
  portalPreviewRoot = null;
  insideWorldRoot = null;
}

/* =========================
   模型加载
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

/* =========================
   纹理
========================= */
function getPanoTexture() {
  if (panoTexture) return panoTexture;
  panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;
  panoTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return panoTexture;
}

/* =========================
   stencil helpers
========================= */
function setLayerRecursive(root, layer) {
  root.traverse((o) => o.layers && o.layers.set(layer));
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
  // three中材质级 stencil test 需要 stencilWrite=true 才会应用
  mat.stencilWrite = true;
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.EqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
  mat.stencilWriteMask = 0x00; // 只读不写
  mat.stencilFuncMask = 0xff;
  mat.needsUpdate = true;
}

function applyStencilRead(root) {
  root.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(setReadStencil);
  });
}

function setXRCameraLayer(xrCam, layer) {
  xrCam.layers.set(layer);
  if (xrCam.isArrayCamera && xrCam.cameras) {
    for (const c of xrCam.cameras) c.layers.set(layer);
  }
}

/* =========================
   星空
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

function makeStarField(count = 4000, radius = 10, size = 0.1, depthTest = true) {
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

function makeNebula(seed = 0, size = 6.0, depthTest = true) {
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
   门洞shape
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
   构建内容
========================= */
function buildOnce() {
  if (doorGroup) return;

  doorGroup = new THREE.Group();
  doorGroup.layers.set(LAYER_MAIN);
  scene.add(doorGroup);

  // 视觉模型层：yaw修正只作用这里
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
    // fallback门框
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      roughness: 0.7,
      metalness: 0.1,
    });
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

  // 计算门洞参数
  doorGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(doorVisualGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  if (USE_MANUAL_HOLE) {
    holeW = MANUAL_HOLE.width;
    holeH = MANUAL_HOLE.height;
    holeCenterY = MANUAL_HOLE.centerY;
    holeOffsetX = MANUAL_HOLE.offsetX ?? 0;
    holeOffsetY = MANUAL_HOLE.offsetY ?? 0;
  } else {
    const baseW = Math.max(0.90, size.x * HOLE_WIDTH_FACTOR);
    const baseH = Math.max(1.55, size.y * HOLE_HEIGHT_FACTOR);
    holeW = baseW * MASK_OVERSCAN_W;
    holeH = baseH * MASK_OVERSCAN_H;
    holeCenterY = size.y * HOLE_YCENTER_FACTOR;
    holeOffsetX = 0;
    holeOffsetY = 0;
  }

  // 1) stencil mask
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial();
  setMaskStencil(maskMat);

  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(holeOffsetX, holeCenterY + holeOffsetY, -0.01);
  portalMaskMesh.layers.set(LAYER_MASK);
  portalMaskMesh.frustumCulled = false;
  doorGroup.add(portalMaskMesh);

  // 2) 门外预览（受stencil）
  portalPreviewRoot = new THREE.Group();
  portalPreviewRoot.layers.set(LAYER_PREVIEW);
  doorGroup.add(portalPreviewRoot);

  const pano = getPanoTexture();

  const previewSphereMat = new THREE.MeshBasicMaterial({
    map: pano,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
  setReadStencil(previewSphereMat);

  const previewSphere = new THREE.Mesh(
    new THREE.SphereGeometry(PREVIEW_RADIUS_M, 56, 42),
    previewSphereMat
  );
  previewSphere.layers.set(LAYER_PREVIEW);
  previewSphere.frustumCulled = false;
  portalPreviewRoot.add(previewSphere);

  const previewStars = makeStarField(PREVIEW_STAR_COUNT, PREVIEW_RADIUS_M * 0.92, 0.095, true);
  previewStars.layers.set(LAYER_PREVIEW);
  setReadStencil(previewStars.material);
  portalPreviewRoot.add(previewStars);

  for (let i = 0; i < PREVIEW_NEBULA_COUNT; i++) {
    const neb = makeNebula(i * 0.41, 4.8 + Math.random() * 2.2, true);
    neb.position.set(
      (Math.random() - 0.5) * 8.0,
      (Math.random() - 0.35) * 5.0,
      (Math.random() - 0.5) * 8.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_PREVIEW);
    setReadStencil(neb.material);
    portalPreviewRoot.add(neb);
  }

  applyStencilRead(portalPreviewRoot);

  // 3) 门内沉浸世界（进入后只渲染这一层）
  insideWorldRoot = new THREE.Group();
  insideWorldRoot.layers.set(LAYER_INSIDE);
  scene.add(insideWorldRoot);

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(INSIDE_RADIUS_M, 64, 48),
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
  insideWorldRoot.add(insideSphere);

  const insideStars = makeStarField(INSIDE_STAR_COUNT, INSIDE_RADIUS_M * 0.90, 0.11, false);
  insideStars.layers.set(LAYER_INSIDE);
  insideStars.renderOrder = 1001;
  insideWorldRoot.add(insideStars);

  for (let i = 0; i < INSIDE_NEBULA_COUNT; i++) {
    const neb = makeNebula(20 + i * 0.53, 8 + Math.random() * 5, false);
    neb.position.set(
      (Math.random() - 0.5) * 40,
      (Math.random() - 0.2) * 24,
      (Math.random() - 0.5) * 40
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_INSIDE);
    neb.renderOrder = 1002;
    insideWorldRoot.add(neb);
  }
}

function updatePreviewAnchorByFrontSign() {
  if (!portalPreviewRoot) return;
  const backSign = -frontSign; // 与放门时用户侧相反的一侧 = 门后
  portalPreviewRoot.position.set(
    holeOffsetX,
    holeCenterY + holeOffsetY,
    backSign * PREVIEW_CENTER_DISTANCE_M
  );
}

/* =========================
   交互：放门
========================= */
function onSelect() {
  if (placed || !reticle.visible) return;

  if (!doorGroup) buildOnce();

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 命中点用于地面高度
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

  // 确定“门前侧”符号
  xrCam.getWorldPosition(_v1);
  const camLocal = doorGroup.worldToLocal(_v1.clone());
  frontSign = camLocal.z >= 0 ? 1 : -1;
  prevSignedFrontDist = camLocal.z * frontSign;

  // 门后预览锚点
  updatePreviewAnchorByFrontSign();

  isInside = false;
  lastTransitionMs = 0;
  placed = true;
  reticle.visible = false;
}

/* =========================
   过门判定
========================= */
function cameraNearGate(localCam) {
  const dx = localCam.x - holeOffsetX;
  const dy = localCam.y - (holeCenterY + holeOffsetY);

  const halfW = Math.max(0.60, holeW * 0.62);
  const halfH = Math.max(1.00, holeH * 0.72);

  const nearRect =
    Math.abs(dx) <= halfW &&
    Math.abs(dy) <= halfH &&
    Math.abs(localCam.z) <= CROSSING_Z_GATE_M;

  const nearCylinder =
    Math.hypot(dx, localCam.z) <= 1.15 &&
    Math.abs(dy) <= 1.60;

  return nearRect || nearCylinder;
}

function updatePortalState(xrCam) {
  if (!placed || !doorGroup) return;

  xrCam.getWorldPosition(_v1);
  const localCam = doorGroup.worldToLocal(_v1.clone());

  // >0 在门前；<0 在门后
  const signedFrontDist = localCam.z * frontSign;
  const gate = cameraNearGate(localCam);
  const now = performance.now();

  if (now - lastTransitionMs > TRANSITION_COOLDOWN_MS) {
    if (!isInside) {
      const crossedToBack = prevSignedFrontDist >= 0 && signedFrontDist < -ENTER_THRESHOLD_M;
      const forceEnter = gate && signedFrontDist < -FORCE_ENTER_M;
      if ((crossedToBack && gate) || forceEnter) {
        isInside = true;
        lastTransitionMs = now;
      }
    } else {
      const crossedToFront = prevSignedFrontDist <= 0 && signedFrontDist > EXIT_THRESHOLD_M;
      const forceExit = gate && signedFrontDist > FORCE_EXIT_M;
      if ((crossedToFront && gate) || forceExit) {
        isInside = false;
        lastTransitionMs = now;
      }
    }
  }

  prevSignedFrontDist = signedFrontDist;

  if (SHOW_DEBUG) updateDebug(localCam, signedFrontDist, gate);
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

  // 0) 清屏（含stencil）
  renderer.clear(true, true, true);

  // 1) 主pass：现实 + 门框
  setXRCameraLayer(xrCam, LAYER_MAIN);
  renderer.render(scene, xrCam);

  if (!placed) return;

  // 2) 门外：写mask stencil -> 渲染门内预览
  if (!isInside && portalMaskMesh && portalPreviewRoot) {
    renderer.clear(false, false, true); // 只清 stencil

    setXRCameraLayer(xrCam, LAYER_MASK);
    renderer.render(scene, xrCam);

    setXRCameraLayer(xrCam, LAYER_PREVIEW);
    renderer.render(scene, xrCam);
  }

  // 3) 门内：渲染沉浸世界（持续包裹）
  if (isInside && insideWorldRoot) {
    xrCam.getWorldPosition(_v2);
    insideWorldRoot.position.copy(_v2); // 关键：始终包裹用户，避免“走进消失”

    renderer.clearDepth();
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
