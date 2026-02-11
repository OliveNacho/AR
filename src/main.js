import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/* =========================
   基础参数
========================= */
const DOOR_TARGET_HEIGHT_M = 2.10;
const DOOR_SCALE_MULT = 0.90; // 最终门高倍率
const PLACE_DISTANCE_M = 1.60;
const DOOR_YAW_OFFSET = Math.PI / 2; // 模型朝向校正（若你的模型本来朝向正确可改成0）

/* =========================
   门洞参数（建议手动）
========================= */
const USE_MANUAL_HOLE = true;
const MANUAL_HOLE = {
  width: 1.50,   // 门洞宽
  height: 1.52,  // 门洞高
  centerY: 0.88, // 门洞中心Y（门底=0）
  offsetX: 0.00, // 左右微调
  offsetY: 0.00, // 上下微调（叠加centerY）
};

// 自动估算备用
const HOLE_WIDTH_FACTOR = 0.60;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.50;
const MASK_OVERSCAN_W = 1.16;
const MASK_OVERSCAN_H = 1.06;

/* =========================
   世界参数（关键）
   同一个“门后世界中心”给预览和inside共用
========================= */
const WORLD_BEHIND_OFFSET_M = 8.0;       // 世界中心在门后8m
const WORLD_CENTER_Y_RELATIVE_M = 0.55;  // 相对门洞中心的Y偏移
const WORLD_RADIUS_M = 45.0;             // 球半径（保证用户可走动）

/* =========================
   穿门判定参数
========================= */
const ENTER_THRESHOLD_M = 0.02;
const EXIT_THRESHOLD_M = 0.12;
const FORCE_ENTER_M = 0.30;
const FORCE_EXIT_M = 0.30;
const CROSSING_Z_GATE_M = 1.50;
const TRANSITION_COOLDOWN_MS = 650;

/* =========================
   图层
========================= */
const LAYER_MAIN = 0;    // 门框 + reticle
const LAYER_MASK = 1;    // 写 stencil 的门洞mask
const LAYER_PREVIEW = 2; // 门外预览（受stencil）
const LAYER_INSIDE = 3;  // 门内沉浸（全屏）

/* =========================
   调试
========================= */
const SHOW_DEBUG = false;

/* =========================
   全局
========================= */
let scene, renderer;
let baseCamera, controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let doorModel = null;
let doorGroup = null;
let doorVisualGroup = null;
let portalFrameGroup = null; // 逻辑门平面坐标系（与视觉门同向）

let portalMaskMesh = null;
let previewWorldRoot = null;
let insideWorldRoot = null;

let placed = false;
let isInside = false;
let lastTransitionMs = 0;

let frontSign = 1; // 放门时用户所在侧定义为“门前”
let prevSignedFrontDist = 0;

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

  doorGroup = null;
  doorVisualGroup = null;
  portalFrameGroup = null;
  portalMaskMesh = null;
  previewWorldRoot = null;
  insideWorldRoot = null;
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
      normalizeDoorModel(doorModel, DOOR_TARGET_HEIGHT_M * DOOR_SCALE_MULT);
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
   工具：layer / stencil
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
  // three中材质层stencil测试需要stencilWrite=true才会应用状态
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

