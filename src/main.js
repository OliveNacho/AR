import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** ✅ 你已调好的参数 **/
const DOOR_TARGET_HEIGHT_M = 2.10;
const PLACE_DISTANCE_M = 1.60;
const DOOR_SCALE_MULT = 0.90;
const DOOR_YAW_OFFSET = Math.PI / 2;

/** 门洞估算（按门整体包围盒比例） */
const HOLE_WIDTH_FACTOR = 0.56;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;

/** 穿门判定：必须跨过门洞平面 */
const ENTER_THRESHOLD_M = 0.14;
const EXIT_THRESHOLD_M = 0.08;

/** 星空增强 */
const WINDOW_STAR_COUNT = 3500;
const INSIDE_STAR_COUNT = 8000;
const WINDOW_NEBULA_COUNT = 7;
const INSIDE_NEBULA_COUNT = 12;

/** Layers（关键：主pass永远不画星空） */
const LAYER_MAIN = 0;   // 门框/现实叠加内容
const LAYER_MASK = 1;   // 门洞遮罩（只写 stencil）
const LAYER_PORTAL = 2; // 门洞里看到的星空窗口
const LAYER_INSIDE = 3; // 门内 360° 星空世界

let scene, renderer;
let baseCamera, controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let doorModel = null;
let doorGroup = null;

// ✅ 门洞rig：保证遮罩和窗口内容方向永远一致
let portalRig = null;
let portalMaskMesh = null;
let portalContentGroup = null;

let insideGroup = null;

let placed = false;
let isInside = false;

let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

let portalCenterWorld = new THREE.Vector3();
let portalBackDirWorld = new THREE.Vector3(0, 0, 1);
let prevSignedBackDist = 0;

// audio
let listener;
let bgm = null;

const _tmpCamPos = new THREE.Vector3();

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
    stencil: true, // ✅ 必须：Stencil Portal
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.autoClear = false; // ✅ 多pass手动clear
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

  // audio listener（必须挂在 camera）
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

  portalRig = null;
  portalMaskMesh = null;
  portalContentGroup = null;

  if (insideGroup) scene.remove(insideGroup);
  insideGroup = null;

  // 停掉bgm（可选）
  if (bgm && bgm.isPlaying) bgm.stop();
  bgm = null;
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

/** ✅ pano.jpg 是标准 2:1 ERP（equirectangular） */
function loadPanoTexture() {
  const tex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;

  // 可选：避免左右接缝 & 修正内球常见镜像（若你看到左右反了，把 repeat/offset 这三行注释掉）
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.x = -1;
  tex.offset.x = 1;

  // 如果你以后改用 scene.background，需要这行
  tex.mapping = THREE.EquirectangularReflectionMapping;

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

/** 程序生成星云纹理 */
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

/** 拱门形状：下矩形 + 上半圆 */
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

/** 门洞中心（世界坐标） */
function computePortalCenterWorld() {
  portalCenterWorld.set(0, holeCenterY, 0);
  doorGroup.localToWorld(portalCenterWorld);
}

/** 放门瞬间锁定“门后方向”，保证相机此刻在门前侧 */
function initPortalBackDirection(xrCam) {
  // doorGroup 的 forward 取 -Z
  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  portalBackDirWorld.copy(forward).multiplyScalar(-1); // back = -forward

  computePortalCenterWorld();

  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const d0 = camPos.clone().sub(portalCenterWorld).dot(portalBackDirWorld);
  if (d0 > 0) portalBackDirWorld.multiplyScalar(-1); // 保证放门时相机在门前
}

/** >0 门后，<0 门前 */
function signedBackDistance(xrCam) {
  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);
  computePortalCenterWorld();
  return camPos.sub(portalCenterWorld).dot(portalBackDirWorld);
}

/**
 * ✅ 核心：把 portalRig（mask+窗口）强制对齐到“门洞平面法线”
 * - 彻底修掉：正对门时 mask 变细线/方向错
 */
function alignPortalRigToDoorPlane() {
  if (!portalRig) return;

  const back = portalBackDirWorld.clone().normalize();

  // 我们希望 portalRig 的 +Z 指向“门前侧法线”，这样“门后”就是 -Z
  const targetNormalWorld = back.clone().negate();

  const qWorld = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    targetNormalWorld
  );

  // 把 world quaternion 转成 doorGroup 局部 quaternion
  const doorWorldQ = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const doorWorldInv = doorWorldQ.clone().invert();
  const qLocal = doorWorldInv.multiply(qWorld);

  portalRig.quaternion.copy(qLocal);
}

