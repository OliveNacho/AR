import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;
const STAR_COUNT = 12000;
const PREVIEW_STAR_COUNT = 3000;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let skySphere = null;
let skyStars = null;
let placed = false;
let isInside = false;

// 过渡
let transitionProgress = 0;
let transitionTarget = 0;

// 门平面
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

// 星星动画数据
let starOriginalPositions = null;
let starPhases = null;
let previewStarOriginalPositions = null;
let previewStarPhases = null;

// ============ 初始化 ============
init();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));

  // Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  document.body.appendChild(
    ARButton.createButton(renderer, { requiredFeatures: ["hit-test"] })
  );

  const btn = document.createElement("button");
  btn.textContent = "Reset";
  btn.style.cssText = "position:fixed;top:10px;left:10px;z-index:9999;padding:8px 12px;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:6px;";
  btn.onclick = reset;
  document.body.appendChild(btn);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  renderer.setAnimationLoop(render);
}

// ============ 创建星星（带闪烁和位移数据）============
function createStars(count, radius, size = 0.12) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count * 4); // 相位数据：闪烁相位、闪烁速度、位移相位X、位移相位Z
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.5 + 0.5 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 颜色分布：主要白色，少量蓝/黄/红
    const colorType = Math.random();
    if (colorType < 0.65) {
      // 白色
      colors[i * 3] = 0.95 + Math.random() * 0.05;
      colors[i * 3 + 1] = 0.95 + Math.random() * 0.05;
      colors[i * 3 + 2] = 0.95 + Math.random() * 0.05;
    } else if (colorType < 0.80) {
      // 淡蓝
      colors[i * 3] = 0.7 + Math.random() * 0.2;
      colors[i * 3 + 1] = 0.8 + Math.random() * 0.15;
      colors[i * 3 + 2] = 1;
    } else if (colorType < 0.92) {
      // 淡黄
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 0.9 + Math.random() * 0.1;
      colors[i * 3 + 2] = 0.6 + Math.random() * 0.2;
    } else {
      // 淡红/橙
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 0.6 + Math.random() * 0.3;
      colors[i * 3 + 2] = 0.5 + Math.random() * 0.2;
    }
    
    // 大小随机
    sizes[i] = size * (0.3 + Math.random() * 0.7);
    
    // 动画相位
    phases[i * 4] = Math.random() * Math.PI * 2;     // 闪烁相位
    phases[i * 4 + 1] = 0.5 + Math.random() * 2.5;   // 闪烁速度
    phases[i * 4 + 2] = Math.random() * Math.PI * 2; // 位移相位X
    phases[i * 4 + 3] = Math.random() * Math.PI * 2; // 位移相位Z
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  
  const mat = new THREE.PointsMaterial({
    size,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, originalPositions: positions.slice(), phases };
}