function setXRCameraLayer(xrCam, layer) {
  xrCam.layers.set(layer);
  if (xrCam.isArrayCamera && xrCam.cameras) {
    for (const c of xrCam.cameras) c.layers.set(layer);
  }
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
   构建
========================= */
function buildOnce() {
  if (doorGroup) return;

  doorGroup = new THREE.Group();
  doorGroup.layers.set(LAYER_MAIN);
  scene.add(doorGroup);

  // 视觉模型
  doorVisualGroup = new THREE.Group();
  doorVisualGroup.rotation.y = DOOR_YAW_OFFSET; // 与portalFrame保持一致
  doorVisualGroup.layers.set(LAYER_MAIN);
  doorGroup.add(doorVisualGroup);

  // 逻辑门平面（过门判定、mask、world锚点都用它）
  portalFrameGroup = new THREE.Group();
  portalFrameGroup.rotation.y = DOOR_YAW_OFFSET; // 关键：和视觉门同向
  portalFrameGroup.layers.set(LAYER_MAIN);
  doorGroup.add(portalFrameGroup);

  if (doorModel) {
    const m = doorModel.clone(true);
    setLayerRecursive(m, LAYER_MAIN);
    doorVisualGroup.add(m);
  } else {
    // fallback门框
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

  // 估算门洞
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

  // 1) mask（只写stencil）
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial();
  setMaskStencil(maskMat);

  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(holeOffsetX, holeCenterY + holeOffsetY, -0.01);
  portalMaskMesh.layers.set(LAYER_MASK);
  portalMaskMesh.frustumCulled = false;
  portalFrameGroup.add(portalMaskMesh);

  // 2) 门外预览世界（stencil裁剪）
  previewWorldRoot = new THREE.Group();
  previewWorldRoot.layers.set(LAYER_PREVIEW);
  portalFrameGroup.add(previewWorldRoot);

  const pano = getPanoTexture();

  const previewMat = new THREE.MeshBasicMaterial({
    map: pano,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
  setReadStencil(previewMat);

  const previewSphere = new THREE.Mesh(
    new THREE.SphereGeometry(WORLD_RADIUS_M, 64, 48),
    previewMat
  );
  previewSphere.layers.set(LAYER_PREVIEW);
  previewSphere.frustumCulled = false;
  previewWorldRoot.add(previewSphere);

  // 3) 门内沉浸世界（全屏）
  insideWorldRoot = new THREE.Group();
  insideWorldRoot.layers.set(LAYER_INSIDE);
  portalFrameGroup.add(insideWorldRoot);

  const insideMat = new THREE.MeshBasicMaterial({
    map: pano,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(WORLD_RADIUS_M, 64, 48),
    insideMat
  );
  insideSphere.layers.set(LAYER_INSIDE);
  insideSphere.frustumCulled = false;
  insideSphere.renderOrder = 1000;
  insideWorldRoot.add(insideSphere);
}

function updateWorldAnchors() {
  if (!previewWorldRoot || !insideWorldRoot) return;

  const backSign = -frontSign; // 与“门前”相反方向就是门后
  const worldCenterY = holeCenterY + holeOffsetY + WORLD_CENTER_Y_RELATIVE_M;
  const worldCenterZ = backSign * WORLD_BEHIND_OFFSET_M;

  previewWorldRoot.position.set(holeOffsetX, worldCenterY, worldCenterZ);
  insideWorldRoot.position.set(holeOffsetX, worldCenterY, worldCenterZ);
}

/* =========================
   交互
========================= */
function onSelect() {
  if (placed || !reticle.visible) return;

  if (!doorGroup) buildOnce();

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 命中点地面高度
  const hitPos = _v1.setFromMatrixPosition(reticle.matrix);

  // 相机前方固定距离放门
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

  // 用portalFrame坐标确定“门前”
  xrCam.getWorldPosition(_v1);
  const localCam = portalFrameGroup.worldToLocal(_v1.clone());
  frontSign = localCam.z >= 0 ? 1 : -1;
  if (Math.abs(localCam.z) < 1e-5) frontSign = 1;

  prevSignedFrontDist = localCam.z * frontSign;
  lastTransitionMs = 0;
  isInside = false;

  updateWorldAnchors();

  placed = true;
  reticle.visible = false;
}

/* =========================
   过门判定
========================= */
function nearPortalGate(localCam) {
  const cx = holeOffsetX;
  const cy = holeCenterY + holeOffsetY;

  const dx = localCam.x - cx;
  const dy = localCam.y - cy;

  const inBox =
    Math.abs(dx) <= holeW * 0.70 + 0.35 &&
    Math.abs(dy) <= holeH * 0.80 + 0.45 &&
    Math.abs(localCam.z) <= CROSSING_Z_GATE_M;

  const inCylinder =
    Math.hypot(dx, localCam.z) <= 1.20 &&
    Math.abs(dy) <= 1.70;

  return inBox || inCylinder;
}

function updatePortalState(xrCam) {
  if (!placed || !portalFrameGroup) return;

  xrCam.getWorldPosition(_v1);
  const localCam = portalFrameGroup.worldToLocal(_v1.clone());

  // >0 门前，<0 门后
  const signedFrontDist = localCam.z * frontSign;
  const gate = nearPortalGate(localCam);

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

  // 清屏（含stencil）
  renderer.clear(true, true, true);

  // 主pass：现实 + 门框
  setXRCameraLayer(xrCam, LAYER_MAIN);
  renderer.render(scene, xrCam);

  if (!placed) return;

  if (!isInside) {
    // 门外：mask写stencil -> 渲染预览世界
    renderer.clear(false, false, true); // 只清stencil

    setXRCameraLayer(xrCam, LAYER_MASK);
    renderer.render(scene, xrCam);

    setXRCameraLayer(xrCam, LAYER_PREVIEW);
    renderer.render(scene, xrCam);
  } else {
    // 门内：全屏沉浸世界
    renderer.clearDepth();
    setXRCameraLayer(xrCam, LAYER_INSIDE);
    renderer.render(scene, xrCam);

    // 再画一遍门框，方便你在inside里找回门位置折返
    renderer.clearDepth();
    setXRCameraLayer(xrCam, LAYER_MAIN);
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
