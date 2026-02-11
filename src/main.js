import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 你只需要先关注这几个参数 **/
const DOOR_TARGET_HEIGHT_M = 2.2; // 门整体目标高度（2.0~2.3都行，先用2.2更“可走进去”）
const PLACE_DISTANCE_M = 1.6;     // 放到用户正前方的距离（米）
const PORTAL_OPEN_W = 1.0;        // 门洞遮罩宽（米）——后面可再微调
const PORTAL_OPEN_H = 2.0;        // 门洞遮罩高（米）——后面可再微调
const PORTAL_MASK_Z = -0.02;      // 遮罩略微在门后，避免闪烁
const PORTAL_WORLD_Z = -3.0;      // 门内世界放在门后多远（米）

let camera, scene, renderer;
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let placed = false;
let doorGroup = null;
let doorModel = null;

// portal
let portalMaskMesh = null;
let portalWorld = null;

// audio
let listener;
let bgm = null;

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  // 关键：stencil 必须开启
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  // 我们要两次 render，所以 autoClear 关掉
  renderer.autoClear = false;

  document.body.appendChild(renderer.domElement);

  // light for GLB
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  // reticle（只用于第一次放置）
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

  // load door
  loadDoorGLB();

  // AR button (hit-test)
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
    reticle.visible = false;
    if (doorGroup) scene.remove(doorGroup);
    doorGroup = null;
    portalMaskMesh = null;
    portalWorld = null;
    // 音乐不强停，避免 iOS 重新播放需要额外手势
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

function normalizeDoorModel(model, targetHeightMeters = 2.2) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!isFinite(size.y) || size.y <= 0) return;

  const scale = targetHeightMeters / size.y;
  model.scale.setScalar(scale);

  const box2 = new THREE.Box3().setFromObject(model);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);

  // 居中
  model.position.x += (0 - center2.x);
  model.position.z += (0 - center2.z);

  // 落地
  model.position.y += (0 - box2.min.y);

  // 如果你测试发现门总是背对你，再打开这行：
  // model.rotateY(Math.PI);
}

// ===== Portal build (stencil) =====
function buildDoorGroupOnce() {
  doorGroup = new THREE.Group();

  // layer 0：现实 + 门框 + mask
  doorGroup.layers.set(0);

  // 门框
  if (doorModel) {
    const clone = doorModel.clone(true);
    clone.layers.set(0);
    doorGroup.add(clone);
  } else {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1, 2.2, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
    );
    frame.position.set(0, 1.1, 0);
    frame.layers.set(0);
    doorGroup.add(frame);
  }

  // 门洞 mask：只写 stencil，不写颜色，不写 depth（关键！）
  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,   // ✅ 关键：不写深度，否则门内世界会被挡住
    depthTest: true,
  });

  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMaskMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PORTAL_OPEN_W, PORTAL_OPEN_H),
    maskMat
  );
  portalMaskMesh.position.set(0, PORTAL_OPEN_H / 2, PORTAL_MASK_Z);
  portalMaskMesh.renderOrder = 10;
  portalMaskMesh.layers.set(0);
  doorGroup.add(portalMaskMesh);

  // 门内世界：layer 1，只在 stencil==1 的地方渲染
  portalWorld = buildPortalWorld();
  portalWorld.layers.set(1);
  portalWorld.renderOrder = 20;
  doorGroup.add(portalWorld);

  scene.add(doorGroup);
}

function buildPortalWorld() {
  const group = new THREE.Group();

  const panoTex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTex.colorSpace = THREE.SRGBColorSpace;

  const sphereMat = new THREE.MeshBasicMaterial({
    map: panoTex,
    side: THREE.BackSide,
  });

  // stencil test：只在门洞区域显示
  sphereMat.stencilWrite = true;
  sphereMat.stencilRef = 1;
  sphereMat.stencilFunc = THREE.EqualStencilFunc;
  sphereMat.stencilFail = THREE.KeepStencilOp;
  sphereMat.stencilZFail = THREE.KeepStencilOp;
  sphereMat.stencilZPass = THREE.KeepStencilOp;

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(5, 64, 48), sphereMat);
  sphere.position.set(0, 1.2, PORTAL_WORLD_Z);

  // layer 1
  sphere.layers.set(1);

  group.add(sphere);
  return group;
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
      audio.play(); // 必须在用户手势内：onSelect
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

  // 取“地面y”来自命中点
  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);

  // 把门放到“相机正前方固定距离”，但高度贴地（更符合你的需求）
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  // 只取水平朝向（避免抬头低头导致门飞）
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();

  const targetPos = camPos.clone().add(dir.multiplyScalar(PLACE_DISTANCE_M));
  targetPos.y = hitPos.y; // 落地

  doorGroup.position.copy(targetPos);

  // 门永远“正对相机”（人类习惯）
  const lookAtPos = camPos.clone();
  lookAtPos.y = targetPos.y;
  doorGroup.lookAt(lookAtPos);

  // 放置完成：锁定 + 隐藏准星 + 播放音乐
  placed = true;
  reticle.visible = false;
  ensureBGMStarted();
}

// ===== Render loop =====
function animate() {
  renderer.setAnimationLoop(render);
}

function render(_, frame) {
  // 未放置才做 hit-test / reticle
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
        reticle.visible = false;
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

  // 两次渲染：先 layer0（门框+mask写stencil），再 layer1（门内世界stencil==1）
  renderer.clear();
  renderer.clearStencil();

  // Pass A: 现实 + 门框 + mask
  camera.layers.set(0);
  renderer.render(scene, camera);

  // Pass B: 门内世界（只在门洞显示）
  camera.layers.set(1);
  renderer.render(scene, camera);

  // 还原
  camera.layers.set(0);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
