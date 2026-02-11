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
  width: 1.50,   // 调大更宽
  height: 1.54,  // 调大更高
  centerY: 0.88, // 调大上移
  offsetX: 0.00, // 左右微调
  offsetY: 0.00, // 上下微调（叠加到 centerY）
};

// 自动估算备用
const HOLE_WIDTH_FACTOR = 0.60;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.50;
const MASK_OVERSCAN_W = 1.18;
const MASK_OVERSCAN_H = 1.08;

/* =========================
   过门判定参数
========================= */
const TRIGGER_OVERSCAN_W = 1.55;
const TRIGGER_OVERSCAN_H = 1.40;
const CROSSING_Z_GATE_M = 1.60;

const ENTER_THRESHOLD_M = 0.01;
const EXIT_THRESHOLD_M = 0.10;
const FORCE_ENTER_DIST_M = 0.22;
const FORCE_EXIT_DIST_M = 0.22;
const TRANSITION_COOLDOWN_MS = 550;

/* =========================
   门后世界参数（关键）
   让球域明确在门后，不以门为球心
========================= */
const WORLD_CENTER_OFFSET_M = 16.0; // 世界中心在门后 16m
const WORLD_CENTER_Y_M = 1.45;

const PREVIEW_SPHERE_RADIUS_M = 8.0;  // 门外看到的预览球
const INSIDE_SPHERE_RADIUS_M = 90.0;  // 门内沉浸球（大）

/* =========================
   星云/星点
========================= */
const WINDOW_STAR_COUNT = 2600;
const INSIDE_STAR_COUNT = 9000;
const WINDOW_NEBULA_COUNT = 6;
const INSIDE_NEBULA_COUNT = 14;

/* =========================
   图层
========================= */
const LAYER_MAIN = 0;     // 门框 + reticle
const LAYER_MASK = 1;     // 门洞 stencil mask
const LAYER_PREVIEW = 2;  // 门外预览内容（受stencil限制）
const LAYER_INSIDE = 3;   // 门内全屏世界

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

// 门洞参数
let holeW = 1.2;
let holeH = 1.8;
let holeCenterY = 0.9;
let holeOffsetX = 0.0;
let holeOffsetY = 0.0;
let triggerW = 1.6;
let triggerH = 2.2;

// 过门方向：frontSign 由“放门时相机位于门哪侧”确定
let frontSign = 1;
let prevSideDist = 0;

let panoTexture = null;
let debugEl = null;

// 临时对象
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

init();
animate();

/* =========================
   初始化
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

function updateDebug(sideDist, gate, local) {
  if (!debugEl) return;
  debugEl.textContent =
    `inside=${isInside} placed=${placed}\n` +
    `sideDist=${sideDist.toFixed(3)} gate=${gate}\n` +
    `local=(${local.x.toFixed(2)}, ${local.y.toFixed(2)}, ${local.z.toFixed(2)})\n` +
    `frontSign=${frontSign}\n` +
    `hole=${holeW.toFixed(2)} x ${holeH.toFixed(2)} @y=${holeCenterY.toFixed(2)}\n` +
    `trigger=${triggerW.toFixed(2)} x ${triggerH.toFixed(2)}`;
}

function resetAll() {
  placed = false;
  isInside = false;
  lastTransitionMs = 0;
  frontSign = 1;
  prevSideDist = 0;

  reticle.visible = false;

  if (doorGroup) scene.remove(doorGroup);

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
   材质 / stencil
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
  mat.stencilWrite = true; // three 中开启材质 stencil 状态
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.EqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
  mat.stencilWriteMask = 0x00; // 只读，不写
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
   纹理与星空
========================= */
function getPanoTexture() {
  if (panoTexture) return panoTexture;
  panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;
  panoTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return panoTexture;
}

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

