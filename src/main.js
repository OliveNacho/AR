import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** ✅ 你已调好的参数 **/
const DOOR_TARGET_HEIGHT_M = 2.10;
const PLACE_DISTANCE_M = 1.60;
const DOOR_SCALE_MULT = 0.90;
const DOOR_YAW_OFFSET = Math.PI / 2;

/** 门洞估算（按门整体包围盒比例）— 可微调 */
const HOLE_WIDTH_FACTOR = 0.56;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;

/** 穿门判定：必须跨过门洞平面 */
const ENTER_THRESHOLD_M = 0.14;
const EXIT_THRESHOLD_M = 0.08;

/** 视觉增强 */
const WINDOW_STAR_COUNT = 3200;
const INSIDE_STAR_COUNT = 7000;
const WINDOW_NEBULA_COUNT = 6;
const INSIDE_NEBULA_COUNT = 10;

let scene, renderer;
let baseCamera, controller;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let doorModel = null;
let doorGroup = null;
let portalMaskMesh = null;      // ✅ stencil mask（拱门形状）
let portalContentGroup = null;  // ✅ 门洞里看到的星空（通过 stencil 显示）
let insideGroup = null;         // ✅ 门内全屏星空（穿门后显示）

let placed = false;
let isInside = false;

let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

let portalCenterWorld = new THREE.Vector3();
let portalBackDirWorld = new THREE.Vector3(0, 0, 1);
let prevSignedBackDist = 0;

// audio（可留着）
let listener;
let bgm = null;

init();
animate();

function init() {
  scene = new THREE.Scene();

  baseCamera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    80
  );

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    stencil: true, // ✅ 关键：启用 stencil
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.autoClear = false; // ✅ 我们手动控制清屏与多次 render

  document.body.appendChild(renderer.domElement);

  // light（门框需要）
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
  scene.add(reticle);

  controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  listener = new THREE.AudioListener();
  baseCamera.add(listener);

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
  doorGroup = null;
  portalMaskMesh = null;
  portalContentGroup = null;

  if (insideGroup) scene.remove(insideGroup);
  insideGroup = null;
}

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

  model.position.x += (0 - center2.x);
  model.position.z += (0 - center2.z);
  model.position.y += (0 - box2.min.y);
}

