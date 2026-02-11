import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 参数 */
const DOOR_TARGET_HEIGHT_M = 2.10;
const PLACE_DISTANCE_M = 1.60;
const DOOR_SCALE_MULT = 0.90;
const DOOR_YAW_OFFSET = Math.PI / 2;

/** 门洞估算 */
const HOLE_WIDTH_FACTOR = 0.56;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;

/** 穿门阈值 */
const ENTER_THRESHOLD_M = 0.14;
const EXIT_THRESHOLD_M = 0.08;

/** 星云/星点数量 */
const WINDOW_STAR_COUNT = 3500;
const INSIDE_STAR_COUNT = 8000;
const WINDOW_NEBULA_COUNT = 7;
const INSIDE_NEBULA_COUNT = 12;

/** 图层 */
const LAYER_MAIN = 0;   // 门框、reticle
const LAYER_MASK = 1;   // 门洞遮罩（仅写 stencil）
const LAYER_PORTAL = 2; // 门洞内星空窗口
const LAYER_INSIDE = 3; // 门内全屏星空

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

let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

const portalCenterWorld = new THREE.Vector3();
const portalBackDirWorld = new THREE.Vector3(0, 0, 1);
let prevSignedBackDist = 0;

// temp objects
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

let panoTexture = null;

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

  // 灯光
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

function resetAll() {
  placed = false;
  isInside = false;
  prevSignedBackDist = 0;
  reticle.visible = false;

  if (doorGroup) scene.remove(doorGroup);
  if (insideGroup) scene.remove(insideGroup);

  doorGroup = null;
  doorVisualGroup = null;
  portalMaskMesh = null;
  portalContentGroup = null;
  insideGroup = null;
}

// ===== GLB =====
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

// ===== Texture =====
function getPanoTexture() {
  if (panoTexture) return panoTexture;
  panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;
  return panoTexture;
}

// ===== Stencil helpers =====
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
  // 在 three.js 中，材质层 stencil test 需要 stencilWrite=true 才会启用状态
  mat.stencilWrite = true;
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.EqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
  mat.stencilWriteMask = 0x00; // 不改 stencil 值，只读取
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

// ===== Stars / Nebula =====
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

function makeStarFieldPoints(count = 4000, radius = 10, size = 0.095) {
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
    size,
    sizeAttenuation: true,
  });

  return new THREE.Points(geo, mat);
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