function makeStarFieldPoints(count, radius, size, depthTest = true) {
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
   门洞几何
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
   构建场景对象
========================= */
function buildOnce() {
  if (doorGroup) return;

  doorGroup = new THREE.Group();
  doorGroup.layers.set(LAYER_MAIN);
  scene.add(doorGroup);

  // 视觉模型组：仅这里做 yaw 修正，避免影响mask和过门坐标
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
    // fallback 门框
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

  // 计算门洞
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
    const baseW = Math.max(0.9, size.x * HOLE_WIDTH_FACTOR);
    const baseH = Math.max(1.55, size.y * HOLE_HEIGHT_FACTOR);

    holeW = baseW * MASK_OVERSCAN_W;
    holeH = baseH * MASK_OVERSCAN_H;
    holeCenterY = size.y * HOLE_YCENTER_FACTOR;

    holeOffsetX = 0;
    holeOffsetY = 0;
  }

  triggerW = holeW * TRIGGER_OVERSCAN_W;
  triggerH = holeH * TRIGGER_OVERSCAN_H;

  // 1) 门洞 mask（仅写 stencil）
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial();
  setMaskStencil(maskMat);

  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(holeOffsetX, holeCenterY + holeOffsetY, 0);
  portalMaskMesh.layers.set(LAYER_MASK);
  portalMaskMesh.frustumCulled = false;
  doorGroup.add(portalMaskMesh);

  // 2) 门外预览内容（受stencil）
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
    new THREE.SphereGeometry(PREVIEW_SPHERE_RADIUS_M, 48, 36),
    previewSphereMat
  );
  previewSphere.layers.set(LAYER_PREVIEW);
  previewSphere.frustumCulled = false;
  portalPreviewRoot.add(previewSphere);

  const previewStars = makeStarFieldPoints(WINDOW_STAR_COUNT, PREVIEW_SPHERE_RADIUS_M * 0.95, 0.09, true);
  previewStars.layers.set(LAYER_PREVIEW);
  setReadStencil(previewStars.material);
  portalPreviewRoot.add(previewStars);

  for (let i = 0; i < WINDOW_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(i * 0.37, 3.8 + Math.random() * 2.0, true);
    neb.position.set(
      (Math.random() - 0.5) * 6.0,
      (Math.random() - 0.4) * 4.5,
      (Math.random() - 0.5) * 6.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_PREVIEW);
    setReadStencil(neb.material);
    portalPreviewRoot.add(neb);
  }

  applyStencilRead(portalPreviewRoot);

  // 3) 门内沉浸世界（全屏）
  insideWorldRoot = new THREE.Group();
  insideWorldRoot.layers.set(LAYER_INSIDE);
  doorGroup.add(insideWorldRoot);

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(INSIDE_SPHERE_RADIUS_M, 64, 48),
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

  const insideStars = makeStarFieldPoints(INSIDE_STAR_COUNT, INSIDE_SPHERE_RADIUS_M * 0.92, 0.11, false);
  insideStars.layers.set(LAYER_INSIDE);
  insideStars.renderOrder = 1001;
  insideWorldRoot.add(insideStars);

  for (let i = 0; i < INSIDE_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(20 + i * 0.51, 8 + Math.random() * 5, false);
    neb.position.set(
      (Math.random() - 0.5) * 40,
      (Math.random() - 0.25) * 26,
      (Math.random() - 0.5) * 40
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_INSIDE);
    neb.renderOrder = 1002;
    insideWorldRoot.add(neb);
  }

  // 初始按 frontSign=1 先摆一次，真正位置在 onSelect 后更新
  updateWorldAnchorsFromFrontSign();
}

/* =========================
   世界锚点更新（关键）
   确保世界在“门后”
========================= */
function updateWorldAnchorsFromFrontSign() {
  const backSign = -frontSign; // 与用户初始站位反向
  const x = holeOffsetX;
  const y = WORLD_CENTER_Y_M;
  const z = backSign * WORLD_CENTER_OFFSET_M;

  if (portalPreviewRoot) portalPreviewRoot.position.set(x, y, z);
  if (insideWorldRoot) insideWorldRoot.position.set(x, y, z);
}

