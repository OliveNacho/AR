import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;
const STAR_COUNT = 15000;
const PREVIEW_STAR_COUNT = 4000;

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

// 音频
let bgAudio = null;
let audioStarted = false;

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

// 流星系统
let meteors = [];
let isDrawing = false;
let drawPoints3D = []; // 3D空间中的点
let lastDrawTime = 0;

// 星星纹理
let starTexture = null;

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

  starTexture = createStarTexture();

  // Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  initAudio();

  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  controller.addEventListener("selectstart", onDrawStart);
  controller.addEventListener("selectend", onDrawEnd);
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

// ============ 音频 ============
function initAudio() {
  bgAudio = new Audio(`${BASE}audio/bg.flac`);
  bgAudio.loop = true;
  bgAudio.volume = 0.5;
}

function playAudio() {
  if (bgAudio && !audioStarted) {
    bgAudio.play().catch(e => console.log("Audio play failed:", e));
    audioStarted = true;
  }
}

// ============ 星星纹理（圆形发光）============
function createStarTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 64, 64);
  
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.15, "rgba(255, 255, 255, 0.9)");
  gradient.addColorStop(0.4, "rgba(255, 255, 255, 0.4)");
  gradient.addColorStop(0.7, "rgba(255, 255, 255, 0.1)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建星星（带闪烁+位移数据）============
function createStars(count, radius, size = 0.12) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4); // 闪烁相位、闪烁速度、位移相位X、位移相位Z
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.5 + 0.5 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const colorType = Math.random();
    if (colorType < 0.65) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (colorType < 0.80) {
      colors[i * 3] = 0.8; colors[i * 3 + 1] = 0.9; colors[i * 3 + 2] = 1;
    } else if (colorType < 0.92) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.7;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.7; colors[i * 3 + 2] = 0.6;
    }
    
    phases[i * 4] = Math.random() * Math.PI * 2;     // 闪烁相位
    phases[i * 4 + 1] = 0.3 + Math.random() * 2.5;   // 闪烁速度
    phases[i * 4 + 2] = Math.random() * Math.PI * 2; // 位移相位X
    phases[i * 4 + 3] = Math.random() * Math.PI * 2; // 位移相位Z
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starTexture,
    size,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, originalPositions: positions.slice(), phases };
}

// ============ 更新星星动画（闪烁+位移）============
function updateStars(points, originalPositions, phases, time, driftAmount = 0.2) {
  if (!points || !originalPositions || !phases) return;
  
  const positions = points.geometry.attributes.position.array;
  const colors = points.geometry.attributes.color.array;
  const count = originalPositions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const blinkPhase = phases[i * 4];
    const blinkSpeed = phases[i * 4 + 1];
    const driftPhaseX = phases[i * 4 + 2];
    const driftPhaseZ = phases[i * 4 + 3];
    
    // 闪烁
    const blink = 0.5 + 0.5 * Math.sin(time * blinkSpeed + blinkPhase);
    const brightness = 0.5 + 0.5 * blink;
    
    // 微位移
    const driftX = Math.sin(time * 0.2 + driftPhaseX) * driftAmount;
    const driftY = Math.cos(time * 0.15 + driftPhaseZ * 0.7) * driftAmount * 0.5;
    const driftZ = Math.cos(time * 0.18 + driftPhaseZ) * driftAmount;
    
    positions[i * 3] = originalPositions[i * 3] + driftX;
    positions[i * 3 + 1] = originalPositions[i * 3 + 1] + driftY;
    positions[i * 3 + 2] = originalPositions[i * 3 + 2] + driftZ;
    
    // 调节亮度
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness;
    colors[i * 3 + 2] = brightness;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 流星系统（增大+精细+跟随手势）============
function createMeteor(startPos, direction) {
  const group = new THREE.Group();
  group.position.copy(startPos);
  
  // 流星头部（更大更亮）
  const headGeo = new THREE.SphereGeometry(0.18, 16, 16);
  const headMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
  });
  const head = new THREE.Mesh(headGeo, headMat);
  group.add(head);
  
  // 内核光晕
  const coreGeo = new THREE.SphereGeometry(0.25, 16, 16);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xaaccff,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  group.add(core);
  
  // 流星尾巴（更长更精细）
  const tailLength = 4 + Math.random() * 2;
  const tailSegments = 60;
  const tailPositions = new Float32Array(tailSegments * 3);
  const tailColors = new Float32Array(tailSegments * 3);
  const tailSizes = new Float32Array(tailSegments);
  
  for (let i = 0; i < tailSegments; i++) {
    const t = i / tailSegments;
    tailPositions[i * 3] = -direction.x * t * tailLength;
    tailPositions[i * 3 + 1] = -direction.y * t * tailLength;
    tailPositions[i * 3 + 2] = -direction.z * t * tailLength;
    
    const fade = Math.pow(1 - t, 1.5);
    // 颜色从白→蓝→淡蓝
    tailColors[i * 3] = fade;
    tailColors[i * 3 + 1] = fade * 0.9 + 0.1;
    tailColors[i * 3 + 2] = fade * 0.7 + 0.3;
    
    tailSizes[i] = 0.25 * (1 - t * 0.7);
  }
  
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute("position", new THREE.BufferAttribute(tailPositions, 3));
  tailGeo.setAttribute("color", new THREE.BufferAttribute(tailColors, 3));
  
  const tailMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.3,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const tail = new THREE.Points(tailGeo, tailMat);
  group.add(tail);
  
  // 额外的发光拖尾线
  const lineGeo = new THREE.BufferGeometry();
  const linePositions = new Float32Array(tailSegments * 3);
  for (let i = 0; i < tailSegments; i++) {
    const t = i / tailSegments;
    linePositions[i * 3] = -direction.x * t * tailLength * 0.8;
    linePositions[i * 3 + 1] = -direction.y * t * tailLength * 0.8;
    linePositions[i * 3 + 2] = -direction.z * t * tailLength * 0.8;
  }
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xaaddff,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(lineGeo, lineMat);
  group.add(line);
  
  group.userData = {
    direction: direction.clone().normalize(),
    speed: 12 + Math.random() * 8,
    life: 0,
    maxLife: 2.5 + Math.random(),
    headMat,
    coreMat,
    tailMat,
    lineMat,
  };
  
  return group;
}