function makeNebulaBillboard(seed = 0, size = 6.0) {
  const mat = new THREE.MeshBasicMaterial({
    map: makeNebulaTexture(seed),
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
}

// ===== Portal math =====
function computePortalCenterWorld(out) {
  out.set(0, holeCenterY, 0);
  doorGroup.localToWorld(out);
  return out;
}

function initPortalBackDirection(xrCam) {
  doorGroup.getWorldQuaternion(_q1);

  // doorGroup local -Z 是正面，因此背面方向为 +Z = -forward
  const forward = _v1.set(0, 0, -1).applyQuaternion(_q1).normalize();
  portalBackDirWorld.copy(forward).multiplyScalar(-1);

  computePortalCenterWorld(portalCenterWorld);
  xrCam.getWorldPosition(_v2);

  const d0 = _v2.sub(portalCenterWorld).dot(portalBackDirWorld);
  if (d0 > 0) portalBackDirWorld.multiplyScalar(-1); // 保证放门时相机在门前
}

function signedBackDistance(xrCam) {
  xrCam.getWorldPosition(_v1);
  computePortalCenterWorld(portalCenterWorld);
  return _v1.sub(portalCenterWorld).dot(portalBackDirWorld);
}

function cameraInDoorOpening(xrCam) {
  xrCam.getWorldPosition(_v1);
  doorGroup.worldToLocal(_v1);

  const halfW = holeW * 0.5 + 0.10;
  const yMin = holeCenterY - holeH * 0.5 - 0.08;
  const yMax = holeCenterY + holeH * 0.5 + 0.08;

  return Math.abs(_v1.x) <= halfW && _v1.y >= yMin && _v1.y <= yMax;
}

// ===== Arch mask geometry =====
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

  return new THREE.ShapeGeometry(shape, 48);
}

// ===== Build =====
function buildOnce() {
  if (doorGroup) return;

  doorGroup = new THREE.Group();
  doorGroup.layers.set(LAYER_MAIN);
  scene.add(doorGroup);

  // 视觉层（仅模型）做 yaw 修正，避免影响 mask / portal 平面
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
    // fallback 简易门框
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

  // 估算门洞（本地坐标）
  doorGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(doorVisualGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  holeW = Math.max(0.75, size.x * HOLE_WIDTH_FACTOR);
  holeH = Math.max(1.65, size.y * HOLE_HEIGHT_FACTOR);
  holeCenterY = Math.max(holeH * 0.5, size.y * HOLE_YCENTER_FACTOR);

  // 1) 门洞 mask：仅写 stencil
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial();
  setMaskStencil(maskMat);

  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(0, holeCenterY, -0.015); // 略微朝用户侧
  portalMaskMesh.layers.set(LAYER_MASK);
  portalMaskMesh.frustumCulled = false;
  doorGroup.add(portalMaskMesh);

  // 2) 门洞内星空（挂在 doorGroup 下，跟门一起动）
  portalContentGroup = new THREE.Group();
  portalContentGroup.layers.set(LAYER_PORTAL);
  doorGroup.add(portalContentGroup);

  const pano = getPanoTexture();

  const windowSphereMat = new THREE.MeshBasicMaterial({
    map: pano,
    side: THREE.BackSide,
    depthWrite: false,
  });
  setReadStencil(windowSphereMat);

  const windowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(10.0, 48, 36),
    windowSphereMat
  );
  windowSphere.position.set(0, holeCenterY, +6.2); // 背面方向
  windowSphere.layers.set(LAYER_PORTAL);
  portalContentGroup.add(windowSphere);

  const windowStars = makeStarFieldPoints(WINDOW_STAR_COUNT, 12.5, 0.095);
  windowStars.position.set(0, holeCenterY, +6.2);
  windowStars.layers.set(LAYER_PORTAL);
  setReadStencil(windowStars.material);
  portalContentGroup.add(windowStars);

  for (let i = 0; i < WINDOW_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(i * 0.41, 5.6 + Math.random() * 2.4);
    neb.position.set(
      (Math.random() - 0.5) * 3.8,
      holeCenterY + (Math.random() - 0.15) * 3.0,
      5.5 + Math.random() * 5.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_PORTAL);
    setReadStencil(neb.material);
    portalContentGroup.add(neb);
  }

  // 兜底：保证 portal 所有材质都开启 stencil 读取
  applyStencilRead(portalContentGroup);

  // 3) 门内全屏星空（仅进入后渲染）
  insideGroup = new THREE.Group();
  insideGroup.layers.set(LAYER_INSIDE);
  scene.add(insideGroup);

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(14.5, 48, 36),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  insideSphere.layers.set(LAYER_INSIDE);
  insideGroup.add(insideSphere);

  const insideStars = makeStarFieldPoints(INSIDE_STAR_COUNT, 14.5, 0.105);
  insideStars.layers.set(LAYER_INSIDE);
  insideGroup.add(insideStars);

  for (let i = 0; i < INSIDE_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(20 + i * 0.57, 6.4 + Math.random() * 4.2);
    neb.position.set(
      (Math.random() - 0.5) * 10.5,
      (Math.random() - 0.2) * 8.5,
      (Math.random() - 0.5) * 10.5
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_INSIDE);
    insideGroup.add(neb);
  }
}

// ===== Interaction =====
function onSelect() {
  if (placed || !reticle.visible) return;

  if (!doorGroup) buildOnce();

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 命中地面高度
  const hitPos = _v1.setFromMatrixPosition(reticle.matrix);

  // 用相机前方固定距离放置（你当前风格）
  xrCam.getWorldPosition(_v2);
  xrCam.getWorldDirection(_v3);

  _v3.y = 0;
  if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, -1);
  _v3.normalize();

  const targetPos = _v2.clone().add(_v3.multiplyScalar(PLACE_DISTANCE_M));
  targetPos.y = hitPos.y;
  doorGroup.position.copy(targetPos);

  // 门正面对用户
  const lookAtPos = _v2.clone();
  lookAtPos.y = targetPos.y;
  doorGroup.lookAt(lookAtPos);

  initPortalBackDirection(xrCam);

  isInside = false;
  prevSignedBackDist = signedBackDistance(xrCam);

  placed = true;
  reticle.visible = false;
}

function updatePortalState(xrCam) {
  if (!placed || !doorGroup) return;

  const dist = signedBackDistance(xrCam);
  const inOpening = cameraInDoorOpening(xrCam);

  const crossedToBack = prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M;
  const crossedToFront = prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M;

  if (!isInside && inOpening && crossedToBack) {
    isInside = true;
  } else if (isInside && inOpening && crossedToFront) {
    isInside = false;
  }

  prevSignedBackDist = dist;
}

// ===== Hit-test =====
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

// ===== Render loop =====
function render(_, frame) {
  if (frame && !placed) updateHitTest(frame);

  const xrCam = renderer.xr.getCamera(baseCamera);

  if (placed) updatePortalState(xrCam);

  // 0) 清屏（含 stencil）
  renderer.clear(true, true, true);

  // 1) 主 pass：现实 + 门框
  xrCam.layers.set(LAYER_MAIN);
  renderer.render(scene, xrCam);

  if (!placed) return;

  // 2) 门外：先写 mask stencil，再画 portal 内容
  if (!isInside && portalMaskMesh && portalContentGroup) {
    renderer.clear(false, false, true); // 只清 stencil

    xrCam.layers.set(LAYER_MASK);
    renderer.render(scene, xrCam);

    xrCam.layers.set(LAYER_PORTAL);
    renderer.render(scene, xrCam);
  }

  // 3) 门内：全屏星空覆盖现实
  if (isInside && insideGroup) {
    xrCam.getWorldPosition(_v1);
    insideGroup.position.copy(_v1);

    xrCam.layers.set(LAYER_INSIDE);
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