function loadPanoTexture() {
  const tex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** ====== 星空素材：星点 + 星云（程序生成） ====== */
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

function makeStarFieldPoints(count = 4000, radius = 10, size = 0.09) {
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

  const sprite = makeStarSpriteTexture();
  const mat = new THREE.PointsMaterial({
    map: sprite,
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
  const tex = makeNebulaTexture(seed);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const geo = new THREE.PlaneGeometry(size, size);
  return new THREE.Mesh(geo, mat);
}

/** ====== 关键：拱门 stencil mask 几何 ======
 * 形状：下矩形 + 上半圆（更贴合你的弧门）
 */
function makeArchMaskGeometry(width, height) {
  const w = width;
  const h = height;

  // 半圆半径取宽的一半
  const r = w * 0.5;

  // 矩形高度 = 总高 - 半圆半径
  const rectH = Math.max(0.01, h - r);

  const shape = new THREE.Shape();
  // 从左下角开始
  shape.moveTo(-w / 2, -rectH / 2);
  shape.lineTo(w / 2, -rectH / 2);
  shape.lineTo(w / 2, rectH / 2);

  // 半圆（从右到左，顶部）
  shape.absarc(0, rectH / 2, r, 0, Math.PI, false);

  shape.lineTo(-w / 2, rectH / 2);
  shape.lineTo(-w / 2, -rectH / 2);

  const geo = new THREE.ShapeGeometry(shape, 48);
  return geo;
}

/** 门洞中心（世界坐标） */
function computePortalCenterWorld() {
  portalCenterWorld.set(0, holeCenterY, 0);
  doorGroup.localToWorld(portalCenterWorld);
}

/** 放门瞬间锁定“门后方向”，保证相机此刻在门前侧 */
function initPortalBackDirection(xrCam) {
  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  portalBackDirWorld.copy(forward).multiplyScalar(-1); // back = -forward

  computePortalCenterWorld();

  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const d0 = camPos.clone().sub(portalCenterWorld).dot(portalBackDirWorld);
  if (d0 > 0) portalBackDirWorld.multiplyScalar(-1);
}

/** >0 门后，<0 门前 */
function signedBackDistance(xrCam) {
  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);
  computePortalCenterWorld();
  return camPos.sub(portalCenterWorld).dot(portalBackDirWorld);
}

function buildOnce() {
  doorGroup = new THREE.Group();

  if (doorModel) {
    doorGroup.add(doorModel.clone(true));
  } else {
    // fallback
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, DOOR_TARGET_HEIGHT_M, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
    );
    frame.position.set(0, DOOR_TARGET_HEIGHT_M / 2, 0);
    doorGroup.add(frame);
  }

  doorGroup.scale.multiplyScalar(DOOR_SCALE_MULT);
  scene.add(doorGroup);

  // 估算门洞尺寸
  const box = new THREE.Box3().setFromObject(doorGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  holeW = Math.max(0.75, size.x * HOLE_WIDTH_FACTOR);
  holeH = Math.max(1.65, size.y * HOLE_HEIGHT_FACTOR);
  holeCenterY = Math.max(holeH / 2, size.y * HOLE_YCENTER_FACTOR);

  /** ✅ 1) stencil mask（只写 stencil，不写颜色） */
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,     // 不写颜色
    depthWrite: false,
    depthTest: true,
  });

  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(0, holeCenterY, 0.01); // 稍微靠近相机一丢丢，避免z-fighting
  doorGroup.add(portalMaskMesh);

  /** ✅ 2) 门洞内“星空窗口”内容（挂在门上，永不全屏） */
  portalContentGroup = new THREE.Group();
  doorGroup.add(portalContentGroup);

  const pano = loadPanoTexture();

  // 窗口球体：放在门后一点点
  const windowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(9.5, 48, 36),
    new THREE.MeshBasicMaterial({ map: pano, side: THREE.BackSide })
  );
  windowSphere.position.set(0, holeCenterY, -6.0);
  portalContentGroup.add(windowSphere);

  const windowStars = makeStarFieldPoints(WINDOW_STAR_COUNT, 12.0, 0.09);
  windowStars.position.set(0, holeCenterY, -6.0);
  portalContentGroup.add(windowStars);

  for (let i = 0; i < WINDOW_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(i * 0.41, 5.5 + Math.random() * 2.0);
    neb.position.set(
      (Math.random() - 0.5) * 3.6,
      holeCenterY + (Math.random() - 0.15) * 2.8,
      -5.5 - Math.random() * 4.5
    );
    neb.rotation.y = Math.random() * Math.PI;
    portalContentGroup.add(neb);
  }

  /** ✅ 3) 门内全屏星空（默认隐藏！） */
  insideGroup = new THREE.Group();
  insideGroup.visible = false;

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(14.0, 48, 36),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  insideGroup.add(insideSphere);

  const insideStars = makeStarFieldPoints(INSIDE_STAR_COUNT, 14.0, 0.10);
  insideGroup.add(insideStars);

  for (let i = 0; i < INSIDE_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(20 + i * 0.57, 6.2 + Math.random() * 3.8);
    neb.position.set(
      (Math.random() - 0.5) * 10.0,
      (Math.random() - 0.2) * 8.0,
      (Math.random() - 0.5) * 10.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    insideGroup.add(neb);
  }

  // 保证门内覆盖现实（仅在 visible=true 时生效）
  insideGroup.traverse((o) => {
    if (o.material) {
      o.material.depthTest = false;
      o.material.depthWrite = false;
    }
  });

  scene.add(insideGroup);
}

function ensureBGMStarted() {
  if (bgm) return;
  const audio = new THREE.Audio(listener);
  const loader = new THREE.AudioLoader();
  loader.load(
    `${BASE}audio/bg.flac`,
    (buffer) => {
      audio.setBuffer(buffer);
      audio.setLoop(true);
      audio.setVolume(0.6);
      audio.play();
    },
    undefined,
    (err) => console.error("Failed to load bg.flac", err)
  );
  bgm = audio;
}

