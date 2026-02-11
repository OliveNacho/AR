import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 你主要调这几个 **/
const DOOR_TARGET_HEIGHT_M = 2.65; // 门更高
const PLACE_DISTANCE_M = 1.0;      // 门更近

// 门洞估算（按门整体包围盒比例）
const HOLE_WIDTH_FACTOR = 0.55;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;

// 穿门判定：必须“从门前穿到门后”才触发
const ENTER_THRESHOLD_M = 0.12; // 穿过门平面后，沿门后方向的距离超过这个才算进门
const EXIT_THRESHOLD_M = 0.06;  // 回到门前小距离内算出门（滞回，避免抖动）

// 门洞裁剪深度（门后内容保留多深）
const PORTAL_DEPTH_M = 8.0;

let scene, renderer;
let baseCamera; // 逻辑相机（XR 下真实相机用 renderer.xr.getCamera）
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let placed = false;
let isInside = false;

let doorGroup = null;
let doorModel = null;

// door hole params (computed after door built)
let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

// portal content: ✅ 挂在 doorGroup 下，永远跟着门走
let portalWindowGroup = null; // 门外通过门洞看到的星空内容（被裁剪）
let insideGroup = null;       // 进门后包裹相机的世界
let prevSignedBackDist = 0;   // 上一帧相机相对门的“背面投影距离”

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

  // ✅ 本地裁剪：不依赖 stencil
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

  // insideGroup 是加在 scene 上的，但只跟随相机位置；重置移除
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

/** 生成一个圆形“星点”sprite贴图（解决方块点） */
function makeStarSpriteTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");

  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, "rgba(255,255,255,1)");
  grd.addColorStop(0.2, "rgba(255,255,255,0.9)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.25)");
  grd.addColorStop(1.0, "rgba(255,255,255,0)");

  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 立体星空：点分布在相机周围的球壳上 */
function makeStarFieldPoints(count = 2000, radius = 10) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    // 随机方向 + 球壳半径
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.7 + 0.3 * Math.random());

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
    size: 0.08,
    sizeAttenuation: true,
  });

  return new THREE.Points(geo, mat);
}

/** 门洞矩形裁剪平面（世界空间），让“门外只看见门洞里的内容” */
function computeDoorClippingPlanes() {
  const hw = holeW / 2;
  const hh = holeH / 2;

  // 门洞在 doorGroup 局部空间：中心 (0, holeCenterY, 0)
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

  // 门洞内部方向：朝“洞内”保留的半空间
  const nLeft = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const nRight = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
  const nTop = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
  const nBottom = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

  // 前裁剪：裁掉门前的 portal 内容，只保留门后（doorGroup.lookAt(camera) => -Z朝相机，+Z为门后）
  const backDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const nFront = backDir.clone().negate(); // 让“门后”是保留半空间
  const pFront = wC.clone();

  // 再加一个“深度后裁剪”，避免无限远内容（可选，但更稳）
  const pBack = wC.clone().add(backDir.clone().multiplyScalar(PORTAL_DEPTH_M));
  const nBack = backDir.clone(); // 保留 <= pBack 这一侧

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
  // --- doorGroup ---
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

  // 用门框包围盒估算门洞
  const box = new THREE.Box3().setFromObject(doorGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  holeW = Math.max(0.7, size.x * HOLE_WIDTH_FACTOR);
  holeH = Math.max(1.8, size.y * HOLE_HEIGHT_FACTOR);
  holeCenterY = Math.max(holeH / 2, size.y * HOLE_YCENTER_FACTOR);

  scene.add(doorGroup);

  // --- portalWindowGroup：✅ 挂在门上（关键修复：不再“跑去别的空间”） ---
  portalWindowGroup = new THREE.Group();
  doorGroup.add(portalWindowGroup);

  // 只用“立体星点世界”（不再用你的 jpg 全景，避免你觉得它是“平面图”）
  // 如果你后面换成真正 360 全景，再加回来也行
  const windowStars = makeStarFieldPoints(2600, 12);
  windowStars.position.set(0, holeCenterY, -4.0); // 门后
  portalWindowGroup.add(windowStars);

  // --- insideGroup：进入后包裹相机（也是立体星点） ---
  insideGroup = new THREE.Group();
  insideGroup.visible = false;

  const insideStars = makeStarFieldPoints(4200, 14);
  insideGroup.add(insideStars);

  // 让 insideGroup 永远盖在现实上（不被深度挡）
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

  // ✅ 用 XR Camera 放置
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

  // 门正对你（门正面朝相机）
  const lookAtPos = camPos.clone();
  lookAtPos.y = targetPos.y;
  doorGroup.lookAt(lookAtPos);

  // 初始化穿门判定基线
  prevSignedBackDist = signedBackDistance(xrCam);

  placed = true;
  reticle.visible = false;

  ensureBGMStarted();
}

/** 相机沿“门后方向(+Z)”的有符号距离：>0 在门后，<0 在门前 */
function signedBackDistance(xrCam) {
  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const doorPos = new THREE.Vector3();
  doorGroup.getWorldPosition(doorPos);

  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const backDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(); // 门后方向

  return camPos.sub(doorPos).dot(backDir);
}

function updatePortalState() {
  if (!placed || !doorGroup || !portalWindowGroup) return;

  const xrCam = renderer.xr.getCamera(baseCamera);

  // 1) 每帧重新计算裁剪平面，严格裁到门洞（解决“门前看到大矩形图片”）
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

  // 2) “必须穿过门平面”才进入：用 prevDist -> dist 的跨越判断（解决“一点就全屏星空”）
  const dist = signedBackDistance(xrCam);

  // enter: 从门前(<=0)跨到门后(>ENTER_THRESHOLD)
  if (!isInside && prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M) {
    isInside = true;
    if (insideGroup) insideGroup.visible = true;
  }

  // exit: 从门后(>=0)跨回门前(< -EXIT_THRESHOLD)
  if (isInside && prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M) {
    isInside = false;
    if (insideGroup) insideGroup.visible = false;
  }

  prevSignedBackDist = dist;

  // 3) insideGroup 跟随 XR 相机（真正“进入世界”）
  if (insideGroup && insideGroup.visible) {
    const camPos = new THREE.Vector3();
    xrCam.getWorldPosition(camPos);
    insideGroup.position.copy(camPos);
  }

  // 4) 进门后隐藏“门洞窗口内容”，避免你回头看到“窗户”
  portalWindowGroup.visible = !isInside;
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

  // ✅ 用 XR Camera 渲染
  const xrCam = renderer.xr.getCamera(baseCamera);
  renderer.render(scene, xrCam);
}

function onWindowResize() {
  baseCamera.aspect = window.innerWidth / window.innerHeight;
  baseCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
