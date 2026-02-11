import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 你主要调这几个（我按你的反馈先给了更合适的默认值） **/
const DOOR_TARGET_HEIGHT_M = 2.55; // 门更高一点
const PLACE_DISTANCE_M = 1.10;     // 门更近一点（避免太远）

/**
 * 门洞遮罩自适应参数（按门框包围盒算门洞）：
 * - widthFactor / heightFactor：门洞占门整体宽/高的比例（门框通常会比洞大一圈）
 * - yCenterFactor：门洞中心在门整体高度中的位置（通常略高于 0.5）
 */
const HOLE_WIDTH_FACTOR = 0.55;
const HOLE_HEIGHT_FACTOR = 0.75; // 调整比例，减少穿帮
const HOLE_YCENTER_FACTOR = 0.53;

const PORTAL_MASK_Z = -0.03;  // 遮罩稍微放门后一点
const PORTAL_WINDOW_Z = -3.0; // 门外从门洞看到的星空球心在门后多远

/** 进门判定阈值：越过门洞平面一点点就算进门 */
const ENTER_THRESHOLD_Z = 0.06;

let camera, scene, renderer;
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let placed = false;
let isInside = false;

let doorGroup = null;
let doorModel = null;

// portal parts
let portalMaskMesh = null;
let portalWindowWorld = null;
let insideSky = null;

// audio
let listener;
let bgm = null;

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 60);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);

  // lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.75);
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

  // center x/z
  model.position.x += (0 - center2.x);
  model.position.z += (0 - center2.z);

  // ground
  model.position.y += (0 - box2.min.y);
}

// ===== Portal build =====
function buildDoorGroupOnce() {
  doorGroup = new THREE.Group();
  doorGroup.layers.set(0);

  // frame
  if (doorModel) {
    const clone = doorModel.clone(true);
    clone.layers.set(0);
    doorGroup.add(clone);
  } else {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1, DOOR_TARGET_HEIGHT_M, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
    );
    frame.position.set(0, DOOR_TARGET_HEIGHT_M / 2, 0);
    frame.layers.set(0);
    doorGroup.add(frame);
  }

  // 用门框包围盒自动估门洞尺寸/位置（避免穿帮）
  const doorBox = new THREE.Box3().setFromObject(doorGroup);
  const doorSize = new THREE.Vector3();
  doorBox.getSize(doorSize);

  const holeW = Math.max(0.6, doorSize.x * HOLE_WIDTH_FACTOR);
  const holeH = Math.max(1.7, doorSize.y * HOLE_HEIGHT_FACTOR);
  const holeCenterY = Math.max(holeH / 2, doorSize.y * HOLE_YCENTER_FACTOR);

  // stencil mask
  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: true,
  });
  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMaskMesh = new THREE.Mesh(new THREE.PlaneGeometry(holeW, holeH), maskMat);
  portalMaskMesh.position.set(0, holeCenterY, PORTAL_MASK_Z);
  portalMaskMesh.renderOrder = 10;
  portalMaskMesh.layers.set(0);
  doorGroup.add(portalMaskMesh);

  // 门洞里看到的星空（window）
  portalWindowWorld = buildPortalWindowWorld();
  portalWindowWorld.layers.set(1);
  portalWindowWorld.renderOrder = 20;
  doorGroup.add(portalWindowWorld);

  scene.add(doorGroup);

  // 进门后包裹你的星空
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

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(6, 64, 48), mat);
  sphere.position.set(0, 1.25, PORTAL_WINDOW_Z);
  sphere.layers.set(1);

  group.add(sphere);
  return group;
}

function buildInsideSky() {
  const panoTex = loadPanoTexture();

  const mat = new THREE.MeshBasicMaterial({
    map: panoTex,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false, // 直接覆盖现实
  });

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(7, 64, 48), mat);
  sphere.layers.set(2);
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

  // ground y
  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);

  // place in front of camera (horizontal)
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

  // camera in door local
  const local = doorGroup.worldToLocal(camWorld.clone());

  /**
   * 关键修正：
   * doorGroup.lookAt(camera) 会让 door 的 -Z 指向相机（门“正面”朝你）
   * 所以你穿过门洞走到“门后面”时，相机位于 door 的 +Z 侧
   * → 进门条件应该是 local.z > threshold
   */
  const nowInside = local.z > ENTER_THRESHOLD_Z;

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

  updateInsideState();

  renderer.clear();
  renderer.clearStencil();

  // Pass A: frame + stencil writer
  camera.layers.set(0);
  renderer.render(scene, camera);

  // Pass B: portal window world (stencil==1)
  camera.layers.set(1);
  renderer.render(scene, camera);

  // Pass C: inside sky (cover reality)
  if (insideSky && insideSky.visible) {
    camera.layers.set(2);
    renderer.render(scene, camera);
  }

  camera.layers.set(0);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
