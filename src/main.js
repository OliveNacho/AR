import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

let camera, scene, renderer;
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let doorGroup = null;
let doorModel = null; // 已归一化（缩放+落地+居中）的门框模型

// audio
let listener;
let bgm = null;

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    50
  );

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
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

  // controller (tap to place)
  controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  // audio listener on camera
  listener = new THREE.AudioListener();
  camera.add(listener);

  // load glb
  loadDoorGLB();

  // AR button w/ hit-test
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: document.body },
    })
  );

  window.addEventListener("resize", onWindowResize);
}

// ===== Door loading & normalization =====

function loadDoorGLB() {
  const loader = new GLTFLoader();
  loader.load(
    `${BASE}models/doorframe.glb`,
    (gltf) => {
      doorModel = gltf.scene;

      // 自动：把门“缩放到约2米高 + 底部贴地(y=0) + 水平居中(x/z=0)”
      normalizeDoorModel(doorModel, 2.0);

      // 一些模型材质可能过暗，这里稍微调整（可删）
      doorModel.traverse((o) => {
        if (o.isMesh && o.material) {
          o.castShadow = false;
          o.receiveShadow = false;
          // 如果材质非常黑，你可以把 roughness/metalness 调一调
        }
      });

      console.log("Door GLB loaded & normalized.");
    },
    undefined,
    (err) => console.error("Failed to load doorframe.glb", err)
  );
}

// 让模型无论原点/单位多乱，都变成“合理门框”
function normalizeDoorModel(model, targetHeightMeters = 2.0) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);

  if (!isFinite(size.y) || size.y <= 0) {
    console.warn("Door model size invalid:", size);
    return;
  }

  // 统一缩放到 2m 高
  const scale = targetHeightMeters / size.y;
  model.scale.setScalar(scale);

  // 重新计算缩放后的包围盒
  const box2 = new THREE.Box3().setFromObject(model);
  const center2 = new THREE.Vector3();
  const size2 = new THREE.Vector3();
  box2.getCenter(center2);
  box2.getSize(size2);

  // 水平居中到 x/z=0
  model.position.x += (0 - center2.x);
  model.position.z += (0 - center2.z);

  // 底部贴地：minY -> 0
  const minY = box2.min.y;
  model.position.y += (0 - minY);

  console.log("Door size(before)", size);
  console.log("Door size(after)", size2);

  // 如果你发现门方向反了，取消注释：
  // model.rotateY(Math.PI);
}

// ===== Portal world =====

function buildPortalWorld() {
  // 用球形内贴图：最稳（不会出现你那种“只在左下角一小块”的UV问题）
  const panoTex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTex.colorSpace = THREE.SRGBColorSpace;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(5, 64, 48),
    new THREE.MeshBasicMaterial({ map: panoTex, side: THREE.BackSide })
  );

  const portalWorld = new THREE.Group();

  // 放在门后方 3 米；y=1.2 类似人的视线高度，观感更自然
  sphere.position.set(0, 1.2, -3);
  portalWorld.add(sphere);

  return portalWorld;
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
      audio.play(); // 必须在用户手势后调用：我们在 onSelect 里触发
      console.log("BGM started.");
    },
    undefined,
    (err) => console.error("Failed to load bg.flac", err)
  );

  bgm = audio;
}

// ===== Placement =====

function onSelect() {
  // 必须先命中平面，reticle 才可见
  if (!reticle.visible) return;

  // 第一次点击：创建门
  if (!doorGroup) {
    doorGroup = new THREE.Group();
    scene.add(doorGroup);

    // 门框（glb优先）
    if (doorModel) {
      const clone = doorModel.clone(true);
      doorGroup.add(clone);
    } else {
      // 兜底：glb 还没加载好，用简单门框先顶着
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(1, 2, 0.1),
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.1 })
      );
      frame.position.set(0, 0, 0); // 这里是框体中心，简单示意
      doorGroup.add(frame);
    }

    // 门内世界
    doorGroup.add(buildPortalWorld());
  }

  // 把门放到 hit-test 命中位置
  doorGroup.position.setFromMatrixPosition(reticle.matrix);
  doorGroup.quaternion.setFromRotationMatrix(reticle.matrix);

  // 保持“竖直站起来”：只保留 yaw（绕Y旋转）
  const euler = new THREE.Euler().setFromQuaternion(doorGroup.quaternion, "YXZ");
  euler.x = 0;
  euler.z = 0;
  doorGroup.quaternion.setFromEuler(euler);

  // 启动背景音乐（满足“用户手势”规则）
  ensureBGMStarted();
}

// ===== Render loop with hit-test =====

function animate() {
  renderer.setAnimationLoop(render);
}

function render(_, frame) {
  if (frame) {
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

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