function updateMeteors(delta) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const meteor = meteors[i];
    const data = meteor.userData;
    
    data.life += delta;
    meteor.position.addScaledVector(data.direction, data.speed * delta);
    
    const fadeProgress = data.life / data.maxLife;
    const opacity = Math.max(0, 1 - fadeProgress);
    
    data.headMat.opacity = opacity;
    data.coreMat.opacity = opacity * 0.6;
    data.tailMat.opacity = opacity * 0.8;
    data.lineMat.opacity = opacity * 0.4;
    
    if (data.life >= data.maxLife) {
      scene.remove(meteor);
      meteors.splice(i, 1);
    }
  }
}

// ============ 3D空间手势绘制 ============
function onDrawStart() {
  if (!placed || !isInside) return;
  isDrawing = true;
  drawPoints3D = [];
  lastDrawTime = performance.now();
}

function onDrawEnd() {
  if (!isDrawing) return;
  isDrawing = false;
  
  if (drawPoints3D.length >= 2) {
    spawnMeteorFromGesture3D();
  }
  drawPoints3D = [];
}

function updateDrawing() {
  if (!isDrawing || !placed || !isInside) return;
  
  const now = performance.now();
  if (now - lastDrawTime < 30) return;
  lastDrawTime = now;
  
  // 获取控制器在3D空间中的实际位置
  const controller = renderer.xr.getController(0);
  const worldPos = new THREE.Vector3();
  controller.getWorldPosition(worldPos);
  
  drawPoints3D.push(worldPos.clone());
  
  if (drawPoints3D.length > 30) {
    drawPoints3D.shift();
  }
}

function spawnMeteorFromGesture3D() {
  if (drawPoints3D.length < 2) return;
  
  // 计算手势方向（从第一个点到最后一个点）
  const start = drawPoints3D[0];
  const end = drawPoints3D[drawPoints3D.length - 1];
  const gestureDir = end.clone().sub(start);
  
  // 如果手势太短，忽略
  if (gestureDir.length() < 0.1) return;
  
  gestureDir.normalize();
  
  // 流星起始位置：从手势结束点延伸出去
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  // 在用户前方一定距离，沿手势方向偏移
  const spawnDistance = 8 + Math.random() * 5;
  const meteorStart = end.clone().add(gestureDir.clone().multiplyScalar(spawnDistance));
  
  // 流星方向就是手势方向
  const meteor = createMeteor(meteorStart, gestureDir);
  scene.add(meteor);
  meteors.push(meteor);
}

