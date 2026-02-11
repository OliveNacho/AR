import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;
const STAR_COUNT = 25000;
const PREVIEW_STAR_COUNT = 6000;
const AMBIENT_STAR_COUNT = 800;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let ambientStars = null;
let skySphere = null;
let skyStars = null;
let placed = false;
let isInside = false;

// 音频
let bgAudio = null;
let audioStarted = false;

// 基于距离的过渡
let transitionValue = 0;

// 门平面
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

// 星星动画数据
let starOriginalPositions = null;
let starPhases = null;
let starBaseColors = null;
let previewStarOriginalPositions = null;
let previewStarPhases = null;
let previewStarBaseColors = null;
let ambientStarOriginalPositions = null;
let ambientStarPhases = null;

// 流星系统
let meteors = [];

// 触摸手势
let touchPoints = [];
let isTouching = false;

// 纹理
let starTexture = null;
let meteorTexture = null;

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
  meteorTexture = createMeteorTexture();

  // Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  initAudio();
  initTouchEvents();

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

// ============ 触摸手势事件 ============
function initTouchEvents() {
  const canvas = renderer.domElement;
  
  canvas.addEventListener("touchstart", (e) => {
    if (!placed || !isInside) return;
    isTouching = true;
    touchPoints = [];
    const touch = e.touches[0];
    touchPoints.push({ x: touch.clientX, y: touch.clientY, time: performance.now() });
  }, { passive: true });
  
  canvas.addEventListener("touchmove", (e) => {
    if (!isTouching || !placed || !isInside) return;
    const touch = e.touches[0];
    const now = performance.now();
    
    // 限制采样频率
    if (touchPoints.length > 0) {
      const last = touchPoints[touchPoints.length - 1];
      if (now - last.time < 20) return;
    }
    
    touchPoints.push({ x: touch.clientX, y: touch.clientY, time: now });
    
    // 最多保留30个点
    if (touchPoints.length > 30) touchPoints.shift();
  }, { passive: true });
  
  canvas.addEventListener("touchend", () => {
    if (!isTouching) return;
    isTouching = false;
    
    if (touchPoints.length >= 3) {
      spawnMeteorFromTouch();
    }
    touchPoints = [];
  }, { passive: true });
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

// ============ 星星纹理（柔和发光圆点）============
function createStarTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);
  
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.1, "rgba(255, 255, 255, 0.95)");
  gradient.addColorStop(0.25, "rgba(255, 255, 255, 0.7)");
  gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.3)");
  gradient.addColorStop(0.75, "rgba(255, 255, 255, 0.1)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(64, 64, 64, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 流星纹理（带光晕）============
function createMeteorTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);
  
  // 外层光晕
  const gradient1 = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient1.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient1.addColorStop(0.15, "rgba(200, 220, 255, 0.9)");
  gradient1.addColorStop(0.4, "rgba(150, 180, 255, 0.4)");
  gradient1.addColorStop(0.7, "rgba(100, 150, 255, 0.1)");
  gradient1.addColorStop(1, "rgba(80, 120, 255, 0)");
  
  ctx.fillStyle = gradient1;
  ctx.beginPath();
  ctx.arc(64, 64, 64, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建星星（增强版）============
function createStars(count, radius, size = 0.12, isAmbient = false) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const baseColors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 5); // 闪烁相位、速度、位移X相位、位移Y相位、位移Z相位
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.4 + 0.6 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 丰富的颜色
    const colorType = Math.random();
    let r1, g1, b1;
    if (colorType < 0.55) {
      // 纯白
      r1 = 1; g1 = 1; b1 = 1;
    } else if (colorType < 0.70) {
      // 淡蓝
      r1 = 0.75 + Math.random() * 0.15;
      g1 = 0.85 + Math.random() * 0.1;
      b1 = 1;
    } else if (colorType < 0.82) {
      // 淡黄
      r1 = 1;
      g1 = 0.92 + Math.random() * 0.08;
      b1 = 0.6 + Math.random() * 0.2;
    } else if (colorType < 0.92) {
      // 淡橙/红
      r1 = 1;
      g1 = 0.65 + Math.random() * 0.2;
      b1 = 0.5 + Math.random() * 0.2;
    } else {
      // 淡紫
      r1 = 0.85 + Math.random() * 0.15;
      g1 = 0.7 + Math.random() * 0.2;
      b1 = 1;
    }
    
    baseColors[i * 3] = r1;
    baseColors[i * 3 + 1] = g1;
    baseColors[i * 3 + 2] = b1;
    colors[i * 3] = r1;
    colors[i * 3 + 1] = g1;
    colors[i * 3 + 2] = b1;
    
    // 动画相位（增强）
    phases[i * 5] = Math.random() * Math.PI * 2;     // 闪烁相位
    phases[i * 5 + 1] = 0.5 + Math.random() * 3.0;   // 闪烁速度（更快更明显）
    phases[i * 5 + 2] = Math.random() * Math.PI * 2; // X位移相位
    phases[i * 5 + 3] = Math.random() * Math.PI * 2; // Y位移相位
    phases[i * 5 + 4] = Math.random() * Math.PI * 2; // Z位移相位
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starTexture,
    size: isAmbient ? size * 1.5 : size,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, originalPositions: positions.slice(), phases, baseColors };
}

