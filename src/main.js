import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 你主要调这几个参数 **/
const DOOR_TARGET_HEIGHT_M = 2.4; // 门更高一点（你要1.6~1.9m能不低头进门，2.3~2.5都合理）
const PLACE_DISTANCE_M = 1.25;    // 门更近一点（原来1.6偏远）
const PORTAL_OPEN_W = 1.05;       // 门洞遮罩宽（不准再调）
const PORTAL_OPEN_H = 2.05;       // 门洞遮罩高（不准再调）
const PORTAL_MASK_Z = -0.02;      // 遮罩略微在门后
const PORTAL_WORLD_Z = -3.0;      // 门洞里看到的星空在门后多远（不影响“走进门后”的包裹效果）

// 你“穿过门”的判定阈值（单位：米，越大越容易触发“进入门内模式”）
const ENTER_THRESHOLD_Z = -0.05;

let camera, scene, renderer;
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let placed = false;
let doorGroup = null;
let doorModel = null;

// portal
let portalMaskMesh = null;     // stencil门洞
let portalWindowWorld = null;  // 门洞里看到的星空（stencil限制）
let insideSky = null;          // 进入门内后，贴相机的星空球（遮住现实）

// audio
let listener;
let bgm = null;

// runtime
let isInside = false;

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);

  // lights (for GLB)
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

  // audio listener
  listener = new THREE.AudioListener();
  camera.add(listener);

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
  btn.onclick = () => {
    placed = false;
    isInside = false;
    reticle.visible = false;
    if (doorGroup) scene.remove(doorGroup);
    doorGroup = null;
    portalMaskMesh = null;
    portalWindowWorld = null;
    if (insideSky) {
      camera.remove(insideSky);
      insideSky = null;
    }
  };
  document.body.appendChild(btn);
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

function normalizeDoorModel(model, targetHeightMeters = 2.4) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!isFinite(size.y) || size.y <= 0) return;

  const scale = targetHeightMeters / size.y;
  model.scale.setScalar(scale);

  const box2 = new THREE.Box3().setFromObject(model);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);

  // center x/z
  model.position.x += (0 - center2.x);
  model.position.z += (0 - center2.z);

  // ground
  model.position.y += (0 - box2.min.y);

  // 如果你之后发现门总是背对你，再打开：
  // model.rotateY(Math.PI);
}

// ===== Portal build =====
function buildDoorGroupOnce() {
  doorGroup = new THREE.Group();
  doorGroup.layers.set(0); // layer0: reality + frame + stencil writer

  // frame
  if (doorModel) {
    const clone = doorModel.clone(true);
    clone.layers.set(0);
    doorGroup.add(clone);
  } else {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1, 2.4, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
    );
    frame.position.set(0, 1.2, 0);
    frame.layers.set(0);
    doorGroup.add(frame);
  }

  // portal mask: write stencil=1, no color, no depth write
  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: true,
  });
  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMaskMesh = new THREE.Mesh(new THREE.PlaneGeometry(PORTAL_OPEN_W, PORTAL_OPEN_H), maskMat);
  portalMaskMesh.position.set(0, PORTAL_OPEN_H / 2, PORTAL_MASK_Z);
  portalMaskMesh.renderOrder = 10;
  portalMaskMesh.layers.set(0);
  doorGroup.add(portalMaskMesh);

  // "window" world: only visible through stencil==1 (doorway)
  portalWindowWorld = buildPortalWindowWorld();
  portalWindowWorld.layers.set(1); // layer1 render pass
  portalWindowWorld.renderOrder = 20;
  doorGroup.add(portalWindowWorld);

  scene.add(doorGroup);

  // inside sky: attach to camera (initially hidden)
  insideSky = buildInsideSky();
  insideSky.visible = false;
  camera.add(insideSky);
}

function loadPanoTexture() {
  const tex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildPortalWindowWorld() {
  const group = new THREE.Group();
  const panoTex = loadPanoTexture();

  const mat = new THREE.MeshBasicMaterial({ map: panoTex, side: THREE.BackSide });

  // stencil test: only where portal mask wrote 1
  mat.stencilWrite = true;
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.EqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(5, 64, 48), mat);
  sphere.position.set(0, 1.2, PORTAL_WORLD_Z);
  sphere.layers.set(1);

  group.add(sphere);
  return group;
}

// 进入门内后：用一个贴在相机上的球体，把现实遮住，让你“真的在星空里”
function buildInsideSky() {
  const panoTex = loadPanoTexture();

  const mat = new THREE.MeshBasicMaterial({
    map: panoTex,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false, // 直接盖住一切（包含相机现实背景）
  });

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(6, 64, 48), mat);
  sphere.layers.set(2); // layer2 pass
  return sphere;
}

// ===== Audio =====
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

// ===== Placement =====
function onSelect() {
  if (placed) return;
  if (!reticle.visible) return;

  if (!doorGroup) buildDoorGroupOnce();

  // ground y from hit
  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);

  // place in front of camera at fixed distance (horizontal)
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();

  const targetPos = camPos.clone().add(dir.multiplyScalar(PLACE_DISTANCE_M));
  targetPos.y = hitPos.y;

  doorGroup.position.copy(targetPos);

  // face camera
  const lookAtPos = camPos.clone();
  lookAtPos.y = targetPos.y;
  doorGroup.lookAt(lookAtPos);

  placed = true;
  reticle.visible = false;

  ensureBGMStarted();
}

// ===== Inside detection =====
function updateInsideState() {
  if (!placed || !doorGroup) return;

  const camWorld = new THREE.Vector3();
  camera.getWorldPosition(camWorld);

  // camera position in door local space
  const local = doorGroup.worldToLocal(camWorld.clone());

  // 约定：doorGroup 的 -Z 是“门内方向”（因为我们把门 lookAt 相机，门正面朝相机）
  // 所以当相机穿过门洞平面到 local.z < 0，就算“进门”
  const nowInside = local.z < ENTER_THRESHOLD_Z;

  if (nowInside !== isInside) {
    isInside = nowInside;
    if (insideSky) insideSky.visible = isInside;
  }
}

// ===== Render loop =====
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
        placed = false;
        isInside = false;
        reticle.visible = false;
        if (insideSky) insideSky.visible = false;
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

  // update inside/outside
  updateInsideState();

  // Pass A: layer0 (frame + stencil writer)
  renderer.clear();
  renderer.clearStencil();

  camera.layers.set(0);
  renderer.render(scene, camera);

  // Pass B: layer1 (portal window world, stencil==1)
  camera.layers.set(1);
  renderer.render(scene, camera);

  // Pass C: layer2 (inside sky attached to camera, only when inside)
  if (insideSky && insideSky.visible) {
    camera.layers.set(2);
    renderer.render(scene, camera);
  }

  // restore
  camera.layers.set(0);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
