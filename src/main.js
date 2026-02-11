import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 你主要调这几个（已按你反馈：远一点、小一点、正对） **/
const DOOR_TARGET_HEIGHT_M = 2.35; // 门别太夸张
const PLACE_DISTANCE_M = 1.45;     // 远一点（之前太近）
const DOOR_SCALE_MULT = 0.92;      // 再整体缩一点（防止“过大”）

/**
 * ✅ 门模型朝向修正（关键）
 * 你现在是“侧门框先出现”，99% 是 GLB 的前向轴不对。
 * 先用 Math.PI（180°）修正；如果你发现变成背对你，就改成 0。
 */
const DOOR_YAW_OFFSET = Math.PI;

// 门洞估算（按门整体包围盒比例）
const HOLE_WIDTH_FACTOR = 0.54;
const HOLE_HEIGHT_FACTOR = 0.70;
const HOLE_YCENTER_FACTOR = 0.51;

// 穿门判定：必须“从门前穿到门后”才触发
const ENTER_THRESHOLD_M = 0.14;
const EXIT_THRESHOLD_M = 0.08;

// 门洞裁剪深度（门后内容保留多深）
const PORTAL_DEPTH_M = 10.0;

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

let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

let portalWindowGroup = null; // ✅ 挂在门上：门外透过门洞看到的“pano世界”
let insideGroup = null;       // ✅ 进门后：pano包裹你

let prevSignedBackDist = 0;

// audio
let listener;
let bgm = null;

init();
animate();

function init() {
  scene = new THREE.Scene();

  baseCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 80);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  // ✅ 不用 stencil；用 clipping，iOS WebXR Viewer 更稳
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

  model.position.x += (0 - center2.x);
  model.position.z += (0 - center2.z);
  model.position.y += (0 - box2.min.y);
}

function loadPanoTexture() {
  const tex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 让星点是“圆形发光”，不是方块
function makeStarSpriteTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");

  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.85)");
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

function makeStarFieldPoints(count = 2400, radius = 10) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.75 + 0.25 * Math.random());

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
    size: 0.09,
    sizeAttenuation: true,
  });

  return new THREE.Points(geo, mat);
}

// ===== Doorway clipping (no stencil) =====
function computeDoorClippingPlanes() {
  const hw = holeW / 2;
  const hh = holeH / 2;

  const cL = new THREE.Vector3(0, holeCenterY, 0);
  const pL = cL.clone().add(new THREE.Vector3(-hw, 0, 0));
  const pR = cL.clone().add(new THREE.Vector3(hw, 0, 0));
  const pT = cL.clone().add(new THREE.Vector3(0, hh, 0));
  const pB = cL.clone().add(new THREE.Vector3(0, -hh, 0));

  const m = doorGroup.matrixWorld;
  const toWorld = (v) => v.clone().applyMatrix4(m);

  const wL = toWorld(pL);
  const wR = toWorld(pR);
  const wT = toWorld(pT);
  const wB = toWorld(pB);
  const wC = toWorld(cL);

  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());

  const nLeft = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const nRight = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
  const nTop = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
  const nBottom = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

  // doorGroup.lookAt(camera) => -Z 朝相机，+Z 为门后方向
  const backDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();

  const nFront = backDir.clone().negate();
  const pFront = wC.clone();

  const pBack = wC.clone().add(backDir.clone().multiplyScalar(PORTAL_DEPTH_M));
  const nBack = backDir.clone();

  return [
    new THREE.Plane().setFromNormalAndCoplanarPoint(nLeft, wL),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nRight, wR),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nTop, wT),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nBottom, wB),
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

  // 门整体再缩一点（避免“过大”）
  doorGroup.scale.multiplyScalar(DOOR_SCALE_MULT);

  // 估算门洞
  const box = new THREE.Box3().setFromObject(doorGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  holeW = Math.max(0.75, size.x * HOLE_WIDTH_FACTOR);
  holeH = Math.max(1.85, size.y * HOLE_HEIGHT_FACTOR);
  holeCenterY = Math.max(holeH / 2, size.y * HOLE_YCENTER_FACTOR);

  scene.add(doorGroup);

  // ✅ 门外窗口：挂在门上（只通过门洞裁剪可见）
  portalWindowGroup = new THREE.Group();
  doorGroup.add(portalWindowGroup);

  const pano = loadPanoTexture();

  const windowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(7.5, 48, 36),
    new THREE.MeshBasicMaterial({ map: pano, side: THREE.BackSide })
  );
  windowSphere.position.set(0, holeCenterY, -4.0);
  portalWindowGroup.add(windowSphere);

  // 轻微星点增强“立体感”（不抢 pano）
  const windowStars = makeStarFieldPoints(1200, 9);
  windowStars.position.set(0, holeCenterY, -3.5);
  portalWindowGroup.add(windowStars);

  // ✅ 进门后世界：pano 包裹你（符合“进入星空世界”）
  insideGroup = new THREE.Group();
  insideGroup.visible = false;

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(10.5, 48, 36),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  insideGroup.add(insideSphere);

  // 少量星点点缀
  const insideStars = makeStarFieldPoints(1600, 10);
  insideGroup.add(insideStars);

  // 保证盖在现实上
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

  // 先 lookAt 正对相机
  const lookAtPos = camPos.clone();
  lookAtPos.y = targetPos.y;
  doorGroup.lookAt(lookAtPos);

  // ✅ 再加 yaw 偏移修正模型“侧对”的问题
  doorGroup.rotateY(DOOR_YAW_OFFSET);

  prevSignedBackDist = signedBackDistance(xrCam);

  placed = true;
  reticle.visible = false;
  ensureBGMStarted();
}

// 相机沿门后方向(+Z)的有符号距离：>0 在门后，<0 在门前
function signedBackDistance(xrCam) {
  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const doorPos = new THREE.Vector3();
  doorGroup.getWorldPosition(doorPos);

  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const backDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();

  return camPos.sub(doorPos).dot(backDir);
}

function updatePortalState() {
  if (!placed || !doorGroup || !portalWindowGroup) return;

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 门洞裁剪：保证门前只看到“门洞里的世界”，不会露出矩形大图
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

  // 必须“穿过门平面”才切换
  const dist = signedBackDistance(xrCam);

  if (!isInside && prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M) {
    isInside = true;
    insideGroup.visible = true;
  }
  if (isInside && prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M) {
    isInside = false;
    insideGroup.visible = false;
  }

  prevSignedBackDist = dist;

  // inside 跟随相机（进入世界）
  if (insideGroup && insideGroup.visible) {
    const camPos = new THREE.Vector3();
    xrCam.getWorldPosition(camPos);
    insideGroup.position.copy(camPos);
  }

  // 进门后隐藏“窗口”，保证门外=现实、门内=星空
  portalWindowGroup.visible = !isInside;
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render(_, frame) {
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
