import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** ✅ 你已调好的参数 **/
const DOOR_TARGET_HEIGHT_M = 2.10;
const PLACE_DISTANCE_M = 1.60;
const DOOR_SCALE_MULT = 0.90;
const DOOR_YAW_OFFSET = Math.PI / 2;

// 门洞估算（按门整体包围盒比例）
const HOLE_WIDTH_FACTOR = 0.56;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;

// 穿门判定（必须跨平面触发）
const ENTER_THRESHOLD_M = 0.14;
const EXIT_THRESHOLD_M = 0.08;

// 门洞裁剪深度（门后内容保留多深）
const PORTAL_DEPTH_M = 12.0;

// 星空密度（你要多一些）
const WINDOW_STAR_COUNT = 2600;
const INSIDE_STAR_COUNT = 5200;
const WINDOW_NEBULA_COUNT = 5;
const INSIDE_NEBULA_COUNT = 7;

let scene, renderer;
let baseCamera;
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let placed = false;
let isInside = false;

let doorGroup = null;
let doorModel = null;

// door hole params
let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

// portal content
let portalWindowGroup = null; // 门洞窗口内容（挂在门上）
let insideGroup = null;       // 进门后全屏内容（跟随相机）

// ✅ 关键：放置门时锁定“门后方向”和“门洞中心”
let portalBackDirWorld = new THREE.Vector3(0, 0, 1);
let portalCenterWorld = new THREE.Vector3();
let prevSignedBackDist = 0;

// audio
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

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  // ✅ 用 clipping（不依赖 stencil）
  renderer.localClippingEnabled = true;

  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(1, 2, 1);
  scene.add(dir);

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

  if (insideGroup) scene.remove(insideGroup);
  insideGroup = null;

  portalWindowGroup = null;
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