function buildOnce() {
  doorGroup = new THREE.Group();
  doorGroup.layers.set(LAYER_MAIN);

  if (doorModel) {
    const m = doorModel.clone(true);
    m.traverse((o) => o.layers && o.layers.set(LAYER_MAIN));
    doorGroup.add(m);
  } else {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, DOOR_TARGET_HEIGHT_M, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
    );
    frame.position.set(0, DOOR_TARGET_HEIGHT_M / 2, 0);
    frame.layers.set(LAYER_MAIN);
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

  // ✅ portalRig：专门负责 mask + portal窗口内容（方向由 alignPortalRigToDoorPlane 控制）
  portalRig = new THREE.Group();
  portalRig.layers.set(LAYER_MAIN); // rig 本身无所谓，内部各自分层
  doorGroup.add(portalRig);

  // 1) Mask：只写 stencil，不写颜色
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false,  // ✅ 不吃深度，避免“正对只剩细线”
    side: THREE.DoubleSide,
  });

  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(0, holeCenterY, 0.02); // ✅ 沿 +Z 稍微朝“门前”推一点
  portalMaskMesh.layers.set(LAYER_MASK);
  portalRig.add(portalMaskMesh);

  // 2) 门洞内星空窗口（Sphere 内壁，不是平面）
  portalContentGroup = new THREE.Group();
  portalContentGroup.layers.set(LAYER_PORTAL);
  portalRig.add(portalContentGroup);

  const pano = loadPanoTexture();

  // 注意：portalRig 对齐后，“门后”方向是 -Z
  const windowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(10.0, 64, 48),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide,
      depthTest: true,
      depthWrite: false,
    })
  );
  windowSphere.position.set(0, holeCenterY, -6.2);
  windowSphere.layers.set(LAYER_PORTAL);
  portalContentGroup.add(windowSphere);

  const windowStars = makeStarFieldPoints(WINDOW_STAR_COUNT, 12.5, 0.095);
  windowStars.position.set(0, holeCenterY, -6.2);
  windowStars.layers.set(LAYER_PORTAL);
  portalContentGroup.add(windowStars);

  for (let i = 0; i < WINDOW_NEBULA_COUNT; i++) {
    const neb = makeNebulaBillboard(i * 0.41, 5.6 + Math.random() * 2.4);
    neb.position.set(
      (Math.random() - 0.5) * 3.8,
      holeCenterY + (Math.random() - 0.15) * 3.0,
      -5.5 - Math.random() * 5.0
    );
    neb.rotation.y = Math.random() * Math.PI;
    neb.layers.set(LAYER_PORTAL);
    portalContentGroup.add(neb);
  }

  // 3) 门内 360° 星空世界（跟随相机，不是平面）
  insideGroup = new THREE.Group();
  insideGroup.layers.set(LAYER_INSIDE);
  insideGroup.visible = false;
  scene.add(insideGroup);

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(14.5, 64, 48),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide, // ✅ 关键：在球体内部看内壁
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

  // ✅ 防止“进门后消失”：禁用视锥剔除，保证总能渲染
  insideGroup.traverse((o) => {
    o.frustumCulled = false;
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        m.depthTest = false;
        m.depthWrite = false;
      });
    }
  });
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

  // ✅ 锁定门后方向 + 立即对齐 portalRig（修掉 mask 方向导致的“细线”）
  initPortalBackDirection(xrCam);
  alignPortalRigToDoorPlane();

  // 强制门外开始
  isInside = false;
  if (insideGroup) insideGroup.visible = false;

  prevSignedBackDist = signedBackDistance(xrCam);

  placed = true;
  reticle.visible = false;

  // ✅ 用户手势触发音频
  ensureBGMStarted();
}

function updatePortalState() {
  if (!placed || !doorGroup) return;

  const xrCam = renderer.xr.getCamera(baseCamera);

  const dist = signedBackDistance(xrCam);
  const crossedToBack = prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M;
  const crossedToFront = prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M;

  if (!isInside && crossedToBack) {
    isInside = true;
  } else if (isInside && crossedToFront) {
    isInside = false;
  }

  prevSignedBackDist = dist;

  // 门内世界跟随相机（确保 360° 包裹）
  if (insideGroup) {
    if (isInside) {
      xrCam.getWorldPosition(_tmpCamPos);
      insideGroup.position.copy(_tmpCamPos);

      // 可选：让星空跟随头部旋转（更沉浸；不想跟随可注释）
      insideGroup.quaternion.copy(xrCam.quaternion);

      insideGroup.visible = true;
    } else {
      insideGroup.visible = false;
    }
  }
}

function animate() {
  renderer.setAnimationLoop(render);
}

/**
 * ✅ 多pass渲染顺序（稳定实现：门外现实 + 门洞窗口 + 门内360）
 * 1) MAIN：画门框（现实背景保持）
 * 2) OUTSIDE：Stencil 写 mask，然后只在 mask 区域画 PORTAL layer
 * 3) INSIDE：穿门后画 INSIDE layer（全屏包裹）
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
  const gl = renderer.getContext();

  // 清理（保持AR相机背景：alpha renderer）
  renderer.clear(true, true, true);

  // 1) MAIN pass
  xrCam.layers.set(LAYER_MAIN);
  renderer.render(scene, xrCam);

  if (!placed) return;

  // 2) 门外：Stencil portal（门洞窗口）
  if (!isInside && portalMaskMesh && portalContentGroup) {
    gl.enable(gl.STENCIL_TEST);

    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    // 2.1 写 stencil = 1（MASK layer）
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

    xrCam.layers.set(LAYER_MASK);
    renderer.render(scene, xrCam);

    // 2.2 只在 stencil==1 画 PORTAL layer
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

    xrCam.layers.set(LAYER_PORTAL);
    renderer.render(scene, xrCam);

    gl.disable(gl.STENCIL_TEST);
  }

  // 3) 门内：画 INSIDE layer（360°世界）
  if (isInside && insideGroup && insideGroup.visible) {
    xrCam.layers.set(LAYER_INSIDE);
    renderer.render(scene, xrCam);
  }
}

function onWindowResize() {
  baseCamera.aspect = window.innerWidth / window.innerHeight;
  baseCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