// ============ 更新星星动画（增强闪烁和位移）============
function updateStars(points, originalPositions, phases, baseColors, time, driftAmount = 0.4, twinkleIntensity = 0.7) {
  if (!points || !originalPositions || !phases || !baseColors) return;
  
  const positions = points.geometry.attributes.position.array;
  const colors = points.geometry.attributes.color.array;
  const count = originalPositions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const blinkPhase = phases[i * 5];
    const blinkSpeed = phases[i * 5 + 1];
    const driftPhaseX = phases[i * 5 + 2];
    const driftPhaseY = phases[i * 5 + 3];
    const driftPhaseZ = phases[i * 5 + 4];
    
    // 闪烁：更强的亮度变化
    const twinkle = Math.sin(time * blinkSpeed + blinkPhase);
    const twinkle2 = Math.sin(time * blinkSpeed * 1.7 + blinkPhase * 0.5);
    const combinedTwinkle = (twinkle + twinkle2 * 0.5) / 1.5;
    const brightness = (1 - twinkleIntensity) + twinkleIntensity * (0.5 + 0.5 * combinedTwinkle);
    
    // 位移：更明显的漂浮感
    const driftX = Math.sin(time * 0.3 + driftPhaseX) * driftAmount;
    const driftY = Math.sin(time * 0.25 + driftPhaseY) * driftAmount * 0.8;
    const driftZ = Math.cos(time * 0.28 + driftPhaseZ) * driftAmount;
    
    positions[i * 3] = originalPositions[i * 3] + driftX;
    positions[i * 3 + 1] = originalPositions[i * 3 + 1] + driftY;
    positions[i * 3 + 2] = originalPositions[i * 3 + 2] + driftZ;
    
    // 颜色亮度
    colors[i * 3] = baseColors[i * 3] * brightness;
    colors[i * 3 + 1] = baseColors[i * 3 + 1] * brightness;
    colors[i * 3 + 2] = baseColors[i * 3 + 2] * brightness;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 从触摸手势生成流星 ============
function spawnMeteorFromTouch() {
  if (touchPoints.length < 2) return;
  
  // 计算屏幕手势方向
  const start = touchPoints[0];
  const end = touchPoints[touchPoints.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  
  // 手势太短忽略
  if (len < 50) return;
  
  // 归一化屏幕方向
  const screenDirX = dx / len;
  const screenDirY = dy / len;
  
  // 将屏幕方向转换为3D世界方向
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  // 获取相机的右向量和上向量
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  // 3D方向：屏幕X映射到相机右，屏幕Y映射到相机下（屏幕Y向下为正）
  const dir3D = new THREE.Vector3()
    .addScaledVector(camRight, screenDirX)
    .addScaledVector(camUp, -screenDirY)
    .addScaledVector(camForward, 0.5) // 加入一些前向分量
    .normalize();
  
  // 流星起点：在用户前方上方随机位置
  const spawnOffset = new THREE.Vector3(
    (Math.random() - 0.5) * 8,
    3 + Math.random() * 6,
    -8 - Math.random() * 5
  ).applyQuaternion(xrCam.quaternion);
  
  const meteorStart = _camPos.clone().add(spawnOffset);
  
  // 创建流星
  const meteor = createMeteor(meteorStart, dir3D);
  scene.add(meteor);
  meteors.push(meteor);
}

// ============ 精美流星 ============
function createMeteor(startPos, direction) {
  const group = new THREE.Group();
  group.position.copy(startPos);
  
  // 流星头部（发光核心）
  const headGeo = new THREE.SphereGeometry(0.12, 16, 16);
  const headMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
  });
  const head = new THREE.Mesh(headGeo, headMat);
  group.add(head);
  
  // 外层光晕
  const glowGeo = new THREE.SphereGeometry(0.35, 16, 16);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xaaccff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  group.add(glow);
  
  // 最外层光晕
  const glow2Geo = new THREE.SphereGeometry(0.55, 16, 16);
  const glow2Mat = new THREE.MeshBasicMaterial({
    color: 0x6699ff,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow2 = new THREE.Mesh(glow2Geo, glow2Mat);
  group.add(glow2);
  
  // 粒子尾巴
  const tailLength = 5 + Math.random() * 3;
  const tailSegments = 80;
  const tailPositions = new Float32Array(tailSegments * 3);
  const tailColors = new Float32Array(tailSegments * 3);
  const tailSizes = new Float32Array(tailSegments);
  
  for (let i = 0; i < tailSegments; i++) {
    const t = i / tailSegments;
    const spread = t * t * 0.3; // 尾巴逐渐散开
    
    tailPositions[i * 3] = -direction.x * t * tailLength + (Math.random() - 0.5) * spread;
    tailPositions[i * 3 + 1] = -direction.y * t * tailLength + (Math.random() - 0.5) * spread;
    tailPositions[i * 3 + 2] = -direction.z * t * tailLength + (Math.random() - 0.5) * spread;
    
    const fade = Math.pow(1 - t, 1.2);
    // 颜色渐变：白 → 淡蓝 → 深蓝
    tailColors[i * 3] = fade;
    tailColors[i * 3 + 1] = fade * 0.85 + 0.15;
    tailColors[i * 3 + 2] = fade * 0.5 + 0.5;
    
    tailSizes[i] = (1 - t * 0.8) * 0.25;
  }
  
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute("position", new THREE.BufferAttribute(tailPositions, 3));
  tailGeo.setAttribute("color", new THREE.BufferAttribute(tailColors, 3));
  
  const tailMat = new THREE.PointsMaterial({
    map: meteorTexture,
    size: 0.35,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const tail = new THREE.Points(tailGeo, tailMat);
  group.add(tail);
  
  // 光线尾迹
  const linePoints = [];
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    linePoints.push(new THREE.Vector3(
      -direction.x * t * tailLength * 0.7,
      -direction.y * t * tailLength * 0.7,
      -direction.z * t * tailLength * 0.7
    ));
  }
  const lineCurve = new THREE.CatmullRomCurve3(linePoints);
  const lineGeo = new THREE.TubeGeometry(lineCurve, 30, 0.03, 8, false);
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0xaaddff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const line = new THREE.Mesh(lineGeo, lineMat);
  group.add(line);
  
  group.userData = {
    direction: direction.clone().normalize(),
    speed: 15 + Math.random() * 10,
    life: 0,
    maxLife: 2 + Math.random() * 1.5,
    headMat,
    glowMat,
    glow2Mat,
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
    const opacity = Math.pow(Math.max(0, 1 - fadeProgress), 0.5);
    
    data.headMat.opacity = opacity;
    data.glowMat.opacity = opacity * 0.5;
    data.glow2Mat.opacity = opacity * 0.25;
    data.tailMat.opacity = opacity * 0.9;
    data.lineMat.opacity = opacity * 0.5;
    
    if (data.life >= data.maxLife) {
      scene.remove(meteor);
      meteors.splice(i, 1);
    }
  }
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

  // 门外预览天球
  const previewMat = new THREE.MeshBasicMaterial({
    map: panoTexture,
    side: THREE.BackSide,
    transparent: true,
    opacity: 1,
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
  const previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.85, 0.06);
  previewStars = previewStarData.points;
  previewStarOriginalPositions = previewStarData.originalPositions;
  previewStarPhases = previewStarData.phases;
  previewStarBaseColors = previewStarData.baseColors;
  previewStars.material.stencilWrite = true;
  previewStars.material.stencilRef = 1;
  previewStars.material.stencilFunc = THREE.EqualStencilFunc;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

  // 门外环境星星（在现实空间中飘浮）
  const ambientStarData = createStars(AMBIENT_STAR_COUNT, 15, 0.04, true);
  ambientStars = ambientStarData.points;
  ambientStarOriginalPositions = ambientStarData.originalPositions;
  ambientStarPhases = ambientStarData.phases;
  ambientStars.material.opacity = 0.6;
  doorGroup.add(ambientStars);

  // 门内天球
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
  const skyStarData = createStars(STAR_COUNT, SKY_RADIUS * 0.8, 0.18);
  skyStars = skyStarData.points;
  starOriginalPositions = skyStarData.originalPositions;
  starPhases = skyStarData.phases;
  starBaseColors = skyStarData.baseColors;
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
    ambientStars.position.set(0, 1.5, -2);

    doorPlanePoint.copy(doorGroup.position);
    doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);

    lastSide = getSide(xrCam);
    isInside = false;
    transitionValue = 0;
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

// ============ 基于距离的平滑过渡 ============
function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  
  // 计算到门平面的有符号距离
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  const signedDist = doorPlaneNormal.dot(toCamera);
  
  // 检测穿越
  const currentSide = signedDist >= 0 ? 1 : -1;
  if (lastSide === 1 && currentSide === -1) {
    isInside = true;
  } else if (lastSide === -1 && currentSide === 1) {
    isInside = false;
  }
  lastSide = currentSide;
  
  // 计算目标过渡值（基于距离）
  let targetValue;
  
  if (isInside) {
    // 门内：完全进入
    targetValue = 1;
  } else {
    // 门外：基于距离渐变
    // 距离门2米以上：0，距离门0米：0.8
    const distFromDoor = Math.abs(signedDist);
    const approachFactor = Math.max(0, 1 - distFromDoor / 2.0);
    targetValue = approachFactor * 0.3; // 接近时预览稍微变淡
  }
  
  // 平滑插值
  const speed = isInside ? 4.0 : 2.0;
  transitionValue += (targetValue - transitionValue) * delta * speed;
  
  // 应用过渡
  const t = transitionValue;
  const smoothT = t * t * (3 - 2 * t); // smoothstep
  
  // 门内世界
  if (skySphere && skySphere.material) {
    skySphere.material.opacity = smoothT;
  }
  if (skyStars && skyStars.material) {
    skyStars.material.opacity = smoothT;
  }
  
  // 门外预览：正常时1，接近时降到0.7，进入后0
  const previewOpacity = isInside ? (1 - smoothT) : (1 - t * 0.3);
  if (previewSphere && previewSphere.material) {
    previewSphere.material.opacity = previewOpacity;
  }
  if (previewStars && previewStars.material) {
    previewStars.material.opacity = previewOpacity;
  }
  
  // 环境星星：接近门时增强
  if (ambientStars && ambientStars.material) {
    const ambientOpacity = 0.4 + (isInside ? 0 : t * 0.6);
    ambientStars.material.opacity = ambientOpacity;
  }
  
  // 完全进入后隐藏预览
  const showPreview = transitionValue < 0.95;
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
    updateTransition(xrCam, delta);
    updateMeteors(delta);

    // 门内世界跟随相机
    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    skyStars.position.copy(_camPos);
    
    // 更新星星动画（增强参数）
    updateStars(skyStars, starOriginalPositions, starPhases, starBaseColors, time, 0.5, 0.75);
    updateStars(previewStars, previewStarOriginalPositions, previewStarPhases, previewStarBaseColors, time, 0.3, 0.7);
    
    // 环境星星动画
    if (ambientStars && ambientStarOriginalPositions && ambientStarPhases) {
      const positions = ambientStars.geometry.attributes.position.array;
      const count = ambientStarOriginalPositions.length / 3;
      for (let i = 0; i < count; i++) {
        const px = ambientStarPhases[i * 5 + 2];
        const py = ambientStarPhases[i * 5 + 3];
        const pz = ambientStarPhases[i * 5 + 4];
        positions[i * 3] = ambientStarOriginalPositions[i * 3] + Math.sin(time * 0.4 + px) * 0.8;
        positions[i * 3 + 1] = ambientStarOriginalPositions[i * 3 + 1] + Math.sin(time * 0.35 + py) * 0.6;
        positions[i * 3 + 2] = ambientStarOriginalPositions[i * 3 + 2] + Math.cos(time * 0.38 + pz) * 0.8;
      }
      ambientStars.geometry.attributes.position.needsUpdate = true;
    }
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false;
  isInside = false;
  transitionValue = 0;
  
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
  ambientStars = null;
  portalMask = null;
  starOriginalPositions = null;
  starPhases = null;
  starBaseColors = null;
  previewStarOriginalPositions = null;
  previewStarPhases = null;
  previewStarBaseColors = null;
  ambientStarOriginalPositions = null;
  ambientStarPhases = null;
  
  reticle.visible = false;
}