/** 圆形发光星点 sprite（解决方块） */
function makeStarSpriteTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");

  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.9)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.20)");
  grd.addColorStop(1.0, "rgba(255,255,255,0)");

  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStarFieldPoints(count = 3000, radius = 10, size = 0.085) {
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

/** 程序生成星云纹理（不需要额外图片） */
function makeNebulaTexture(seed = 0) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d");

  // 背景透明
  ctx.clearRect(0, 0, 256, 256);

  // 多层径向渐变叠加
  for (let i = 0; i < 10; i++) {
    const x = 128 + (Math.sin(seed * 10 + i * 2.1) * 60);
    const y = 128 + (Math.cos(seed * 7 + i * 1.7) * 60);
    const r = 80 + (i * 8);

    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.10 - i * 0.006})`);
    g.addColorStop(0.5, `rgba(255,255,255,${0.04 - i * 0.002})`);
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

function makeNebulaBillboard(seed = 0, size = 5.0) {
  const tex = makeNebulaTexture(seed);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const geo = new THREE.PlaneGeometry(size, size);
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}

/** 门洞中心（世界坐标） */
function computePortalCenterWorld() {
  portalCenterWorld.set(0, holeCenterY, 0);
  doorGroup.localToWorld(portalCenterWorld);
}

/**
 * ✅ 放置门瞬间锁定“门后方向”
 * 并确保相机当前一定在“门前侧”(dist<=0)，否则翻转 backDir
 */
function initPortalBackDirection(xrCam) {
  // 用 doorGroup 的 forward(-Z) 得到 backDir = -forward
  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  portalBackDirWorld.copy(forward).multiplyScalar(-1);

  computePortalCenterWorld();

  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const d0 = camPos.clone().sub(portalCenterWorld).dot(portalBackDirWorld);

  // 如果相机此刻在“门后侧”，翻转 backDir，保证放门时在门前
  if (d0 > 0) portalBackDirWorld.multiplyScalar(-1);
}

/** 相机沿门后方向的有符号距离：>0 门后，<0 门前 */
function signedBackDistance(xrCam) {
  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  computePortalCenterWorld();
  return camPos.sub(portalCenterWorld).dot(portalBackDirWorld);
}

/** 只让 portalWindowGroup 在门洞矩形范围可见（no-stencil） */
function computeDoorClippingPlanes() {
  const hw = holeW / 2;
  const hh = holeH / 2;

  computePortalCenterWorld();

  // 门洞边界点（世界坐标）
  const centerLocal = new THREE.Vector3(0, holeCenterY, 0);
  const pL = doorGroup.localToWorld(centerLocal.clone().add(new THREE.Vector3(-hw, 0, 0)));
  const pR = doorGroup.localToWorld(centerLocal.clone().add(new THREE.Vector3(hw, 0, 0)));
  const pT = doorGroup.localToWorld(centerLocal.clone().add(new THREE.Vector3(0, hh, 0)));
  const pB = doorGroup.localToWorld(centerLocal.clone().add(new THREE.Vector3(0, -hh, 0)));

  // 门的右/上方向（世界）
  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const rightDir = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
  const upDir = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();

  // 四边裁剪：保留门洞内部
  const nLeft = rightDir.clone();
  const nRight = rightDir.clone().negate();
  const nBottom = upDir.clone();
  const nTop = upDir.clone().negate();

  // ✅ 关键：门后方向用锁定的 portalBackDirWorld
  const backDir = portalBackDirWorld.clone().normalize();

  // Front：裁掉门前，只保留门后
  const nFront = backDir.clone().negate();
  const pFront = portalCenterWorld.clone();

  // Back：限制深度
  const pBack = portalCenterWorld.clone().add(backDir.clone().multiplyScalar(PORTAL_DEPTH_M));
  const nBack = backDir.clone();

  return [
    new THREE.Plane().setFromNormalAndCoplanarPoint(nLeft, pL),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nRight, pR),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nTop, pT),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nBottom, pB),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nFront, pFront),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nBack, pBack),
  ];
}

function buildOnce() {
  doorGroup = new THREE.Group();

  if (doorModel) {
    doorGroup.add(doorModel.clone(true));
  } else {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, DOOR_TARGET_HEIGHT_M, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
    );
    frame.position.set(0, DOOR_TARGET_HEIGHT_M / 2, 0);
    doorGroup.add(frame);
  }

  // 整体缩一点
  doorGroup.scale.multiplyScalar(DOOR_SCALE_MULT);

  // 估算门洞
  const box = new THREE.Box3().setFromObject(doorGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  holeW = Math.max(0.75, size.x * HOLE_WIDTH_FACTOR);
  holeH = Math.max(1.75, size.y * HOLE_HEIGHT_FACTOR);
  holeCenterY = Math.max(holeH / 2, size.y * HOLE_YCENTER_FACTOR);

  scene.add(doorGroup);

  // ✅ 门洞窗口内容：挂在门上（门外通过门洞看到星空）
  portalWindowGroup = new THREE.Group();
  doorGroup.add(portalWindowGroup);

  const pano = loadPanoTexture();

  const windowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(8.2, 48, 36),
    new THREE.MeshBasicMaterial({ map: pano, side: THREE.BackSide })
  );
  windowSphere.position.set(0, holeCenterY, -4.8);
  portalWindowGroup.add(windowSphere);

  // 星空增强（更多星点）
  const windowStars = makeStarFieldPoints(WINDOW_STAR_COUNT, 10.5, 0.085);
  windowStars.position.set(0, holeCenterY, -4.8);
  portalWindowGroup.add(windowStars);

  // 星云薄雾（门洞里少量）
  for (let i = 0; i < WINDOW_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(i * 0.37, 4.8 + Math.random() * 2.0);
    neb.position.set(
      (Math.random() - 0.5) * 3.0,
      holeCenterY + (Math.random() - 0.2) * 2.5,
      -4.5 - Math.random() * 2.5
    );
    neb.rotation.y = Math.random() * Math.PI;
    portalWindowGroup.add(neb);
  }

  // ✅ 门内世界：默认隐藏！只有穿门才显示
  insideGroup = new THREE.Group();
  insideGroup.visible = false;

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(12.0, 48, 36),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  insideGroup.add(insideSphere);

  const insideStars = makeStarFieldPoints(INSIDE_STAR_COUNT, 12.0, 0.09);
  insideGroup.add(insideStars);

  for (let i = 0; i < INSIDE_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(10 + i * 0.51, 6.0 + Math.random() * 3.2);
    neb.position.set(
      (Math.random() - 0.5) * 8.0,
      (Math.random() - 0.2) * 6.0,
      (Math.random() - 0.5) * 8.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    insideGroup.add(neb);
  }

  // 门内要盖住现实（只有显示时才会全屏）
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

  // ✅ 放门瞬间锁定门后方向，并保证当前相机一定在门前侧
  initPortalBackDirection(xrCam);

  // ✅ 强制从门外开始（防止“放门瞬间全屏星空”）
  isInside = false;
  if (insideGroup) insideGroup.visible = false;
  if (portalWindowGroup) portalWindowGroup.visible = true;

  // 基线距离（理论上 <= 0）
  prevSignedBackDist = signedBackDistance(xrCam);

  placed = true;
  reticle.visible = false;
  ensureBGMStarted();
}

function updatePortalState() {
  if (!placed || !doorGroup || !portalWindowGroup) return;

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 1) 门洞裁剪：只允许门洞范围显示窗口内容
  const planes = computeDoorClippingPlanes();
  portalWindowGroup.traverse((o) => {
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        m.clippingPlanes = planes;
        m.clipIntersection = true;
        m.needsUpdate = true;
      });
    }
  });

  // 2) 穿门判定：必须跨平面
  const dist = signedBackDistance(xrCam);

  const crossedToBack = prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M;
  const crossedToFront = prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M;

  if (!isInside && crossedToBack) {
    isInside = true;
    if (insideGroup) insideGroup.visible = true;
  }

  if (isInside && crossedToFront) {
    isInside = false;
    if (insideGroup) insideGroup.visible = false;
  }

  prevSignedBackDist = dist;

  // 3) 门外/门内分界显示
  if (portalWindowGroup) portalWindowGroup.visible = !isInside;

  // 4) 门内世界跟随相机
  if (insideGroup && insideGroup.visible) {
    const camPos = new THREE.Vector3();
    xrCam.getWorldPosition(camPos);
    insideGroup.position.copy(camPos);
  }
}

function animate() {
  renderer.setAnimationLoop(render);
}

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
  renderer.render(scene, xrCam);
}

function onWindowResize() {
  baseCamera.aspect = window.innerWidth / window.innerHeight;
  baseCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