function onSelect() {
  if (placed) return;
  if (!reticle.visible) return;

  if (!doorGroup) buildOnce();

  const xrCam = renderer.xr.getCamera(baseCamera);

  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);

  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const dir = new THREE.Vector3();
  xrCam.getWorldDirection(dir);
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();

  const targetPos = camPos.clone().add(dir.multiplyScalar(PLACE_DISTANCE_M));
  targetPos.y = hitPos.y;

  doorGroup.position.copy(targetPos);

  const lookAtPos = camPos.clone();
  lookAtPos.y = targetPos.y;

  doorGroup.lookAt(lookAtPos);
  doorGroup.rotateY(DOOR_YAW_OFFSET);

  // ✅ 锁定门后方向 + 强制从门外开始
  initPortalBackDirection(xrCam);
  isInside = false;
  if (insideGroup) insideGroup.visible = false;
  if (portalContentGroup) portalContentGroup.visible = true;
  prevSignedBackDist = signedBackDistance(xrCam);

  placed = true;
  reticle.visible = false;
  ensureBGMStarted();
}

function updatePortalState() {
  if (!placed || !doorGroup) return;

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 穿门判定（跨平面）
  const dist = signedBackDistance(xrCam);
  const crossedToBack = prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M;
  const crossedToFront = prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M;

  if (!isInside && crossedToBack) {
    isInside = true;
    if (insideGroup) insideGroup.visible = true;
  } else if (isInside && crossedToFront) {
    isInside = false;
    if (insideGroup) insideGroup.visible = false;
  }

  prevSignedBackDist = dist;

  // 门内隐藏窗口层（纯门内体验）
  if (portalContentGroup) portalContentGroup.visible = !isInside;

  // 门内世界跟随相机
  if (insideGroup && insideGroup.visible) {
    const camPos = new THREE.Vector3();
    xrCam.getWorldPosition(camPos);
    insideGroup.position.copy(camPos);
  }
}

/** ====== 关键渲染：Stencil Portal ======
 * 1) 正常渲染场景（门框等）
 * 2) 如果在门外：先写 stencil（画 mask），再只在 stencil==1 的区域渲染 portalContentGroup
 * 3) 如果在门内：只显示 insideGroup（全屏）
 */
function render(_, frame) {
  // hit-test only before placed
  if (frame && !placed) {
    const session = renderer.xr.getSession();
    const referenceSpace = renderer.xr.getReferenceSpace();

    if (!hitTestSourceRequested) {
      session.requestReferenceSpace("viewer").then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
          hitTestSource = source;
        });
      });

      session.addEventListener("end", () => {
        hitTestSourceRequested = false;
        hitTestSource = null;
        resetAll();
      });

      hitTestSourceRequested = true;
    }

    if (hitTestSource) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    }
  }

  updatePortalState();

  const xrCam = renderer.xr.getCamera(baseCamera);

  // === 0) 清理（需要手动）
  renderer.clear(true, true, true);

  // === 1) 先渲染正常场景（包含门框，包含 insideGroup(可能不可见)）
  // 注意：insideGroup.visible 控制门内全屏
  renderer.render(scene, xrCam);

  // === 2) 门外时：用 stencil 把 portalContentGroup 限制在门洞里
  if (placed && !isInside && portalMaskMesh && portalContentGroup) {
    const gl = renderer.getContext();
    gl.enable(gl.STENCIL_TEST);

    // 2.1 清掉 stencil
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    // 2.2 写 stencil：画门洞 mask => stencil = 1
    portalMaskMesh.material.colorWrite = false;
    portalMaskMesh.material.depthWrite = false;

    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

    // 只渲染 mask 自己（避免影响其它物体）
    const prevVis = portalContentGroup.visible;
    portalContentGroup.visible = false; // 先关掉内容

    // 临时只画 mask：我们用 overrideMaterial 更稳
    const savedOverride = scene.overrideMaterial;
    scene.overrideMaterial = portalMaskMesh.material;

    // 只让 mask 可见
    const oldMaskVis = portalMaskMesh.visible;
    portalMaskMesh.visible = true;

    renderer.render(scene, xrCam);

    // 复原
    portalMaskMesh.visible = oldMaskVis;
    scene.overrideMaterial = savedOverride;
    portalContentGroup.visible = prevVis;

    // 2.3 只在 stencil==1 的区域画 portalContentGroup
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

    // 这里不想再画整个 scene，只画 portalContentGroup：用一个小临时 scene
    const portalScene = new THREE.Scene();
    portalScene.add(portalContentGroup);

    renderer.render(portalScene, xrCam);

    // portalContentGroup 放回 doorGroup（保持结构）
    doorGroup.add(portalContentGroup);

    gl.disable(gl.STENCIL_TEST);
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