// ============ 更新星星动画 ============
function updateStars(points, originalPositions, phases, time, driftAmount = 0.15) {
  if (!points || !originalPositions || !phases) return;
  
  const positions = points.geometry.attributes.position.array;
  const colors = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const blinkPhase = phases[i * 4];
    const blinkSpeed = phases[i * 4 + 1];
    const driftPhaseX = phases[i * 4 + 2];
    const driftPhaseZ = phases[i * 4 + 3];
    
    // 闪烁：调整亮度
    const blink = 0.6 + 0.4 * Math.sin(time * blinkSpeed + blinkPhase);
    const baseBrightness = 0.7 + 0.3 * blink;
    
    // 微位移
    const driftX = Math.sin(time * 0.3 + driftPhaseX) * driftAmount;
    const driftZ = Math.cos(time * 0.25 + driftPhaseZ) * driftAmount;
    
    positions[i * 3] = originalPositions[i * 3] + driftX;
    positions[i * 3 + 2] = originalPositions[i * 3 + 2] + driftZ;
    
    // 原始颜色 * 亮度
    // 注意：这里我们不存储原始颜色，所以用简化方式
    colors[i * 3] = Math.min(1, colors[i * 3] * baseBrightness / 0.85);
    colors[i * 3 + 1] = Math.min(1, colors[i * 3 + 1] * baseBrightness / 0.85);
    colors[i * 3 + 2] = Math.min(1, colors[i * 3 + 2] * baseBrightness / 0.85);
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 构建场景 ============
function build() {
  const panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;

  // === 门框组 ===
  doorGroup = new THREE.Group();
  scene.add(doorGroup);

  new GLTFLoader().load(
    `${BASE}models/doorframe.glb`,
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      model.scale.setScalar((DOOR_HEIGHT / size.y) * 0.9);
      model.rotation.y = Math.PI / 2;
      box.setFromObject(model);
      model.position.y = -box.min.y;
      doorGroup.add(model);
    },
    undefined,
    () => {
      const mat = new THREE.MeshBasicMaterial({ color: 0x222222 });
      const left = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
      left.position.set(-0.55, DOOR_HEIGHT / 2, 0);
      const right = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
      right.position.set(0.55, DOOR_HEIGHT / 2, 0);
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.1), mat);
      top.position.set(0, DOOR_HEIGHT, 0);
      doorGroup.add(left, right, top);
    }
  );

  // === 门洞 stencil 遮罩（缩小尺寸）===
  const maskShape = new THREE.Shape();
  const mw = 1.05, mh = 1.65, archR = 0.52; // 缩小尺寸
  maskShape.moveTo(-mw/2, 0);
  maskShape.lineTo(-mw/2, mh - archR);
  maskShape.absarc(0, mh - archR, archR, Math.PI, 0, true);
  maskShape.lineTo(mw/2, 0);
  maskShape.closePath();

  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
  });
  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMask = new THREE.Mesh(new THREE.ShapeGeometry(maskShape, 32), maskMat);
  portalMask.position.set(0, 0.02, -0.03);
  portalMask.renderOrder = 0;
  doorGroup.add(portalMask);

  // === 门外预览天球（使用全景图，正常颜色）===
  const previewMat = new THREE.MeshBasicMaterial({
    map: panoTexture,
    side: THREE.BackSide,
    depthWrite: false,
  });
  previewMat.stencilWrite = true;
  previewMat.stencilRef = 1;
  previewMat.stencilFunc = THREE.EqualStencilFunc;

  previewSphere = new THREE.Mesh(
    new THREE.SphereGeometry(PREVIEW_RADIUS, 48, 32),
    previewMat
  );
  previewSphere.renderOrder = 1;
  previewSphere.frustumCulled = false;
  doorGroup.add(previewSphere);

  // === 门外预览星星 ===
  const previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.85, 0.06);
  previewStars = previewStarData.points;
  previewStarOriginalPositions = previewStarData.originalPositions;
  previewStarPhases = previewStarData.phases;
  
  previewStars.material.stencilWrite = true;
  previewStars.material.stencilRef = 1;
  previewStars.material.stencilFunc = THREE.EqualStencilFunc;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

  // === 门内世界天球 ===
  skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 64, 32),
    new THREE.MeshBasicMaterial({
      map: panoTexture,
      side: THREE.BackSide,
      depthWrite: false,
    })
  );
  skySphere.visible = false;
  skySphere.renderOrder = -100;
  scene.add(skySphere);

  // === 门内世界星星（高密度）===
  const skyStarData = createStars(STAR_COUNT, SKY_RADIUS * 0.8, 0.18);
  skyStars = skyStarData.points;
  starOriginalPositions = skyStarData.originalPositions;
  starPhases = skyStarData.phases;
  
  skyStars.visible = false;
  skyStars.renderOrder = -99;
  scene.add(skyStars);
}