// ============ 构建场景 ============
function build() {
  const panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;

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

  // 门洞遮罩
  const maskShape = new THREE.Shape();
  const mw = 1.08, mh = 1.9, archR = 0.54;
  maskShape.moveTo(-mw/2, 0);
  maskShape.lineTo(-mw/2, mh - archR);
  maskShape.absarc(0, mh - archR, archR, Math.PI, 0, true);
  maskShape.lineTo(mw/2, 0);
  maskShape.closePath();

  const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMask = new THREE.Mesh(new THREE.ShapeGeometry(maskShape, 32), maskMat);
  portalMask.position.set(0, 0.01, -0.03);
  portalMask.renderOrder = 0;
  doorGroup.add(portalMask);

  // 门外预览天球（初始透明度0.7）
  const previewMat = new THREE.MeshBasicMaterial({
    map: panoTexture,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });
  previewMat.stencilWrite = true;
  previewMat.stencilRef = 1;
  previewMat.stencilFunc = THREE.EqualStencilFunc;

  previewSphere = new THREE.Mesh(new THREE.SphereGeometry(PREVIEW_RADIUS, 48, 32), previewMat);
  previewSphere.renderOrder = 1;
  previewSphere.frustumCulled = false;
  doorGroup.add(previewSphere);

  // 门外预览星星
  const previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.85, 0.05);
  previewStars = previewStarData.points;
  previewStarOriginalPositions = previewStarData.originalPositions;
  previewStarPhases = previewStarData.phases;
  previewStars.material.stencilWrite = true;
  previewStars.material.stencilRef = 1;
  previewStars.material.stencilFunc = THREE.EqualStencilFunc;
  previewStars.material.opacity = 0.7;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

  // 门内天球（初始透明度0）
  skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 64, 32),
    new THREE.MeshBasicMaterial({
      map: panoTexture,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  skySphere.renderOrder = -100;
  scene.add(skySphere);

  // 门内星星
  const skyStarData = createStars(STAR_COUNT, SKY_RADIUS * 0.8, 0.15);
  skyStars = skyStarData.points;
  starOriginalPositions = skyStarData.originalPositions;
  starPhases = skyStarData.phases;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = -99;
  scene.add(skyStars);
}

// ============ 放置门 ============
function onSelect() {
  if (!placed) {
    if (!reticle.visible) return;
    if (!doorGroup) build();

    const xrCam = renderer.xr.getCamera(camera);
    xrCam.getWorldPosition(_camPos);

    const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
    const dir = new THREE.Vector3(_camPos.x - hitPos.x, 0, _camPos.z - hitPos.z).normalize();
    
    doorGroup.position.copy(hitPos).addScaledVector(dir, -DOOR_DISTANCE);
    doorGroup.position.y = hitPos.y;
    doorGroup.lookAt(_camPos.x, doorGroup.position.y, _camPos.z);

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

    playAudio();
  }
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

// ============ 改进的过渡逻辑 ============
function updateTransition(delta) {
  const speed = 3.0;
  const diff = transitionTarget - transitionProgress;
  
  if (Math.abs(diff) > 0.001) {
    transitionProgress += diff * delta * speed;
  } else {
    transitionProgress = transitionTarget;
  }
  
  const t = transitionProgress;
  const smooth = t * t * (3 - 2 * t);
  
  // 门内世界：从0淡入到1
  if (skySphere && skySphere.material) {
    skySphere.material.opacity = smooth;
  }
  if (skyStars && skyStars.material) {
    skyStars.material.opacity = smooth;
  }
  
  // 门外预览：从0.7淡出到0（进入时减少，退出时恢复）
  // 预览初始是0.7透明度，进入时逐渐变为0
  const previewOpacity = 0.7 * (1 - smooth);
  if (previewSphere && previewSphere.material) {
    previewSphere.material.opacity = previewOpacity;
  }
  if (previewStars && previewStars.material) {
    previewStars.material.opacity = previewOpacity;
  }
  
  // 当完全进入后隐藏预览元素
  const showPreview = transitionProgress < 0.95;
  if (portalMask) portalMask.visible = showPreview;
}

// ============ 渲染 ============
let lastTime = performance.now();

function render(_, frame) {
  const now = performance.now();
  const delta = Math.min((now - lastTime) / 1000, 0.1);
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
    updateDrawing();
    updateMeteors(delta);

    // 门内世界跟随相机
    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    skyStars.position.copy(_camPos);
    
    // 更新星星动画（闪烁+位移）
    updateStars(skyStars, starOriginalPositions, starPhases, time, 0.25);
    updateStars(previewStars, previewStarOriginalPositions, previewStarPhases, time, 0.15);
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false;
  isInside = false;
  transitionProgress = 0;
  transitionTarget = 0;
  
  if (bgAudio) {
    bgAudio.pause();
    bgAudio.currentTime = 0;
    audioStarted = false;
  }
  
  meteors.forEach(m => scene.remove(m));
  meteors = [];
  
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) { scene.remove(skySphere); skySphere = null; }
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  
  previewSphere = null;
  previewStars = null;
  portalMask = null;
  starOriginalPositions = null;
  starPhases = null;
  previewStarOriginalPositions = null;
  previewStarPhases = null;
  
  reticle.visible = false;
}
