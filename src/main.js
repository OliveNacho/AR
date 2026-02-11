import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/** 你主要调这几个 **/
const DOOR_TARGET_HEIGHT_M = 2.65; // 门更高一点
const PLACE_DISTANCE_M = 1.0;      // 门更近一点

// 门洞估算（按门整体包围盒比例）
const HOLE_WIDTH_FACTOR = 0.55;
const HOLE_HEIGHT_FACTOR = 0.72;
const HOLE_YCENTER_FACTOR = 0.52;

// 进门判定：相机到门平面的“背面”超过这个距离就算进门
const ENTER_BACK_DISTANCE_M = 0.10;

// 门洞裁剪：往门后保留多深的portal内容（太小会像贴片，太大也没问题）
const PORTAL_DEPTH_M = 6.0;

let scene, renderer;
let camera;         // 你的“逻辑相机”
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;

let placed = false;
let isInside = false;

let doorGroup = null;
let doorModel = null;

// door hole params (computed)
let holeW = 1.0;
let holeH = 2.0;
let holeCenterY = 1.0;

// portal content (outside view through doorway)
let portalWindowGroup = null; // sphere + stars（会被裁剪到门洞）

// inside world (camera-follow)
let insideGroup = null;

// audio
let listener;
let bgm = null;

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 80);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  // ✅ 关键：开启本地裁剪（不靠stencil）
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
  btn.onclick = () => resetAll();
  document.body.appendChild(btn);
}

function resetAll() {
  placed = false;
  isInside = false;
  reticle.visible = false;

  if (doorGroup) scene.remove(doorGroup);
  doorGroup = null;

  if (portalWindowGroup) scene.remove(portalWindowGroup);
  portalWindowGroup = null;

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

function loadPanoTexture() {
  const tex = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 生成一个有“深度感”的星点粒子 */
function makeStarField(count = 1200, radius = 6) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // 随机分布在门后一个圆柱/球壳空间里
    const r = Math.random() * radius;
    const theta = Math.random() * Math.PI * 2;
    const y = (Math.random() - 0.2) * radius; // 稍微偏上
    pos[i * 3 + 0] = Math.cos(theta) * r;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = -(Math.random() * PORTAL_DEPTH_M); // 只在门后
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size: 0.02, sizeAttenuation: true });
  return new THREE.Points(geo, mat);
}

/** 根据 doorGroup 的当前姿态，生成门洞矩形的 5 个裁剪平面（左/右/上/下/前） */
function computeDoorClippingPlanes() {
  // 门洞在 doorGroup 的局部空间：中心 (0, holeCenterY, 0)，宽 holeW，高 holeH
  const hw = holeW / 2;
  const hh = holeH / 2;

  const centerLocal = new THREE.Vector3(0, holeCenterY, 0);
  const leftPoint = centerLocal.clone().add(new THREE.Vector3(-hw, 0, 0));
  const rightPoint = centerLocal.clone().add(new THREE.Vector3(hw, 0, 0));
  const topPoint = centerLocal.clone().add(new THREE.Vector3(0, hh, 0));
  const bottomPoint = centerLocal.clone().add(new THREE.Vector3(0, -hh, 0));

  // doorGroup 局部轴到世界
  const m = doorGroup.matrixWorld;

  const toWorld = (v) => v.clone().applyMatrix4(m);

  const pL = toWorld(leftPoint);
  const pR = toWorld(rightPoint);
  const pT = toWorld(topPoint);
  const pB = toWorld(bottomPoint);
  const pC = toWorld(centerLocal);

  // 局部法线转世界（只用旋转部分）
  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());
  const nLeft = new THREE.Vector3(1, 0, 0).applyQuaternion(q);   // 指向门洞内部
  const nRight = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
  const nTop = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
  const nBottom = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

  // 前裁剪面：只保留门后方（doorGroup 的 +Z 是“门后”方向：因为我们让门 lookAt 相机）
  const nFront = new THREE.Vector3(0, 0, -1).applyQuaternion(q); // 裁掉门前的portal内容
  const pFront = pC.clone(); // 门洞平面处

  const planes = [
    new THREE.Plane().setFromNormalAndCoplanarPoint(nLeft, pL),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nRight, pR),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nTop, pT),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nBottom, pB),
    new THREE.Plane().setFromNormalAndCoplanarPoint(nFront, pFront),
  ];

  return planes;
}