// ============ 放置门 ============
function onSelect() {
  if (placed || !reticle.visible) return;
  if (!doorGroup) build();

  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);

  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  const dir = new THREE.Vector3(_camPos.x - hitPos.x, 0, _camPos.z - hitPos.z).normalize();
  
  doorGroup.position.copy(hitPos).addScaledVector(dir, -DOOR_DISTANCE);
  doorGroup.position.y = hitPos.y;
  doorGroup.lookAt(_camPos.x, doorGroup.position.y, _camPos.z);

  // 预览球定位在门后
  previewSphere.position.set(0, 1, -PREVIEW_RADIUS * 0.4);
  previewStars.position.set(0, 1, -PREVIEW_RADIUS * 0.4);

  doorPlanePoint.copy(doorGroup.position);
  doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);

  lastSide = getSide(xrCam);
  isInside = false;
  transitionTarget = 0;
  transitionProgress = 0;
  placed = true;
  reticle.visible = false;
}

function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  return doorPlaneNormal.dot(toCamera) >= 0 ? 1 : -1;
}

function checkCrossing(xrCam) {
  const currentSide = getSide(xrCam);
  
  if (lastSide === 1 && currentSide === -1 && !isInside) {
    isInside = true;
    transitionTarget = 1;
  } else if (lastSide === -1 && currentSide === 1 && isInside) {
    isInside = false;
    transitionTarget = 0;
  }
  
  lastSide = currentSide;
}

// ============ 平滑过渡 ============
function updateTransition(delta) {
  // 使用 lerp 实现更平滑的过渡
  const speed = 3.0;
  transitionProgress += (transitionTarget - transitionProgress) * delta * speed;
  
  // 钳制
  if (Math.abs(transitionProgress - transitionTarget) < 0.01) {
    transitionProgress = transitionTarget;
  }
  
  const entering = transitionProgress > 0.5;
  skySphere.visible = entering;
  skyStars.visible = entering;
  
  // 门外预览在进入后隐藏
  const showPreview = transitionProgress < 0.8;
  if (previewSphere) previewSphere.visible = showPreview;
  if (previewStars) previewStars.visible = showPreview;
  if (portalMask) portalMask.visible = showPreview;
  
  // 调整透明度实现淡入淡出
  if (skySphere && skySphere.material) {
    skySphere.material.opacity = Math.min(1, transitionProgress * 2);
    skySphere.material.transparent = true;
  }
}

// ============ 渲染 ============
let lastTime = performance.now();

function render(_, frame) {
  const now = performance.now();
  const delta = (now - lastTime) / 1000;
  const time = now / 1000;
  lastTime = now;

  const session = renderer.xr.getSession();
  const xrCam = renderer.xr.getCamera(camera);

  // Hit test
  if (frame && !placed && session) {
    if (!hitTestSource) {
      session.requestReferenceSpace("viewer").then((space) => {
        session.requestHitTestSource({ space }).then((src) => {
          hitTestSource = src;
        });
      });
      session.addEventListener("end", () => {
        hitTestSource = null;
        reset();
      });
    } else {
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length) {
        reticle.visible = true;
        reticle.matrix.fromArray(hits[0].getPose(renderer.xr.getReferenceSpace()).transform.matrix);
      }
    }
  }

  if (placed) {
    checkCrossing(xrCam);
    updateTransition(delta);

    // 门内世界跟随相机
    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    skyStars.position.copy(_camPos);
    
    // 更新星星动画
    if (skyStars.visible) {
      updateStars(skyStars, starOriginalPositions, starPhases, time, 0.2);
    }
    if (previewStars && previewStars.visible) {
      updateStars(previewStars, previewStarOriginalPositions, previewStarPhases, time, 0.1);
    }
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false;
  isInside = false;
  transitionProgress = 0;
  transitionTarget = 0;
  
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) skySphere.visible = false;
  if (skyStars) skyStars.visible = false;
  
  previewSphere = null;
  previewStars = null;
  portalMask = null;
  
  reticle.visible = false;
}
