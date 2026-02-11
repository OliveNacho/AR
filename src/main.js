import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 你可以先只改这三个参数（不用看别的） **/
const DOOR_TARGET_HEIGHT_M = 2.0;      // 门框归一化到约2米高
const PORTAL_OPEN_W = 1.0;            // 门洞宽（米）——不准就调
const PORTAL_OPEN_H = 2.0;            // 门洞高（米）——不准就调
const PORTAL_OFFSET_Z = -0.02;        // 门洞遮罩平面略微放到门后一点点，避免Z-fighting

let camera, scene, renderer;
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let placed = false;        // 是否已放置（放置后锁定）
let doorGroup = null;      // 门框 + 门洞mask + 门内世界
let doorModel = null;      // 归一化后的门框glb

// Portal parts
let portalMaskMesh = null; // 写入 stencil 的门洞平面（不可见）
let portalWorld = null;    // 门内星空世界

// audio
let listener;
let bgm = null;

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  // 关键：开启 stencil
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  // 我们要手动分两次render（先现实+门框，再门内世界），所以关掉autoClear
  renderer.autoClear = false;

  document.body.appendChild(renderer.domElement);

  // lights (让GLB好看点)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  // reticle：只用于“首次放置”
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

  // audio listener on camera
  listener = new THREE.AudioListener();
  camera.add(listener);

  // load door glb
  loadDoorGLB();

  // AR button
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: document.body },
    })
  );

  // 一个 Reset 按钮（iOS WebXR Viewer也能点）
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
    if (doorGroup) {
      scene.remove(doorGroup);
      doorGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
          else o.material.dispose?.();
        }
      });
      doorGroup = null;
      portalMaskMesh = null;
      portalWorld = null;
    }
    // 音乐不强制停止（iOS上stop后再play可能需要手势），你要停也可以：
    // if (bgm && bgm.isPlaying) bgm.stop();
    // bgm = null;
  };
  document.body.appendChild(btn);
}

// ===== Door loading & normalization =====

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

function normalizeDoorModel(model, targetHeightMeters = 2.0) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);

  if (!isFinite(size.y) || size.y <= 0) return;

  const scale = targetHeightMeters / size.y;
  model.scale.setScalar(scale);

  const box2 = new THREE.Box3().setFromObject(model);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);

  // 水平居中到 x/z=0
  model.position.x += (0 - center2.x);
  model.position.z += (0 - center2.z);

  // 底部贴地：minY -> 0
  model.position.y += (0 - box2.min.y);

  // 若发现门朝向反了就打开（你测试后告诉我是否反）
  // model.rotateY(Math.PI);
}

// ===== Portal building (stencil mask + sky world) =====

function buildDoorGroupOnce() {
  doorGroup = new THREE.Group();

  // 1) 门框
  if (doorModel) {
    const clone = doorModel.clone(true);
    doorGroup.add(clone);
  } else {
    // 兜底门框
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1, 2, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
    );
    frame.position.set(0, 1.0, 0);
    doorGroup.add(frame);
  }

  // 2) 门洞mask：写入 stencil=1，但不显示颜色（不可见）
  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,       // 不渲染颜色（避免你看到黑色矩形）
    depthWrite: true,
    depthTest: true,
  });

  // stencil 写入配置
  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMaskMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PORTAL_OPEN_W, PORTAL_OPEN_H),
    maskMat
  );

  // 门洞中心高度：半高
  portalMaskMesh.position.set(0, PORTAL_OPEN_H / 2, PORTAL_OFFSET_Z);
  portalMaskMesh.renderOrder = 1;
  doorGroup.add(portalMaskMesh);

  // 3) 门内世界：放在门后
  portalWorld = buildPortalWorld();
  portalWorld.renderOrder = 2;
  doorGroup.add(portalWorld);

  scene.add(doorGroup);
}

function buildPortalWorld() {
  const group = new THREE.Group();

  const panoTex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTex.colorSpace = THREE.SRGBColorSpace;

  // 星空球（放在门后方）
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(5, 64, 48),
    new THREE.MeshBasicMaterial({ map: panoTex, side: THREE.BackSide })
  );
  sphere.position.set(0, 1.2, -3);

  // 关键：让“门内世界”只在 stencil==1 的地方显示
  // 给 portalWorld 里所有mesh统一配置 stencil test
  sphere.material.stencilWrite = true;            // 注意：这里不是写入，是“启用测试并保持”
  sphere.material.stencilRef = 1;
  sphere.material.stencilFunc = THREE.EqualStencilFunc;
  sphere.material.stencilFail = THREE.KeepStencilOp;
  sphere.material.stencilZFail = THREE.KeepStencilOp;
  sphere.material.stencilZPass = THREE.KeepStencilOp;

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
      audio.play(); // 必须在用户手势后：我们在 onSelect 里触发
    },
    undefined,
    (err) => console.error("Failed to load bg.flac", err)
  );

  bgm = audio;
}

// ===== Placement =====

function onSelect() {
  // 放置完成后不再响应“点击放置”（你后续做划动流星时不会被它打断）
  if (placed) return;

  if (!reticle.visible) return;

  // 第一次创建门
  if (!doorGroup) buildDoorGroupOnce();

  // 放到命中位置
  doorGroup.position.setFromMatrixPosition(reticle.matrix);
  doorGroup.quaternion.setFromRotationMatrix(reticle.matrix);

  // 强制竖直：只保留yaw
  const euler = new THREE.Euler().setFromQuaternion(doorGroup.quaternion, "YXZ");
  euler.x = 0;
  euler.z = 0;
  doorGroup.quaternion.setFromEuler(euler);

  // 放置完成：锁定
  placed = true;
  reticle.visible = false;

  // 放置那一下启动音乐
  ensureBGMStarted();
}

// ===== Render loop with hit-test =====

function animate() {
  renderer.setAnimationLoop(render);
}

function render(_, frame) {
  // 只在未放置时做 hit-test + 显示准星
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

  // 两阶段渲染：
  // A) 先画“现实场景 + 门框 + 写入stencil的门洞mask”
  // B) 再画“门内世界”，但它只会出现在门洞区域（stencil==1）
  renderer.clear();
  renderer.clearStencil();

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