function buildOnce() {
  // --- doorGroup ---
  doorGroup = new THREE.Group();

  if (doorModel) {
    const clone = doorModel.clone(true);
    doorGroup.add(clone);
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

  // --- portalWindowGroup（门外通过门洞能看到的内容）---
  portalWindowGroup = new THREE.Group();
  const pano = loadPanoTexture();

  // 球体（让门外“看进去”有包裹感）
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(7, 48, 36),
    new THREE.MeshBasicMaterial({ map: pano, side: THREE.BackSide })
  );
  sphere.position.set(0, holeCenterY, -3.0); // 在门后
  portalWindowGroup.add(sphere);

  // 加一点 3D 星点，避免“只是2D贴图”的感觉
  const stars = makeStarField(1400, 7);
  stars.position.set(0, holeCenterY, -0.2);
  portalWindowGroup.add(stars);

  scene.add(portalWindowGroup);

  // --- insideGroup（进入后：跟随相机的世界）---
  insideGroup = new THREE.Group();
  insideGroup.visible = false;

  const insideSphere = new THREE.Mesh(
    new THREE.SphereGeometry(10, 48, 36),
    new THREE.MeshBasicMaterial({
      map: pano,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
  );
  insideGroup.add(insideSphere);

  const insideStars = makeStarField(2200, 9);
  insideGroup.add(insideStars);

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

  // ✅ 用 XR Camera 获取真实相机位姿
  const xrCam = renderer.xr.getCamera(camera);

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

  // 让门正对你
  const lookAtPos = camPos.clone();
  lookAtPos.y = targetPos.y;
  doorGroup.lookAt(lookAtPos);

  placed = true;
  reticle.visible = false;
  ensureBGMStarted();
}

function updateInsideAndClipping() {
  if (!placed || !doorGroup || !portalWindowGroup) return;

  const xrCam = renderer.xr.getCamera(camera);

  // --- 进门判定：相机相对门平面“是否在背面一定距离” ---
  const camPos = new THREE.Vector3();
  xrCam.getWorldPosition(camPos);

  const doorWorldPos = new THREE.Vector3();
  doorGroup.getWorldPosition(doorWorldPos);

  const q = doorGroup.getWorldQuaternion(new THREE.Quaternion());

  // doorGroup 的“背面方向” = +Z（因为 doorGroup.lookAt(camera) 让 -Z 朝向你）
  const backDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();

  // 相机到门原点的向量在 backDir 上的投影（>0 在门后）
  const d = camPos.clone().sub(doorWorldPos).dot(backDir);

  const nowInside = d > ENTER_BACK_DISTANCE_M;
  if (nowInside !== isInside) {
    isInside = nowInside;
    if (insideGroup) insideGroup.visible = isInside;
  }

  // --- insideGroup 跟随 XR camera（确保不会“走进去就消失”） ---
  if (insideGroup && insideGroup.visible) {
    insideGroup.position.copy(camPos);
  }

  // --- 门外 portalWindowGroup：用裁剪平面裁到门洞矩形（解决你说的“门前就看到一张矩形图”） ---
  const planes = computeDoorClippingPlanes();

  portalWindowGroup.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        m.clippingPlanes = planes;
        m.clipIntersection = true; // 必须同时满足所有平面
        m.needsUpdate = true;
      });
    }
    if (o.isPoints && o.material) {
      o.material.clippingPlanes = planes;
      o.material.clipIntersection = true;
      o.material.needsUpdate = true;
    }
  });

  // 进门后可以隐藏“门外窗口内容”，避免你转身时看到“窗户”
  if (portalWindowGroup) portalWindowGroup.visible = !isInside;
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

  updateInsideAndClipping();

  // ✅ 用 XR Camera 渲染
  const xrCam = renderer.xr.getCamera(camera);
  renderer.render(scene, xrCam);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