/* =========================
   交互：放门
========================= */
function onSelect() {
  if (placed || !reticle.visible) return;

  if (!doorGroup) buildOnce();

  const xrCam = renderer.xr.getCamera(baseCamera);

  // hit-test 地面高度
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

  // 用“放门瞬间相机在门本地z的符号”定义 front/back
  xrCam.getWorldPosition(_v1);
  const camLocal = doorGroup.worldToLocal(_v1.clone());
  frontSign = camLocal.z >= 0 ? 1 : -1;
  prevSideDist = camLocal.z * frontSign;

  updateWorldAnchorsFromFrontSign();

  isInside = false;
  lastTransitionMs = 0;
  placed = true;
  reticle.visible = false;
}

/* =========================
   过门状态更新
========================= */
function updatePortalState(xrCam) {
  if (!placed || !doorGroup) return;

  xrCam.getWorldPosition(_v1);
  const local = doorGroup.worldToLocal(_v1.clone());

  // sideDist > 0 在门前；sideDist < 0 在门后
  const sideDist = local.z * frontSign;

  const dx = local.x - holeOffsetX;
  const dy = local.y - (holeCenterY + holeOffsetY);

  const nearX = Math.abs(dx) <= triggerW * 0.5 + 0.25;
  const nearY = Math.abs(dy) <= triggerH * 0.5 + 0.55;
  const nearZ = Math.abs(local.z) <= CROSSING_Z_GATE_M;

  // 兜底：靠近门平面就算 gate（避免单一条件卡死）
  const radialGate = Math.hypot(dx, local.z) <= 1.90;
  const gate = (nearX && nearY && nearZ) || radialGate;

  const now = performance.now();

  if (now - lastTransitionMs > TRANSITION_COOLDOWN_MS) {
    if (!isInside) {
      const crossedToBack = prevSideDist >= 0 && sideDist < -ENTER_THRESHOLD_M;
      const forceEnter = gate && sideDist < -FORCE_ENTER_DIST_M;
      if ((crossedToBack && gate) || forceEnter) {
        isInside = true;
        lastTransitionMs = now;
      }
    } else {
      const crossedToFront = prevSideDist <= 0 && sideDist > EXIT_THRESHOLD_M;
      const forceExit = gate && sideDist > FORCE_EXIT_DIST_M;
      if ((crossedToFront && gate) || forceExit) {
        isInside = false;
        lastTransitionMs = now;
      }
    }
  }

  prevSideDist = sideDist;
  if (SHOW_DEBUG) updateDebug(sideDist, gate, local);
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
   渲染循环
========================= */
function render(_, frame) {
  if (frame && !placed) updateHitTest(frame);

  const xrCam = renderer.xr.getCamera(baseCamera);

  if (placed) updatePortalState(xrCam);
  else if (SHOW_DEBUG) {
    updateDebug(0, false, new THREE.Vector3());
  }

  // 0) 清屏（含 stencil）
  renderer.clear(true, true, true);

  // 1) 主 pass：现实 + 门框 + reticle
  setXRCameraLayer(xrCam, LAYER_MAIN);
  renderer.render(scene, xrCam);

  if (!placed) return;

  // 2) 门外：先写mask stencil，再画预览
  if (!isInside && portalMaskMesh && portalPreviewRoot) {
    renderer.clear(false, false, true); // 只清 stencil

    setXRCameraLayer(xrCam, LAYER_MASK);
    renderer.render(scene, xrCam);

    setXRCameraLayer(xrCam, LAYER_PREVIEW);
    renderer.render(scene, xrCam);
  }

  // 3) 门内：全屏沉浸世界
  if (isInside && insideWorldRoot) {
    renderer.clearDepth(); // 避免被主pass深度影响
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
