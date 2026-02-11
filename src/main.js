import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** ✅ 你已调好的参数 **/
const DOOR_TARGET_HEIGHT_M = 2.10;
const PLACE_DISTANCE_M = 1.60;
const DOOR_SCALE_MULT = 0.90;
const DOOR_YAW_OFFSET = Math.PI / 2;

/** 门洞估算 */
const HOLE_WIDTH_FACTOR = 0.56;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;

/** 穿门判定：必须跨过门洞平面 */
const ENTER_THRESHOLD_M = 0.14;
const EXIT_THRESHOLD_M = 0.08;

/** 星云/星点数量（你要多一些） */
const WINDOW_STAR_COUNT = 3500;
const INSIDE_STAR_COUNT = 8000;
const WINDOW_NEBULA_COUNT = 7;
const INSIDE_NEBULA_COUNT = 12;

/** 图层（关键：防止“主pass就把星空画出来”） */
const LAYER_MAIN = 0;   // 门框等
const LAYER_MASK = 1;   // 门洞遮罩（只写 stencil）
const LAYER_PORTAL = 2; // 门洞内星空窗口
const LAYER_INSIDE = 3; // 门内全屏星空

let scene, renderer;
let baseCamera, controller;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let doorModel = null;
let doorGroup = null;

let portalMaskMesh = null;      // stencil mask（拱门形状）
let portalContentGroup = null;  // 门洞星空窗口（只在 stencil 内渲染）
let insideGroup = null;         // 进门后全屏星空（仅穿门后渲染）

let placed = false;
let isInside = false;

let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

let portalCenterWorld = new THREE.Vector3();
let portalBackDirWorld = new THREE.Vector3(0, 0, 1);
let prevSignedBackDist = 0;

init();
animate();

function init() {
  scene = new THREE.Scene();

  baseCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 80);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    stencil: true, // ✅ 必须
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.autoClear = false; // ✅ 多pass
  document.body.appendChild(renderer.domElement);

  // 灯光（门框需要）
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

// ===== Textures =====
function loadPanoTexture() {
  const tex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ===== Stars / Nebula (procedural) =====
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

// ===== Portal math =====
function computePortalCenterWorld() {
  portalCenterWorld.set(0, holeCenterY, 0);
  doorGroup.localToWorld(portalCenterWorld);
}

function initPortalBackDirection(xrCam) {
  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  portalBackDirWorld.copy(forward).multiplyScalar(-1); // back = -forward

  computePortalCenterWorld();

  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const d0 = camPos.clone().sub(portalCenterWorld).dot(portalBackDirWorld);
  if (d0 > 0) portalBackDirWorld.multiplyScalar(-1); // 保证放门时相机在门前
}

function signedBackDistance(xrCam) {
  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);
  computePortalCenterWorld();
  return camPos.sub(portalCenterWorld).dot(portalBackDirWorld);
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

  // 估算门洞
  const box = new THREE.Box3().setFromObject(doorGroup);
  const size = new THREE.Vector3();
  box.getSize(size);

  holeW = Math.max(0.75, size.x * HOLE_WIDTH_FACTOR);
  holeH = Math.max(1.65, size.y * HOLE_HEIGHT_FACTOR);
  holeCenterY = Math.max(holeH / 2, size.y * HOLE_YCENTER_FACTOR);

  // 1) Mask（只写 stencil，不写颜色）
  const maskGeo = makeArchMaskGeometry(holeW, holeH);
  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false, // ✅ 关键：不让深度挡住 stencil 写入（解决“正对只剩细线”）
    side: THREE.DoubleSide,
  });
  portalMaskMesh = new THREE.Mesh(maskGeo, maskMat);
  portalMaskMesh.position.set(0, holeCenterY, 0.02); // 稍微朝相机，避免与门框共面
  portalMaskMesh.layers.set(LAYER_MASK);
  doorGroup.add(portalMaskMesh);

  // 2) 门洞星空窗口（只在 portal pass 渲染）
  portalContentGroup = new THREE.Group();
  portalContentGroup.layers.set(LAYER_PORTAL);

  const pano = loadPanoTexture();
  const windowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(10.0, 48, 36),
    new THREE.MeshBasicMaterial({ map: pano, side: THREE.BackSide })
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

  // 注意：portalContentGroup 不 add 到 scene 主结构中（防止主pass画出来）
  // 我们在渲染 portal pass 时单独 renderer.render(portalScene,...)

  // 3) 门内全屏（默认隐藏，穿门才显示；同样不在主pass里画）
  insideGroup = new THREE.Group();
  insideGroup.layers.set(LAYER_INSIDE);

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
  // insideGroup 也不 add 到 scene 主结构；穿门后在渲染 pass 画它
}

// ===== Interaction =====
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

  initPortalBackDirection(xrCam);

  // 强制门外开始
  isInside = false;
  prevSignedBackDist = signedBackDistance(xrCam);

  placed = true;
  reticle.visible = false;
}

function updatePortalState() {
  if (!placed || !doorGroup) return;

  const xrCam = renderer.xr.getCamera(baseCamera);

  const dist = signedBackDistance(xrCam);
  const crossedToBack = prevSignedBackDist <= 0 && dist > ENTER_THRESHOLD_M;
  const crossedToFront = prevSignedBackDist >= 0 && dist < -EXIT_THRESHOLD_M;

  if (!isInside && crossedToBack) isInside = true;
  else if (isInside && crossedToFront) isInside = false;

  prevSignedBackDist = dist;
}

// ===== Render loop (multi-pass stencil) =====
function render(_, frame) {
  // hit-test before placed
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

  // 0) 清屏（保持 AR 相机背景：alpha clear）
  renderer.clear(true, true, true);

  // 1) 主pass：只画门框（现实仍可见）
  xrCam.layers.set(LAYER_MAIN);
  renderer.render(scene, xrCam);

  if (!placed) return;

  // 2) 如果在门外：Stencil portal（门洞内窗口）
  if (!isInside && portalMaskMesh && portalContentGroup) {
    gl.enable(gl.STENCIL_TEST);

    // 清 stencil
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    // 2.1 写 stencil = 1（画 mask）
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

    // 只画 mask（不写颜色、不受深度影响）
    xrCam.layers.set(LAYER_MASK);
    renderer.render(scene, xrCam);

    // 2.2 只在 stencil==1 的区域画 portal 内容
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

    const portalScene = new THREE.Scene();
    portalScene.add(portalContentGroup);

    xrCam.layers.set(LAYER_PORTAL);
    renderer.render(portalScene, xrCam);

    gl.disable(gl.STENCIL_TEST);
  }

  // 3) 如果在门内：全屏星空（覆盖现实）
  if (isInside && insideGroup) {
    const insideScene = new THREE.Scene();
    insideScene.add(insideGroup);

    // 跟随相机，保证全屏包裹
    const camPos = new THREE.Vector3();
    xrCam.getWorldPosition(camPos);
    insideGroup.position.copy(camPos);

    xrCam.layers.set(LAYER_INSIDE);
    renderer.render(insideScene, xrCam);
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
