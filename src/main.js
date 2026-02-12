import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const STAR_COUNT = 8000;
const FLOATING_STAR_COUNT = 500;
const AMBIENT_STAR_COUNT = 1500;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let skySphere = null;
let skyStars = null;
let floatingStars = null;
let ambientStars = null;
let placed = false;
let isInside = false;

// 音频
let bgAudio = null;
let audioStarted = false;

// 门平面
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

// 星星数据
let starData = null;
let floatingStarData = null;
let ambientStarData = null;

// 流星
let meteors = [];
let touchPoints = [];
let isTouching = false;

// 纹理
let starTexture = null;
let brightStarTexture = null;
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

  // 创建纹理
  starTexture = createStarTexture();
  brightStarTexture = createBrightStarTexture();
  meteorTexture = createMeteorTexture();

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

// ============ 触摸事件 ============
function initTouchEvents() {
  const canvas = renderer.domElement;
  
  canvas.addEventListener("touchstart", (e) => {
    if (!placed || !isInside) return;
    isTouching = true;
    touchPoints = [];
    const touch = e.touches[0];
    touchPoints.push({ x: touch.clientX, y: touch.clientY });
  }, { passive: true });
  
  canvas.addEventListener("touchmove", (e) => {
    if (!isTouching) return;
    const touch = e.touches[0];
    touchPoints.push({ x: touch.clientX, y: touch.clientY });
    if (touchPoints.length > 25) touchPoints.shift();
  }, { passive: true });
  
  canvas.addEventListener("touchend", () => {
    if (!isTouching) return;
    isTouching = false;
    if (touchPoints.length >= 3) spawnMeteor();
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
    bgAudio.play().catch(() => {});
    audioStarted = true;
  }
}

// ============ 普通星星纹理（干净版）============
function createStarTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  
  // 完全透明背景
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  const cy = size / 2;
  
  // 纯白色光晕，无色偏
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.1, "rgba(255, 255, 255, 0.85)");
  gradient.addColorStop(0.25, "rgba(255, 255, 255, 0.5)");
  gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.15)");
  gradient.addColorStop(0.75, "rgba(255, 255, 255, 0.03)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 亮星纹理（带十字星芒，干净版）============
function createBrightStarTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  const cy = size / 2;
  
  // 核心光晕
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.2);
  coreGrad.addColorStop(0, "rgba(255, 255, 255, 1)");
  coreGrad.addColorStop(0.3, "rgba(255, 255, 255, 0.9)");
  coreGrad.addColorStop(0.6, "rgba(255, 255, 255, 0.4)");
  coreGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.2, 0, Math.PI * 2);
  ctx.fill();
  
  // 外层柔和光晕
  const outerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.45);
  outerGrad.addColorStop(0, "rgba(255, 255, 255, 0.5)");
  outerGrad.addColorStop(0.3, "rgba(255, 255, 255, 0.15)");
  outerGrad.addColorStop(0.6, "rgba(255, 255, 255, 0.03)");
  outerGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = outerGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.45, 0, Math.PI * 2);
  ctx.fill();
  
  // 十字星芒（纯白色，无色偏）
  ctx.globalCompositeOperation = "lighter";
  
  const drawSpike = (angle, length, width) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    
    const spikeGrad = ctx.createLinearGradient(0, 0, length, 0);
    spikeGrad.addColorStop(0, "rgba(255, 255, 255, 0.9)");
    spikeGrad.addColorStop(0.1, "rgba(255, 255, 255, 0.4)");
    spikeGrad.addColorStop(0.4, "rgba(255, 255, 255, 0.1)");
    spikeGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    
    ctx.fillStyle = spikeGrad;
    ctx.beginPath();
    ctx.moveTo(0, -width);
    ctx.lineTo(length, 0);
    ctx.lineTo(0, width);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  
  // 四个方向的星芒
  const spikeLength = size * 0.42;
  const spikeWidth = size * 0.012;
  for (let i = 0; i < 4; i++) {
    drawSpike((i * Math.PI) / 2, spikeLength, spikeWidth);
    drawSpike((i * Math.PI) / 2 + Math.PI, spikeLength, spikeWidth);
  }
  
  // 45度方向的短星芒
  const shortLength = size * 0.25;
  for (let i = 0; i < 4; i++) {
    drawSpike((i * Math.PI) / 2 + Math.PI / 4, shortLength, spikeWidth * 0.7);
    drawSpike((i * Math.PI) / 2 + Math.PI / 4 + Math.PI, shortLength, spikeWidth * 0.7);
  }
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 流星纹理（椭圆拉伸光晕）============
function createMeteorTexture() {
  const width = 128;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  
  ctx.clearRect(0, 0, width, height);
  
  // 椭圆形渐变光晕
  const cx = width / 2;
  const cy = height * 0.3;
  
  // 使用多个椭圆叠加创建拉伸效果
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 2.5); // 垂直拉伸
  
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, width * 0.4);
  grad.addColorStop(0, "rgba(255, 255, 255, 1)");
  grad.addColorStop(0.15, "rgba(255, 252, 245, 0.9)");
  grad.addColorStop(0.3, "rgba(255, 248, 230, 0.6)");
  grad.addColorStop(0.5, "rgba(255, 240, 210, 0.3)");
  grad.addColorStop(0.7, "rgba(255, 230, 190, 0.1)");
  grad.addColorStop(1, "rgba(255, 220, 180, 0)");
  
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, width * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  
  // 核心高亮
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, width * 0.15);
  coreGrad.addColorStop(0, "rgba(255, 255, 255, 1)");
  coreGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.5)");
  coreGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, width * 0.15, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建球面星星 ============
function createSphereStars(count, radius, baseSize = 0.3) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count * 3);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.85 + 0.15 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 颜色
    const type = Math.random();
    if (type < 0.55) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (type < 0.72) {
      colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 1;
    } else if (type < 0.86) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.97; colors[i * 3 + 2] = 0.85;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.75;
    }
    
    // 大小分布
    const sizeRand = Math.random();
    if (sizeRand > 0.97) sizes[i] = baseSize * 2.5;
    else if (sizeRand > 0.9) sizes[i] = baseSize * 1.6;
    else if (sizeRand > 0.75) sizes[i] = baseSize * 1.1;
    else sizes[i] = baseSize * (0.4 + Math.random() * 0.4);
    
    phases[i * 3] = Math.random() * Math.PI * 2;
    phases[i * 3 + 1] = 0.3 + Math.random() * 2.0;
    phases[i * 3 + 2] = Math.random();
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  
  const mat = new THREE.PointsMaterial({
    map: starTexture,
    size: baseSize,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return {
    points,
    positions: positions.slice(),
    colors: colors.slice(),
    sizes,
    phases
  };
}

// ============ 创建浮动星星（空间分布，带十字星芒）============
function createFloatingStars(count, minDist, maxDist) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = minDist + Math.random() * (maxDist - minDist);
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 偏白色/淡蓝色
    const tint = Math.random();
    if (tint < 0.6) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else {
      colors[i * 3] = 0.85 + Math.random() * 0.15;
      colors[i * 3 + 1] = 0.9 + Math.random() * 0.1;
      colors[i * 3 + 2] = 1;
    }
    
    // 大小：多数中等，少数特别亮
    const sizeRand = Math.random();
    if (sizeRand > 0.95) sizes[i] = 1.2 + Math.random() * 0.8;
    else if (sizeRand > 0.8) sizes[i] = 0.6 + Math.random() * 0.4;
    else sizes[i] = 0.25 + Math.random() * 0.25;
    
    phases[i * 4] = Math.random() * Math.PI * 2;
    phases[i * 4 + 1] = 0.5 + Math.random() * 2.0;
    phases[i * 4 + 2] = Math.random() * Math.PI * 2;
    phases[i * 4 + 3] = Math.random() * Math.PI * 2;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  
  const mat = new THREE.PointsMaterial({
    map: brightStarTexture,
    size: 0.8,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return {
    points,
    positions: positions.slice(),
    colors: colors.slice(),
    sizes,
    phases
  };
}

// ============ 创建环境星星（门外空间）============
function createAmbientStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 2);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.3 + 0.7 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    colors[i * 3] = 1;
    colors[i * 3 + 1] = 1;
    colors[i * 3 + 2] = 1;
    
    phases[i * 2] = Math.random() * Math.PI * 2;
    phases[i * 2 + 1] = 0.5 + Math.random() * 2.0;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.15,
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, positions: positions.slice(), phases };
}

// ============ 更新星星动画 ============
function updateStars(data, time, twinkleStrength = 0.5) {
  if (!data) return;
  
  const { points, positions, colors, phases } = data;
  const posAttr = points.geometry.attributes.position.array;
  const colAttr = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase = phases[i * 3] || phases[i * 2] || 0;
    const speed = phases[i * 3 + 1] || phases[i * 2 + 1] || 1;
    
    // 闪烁
    const twinkle = 0.5 + 0.5 * Math.sin(time * speed + phase);
    const brightness = (1 - twinkleStrength) + twinkleStrength * twinkle;
    
    colAttr[i * 3] = colors[i * 3] * brightness;
    colAttr[i * 3 + 1] = colors[i * 3 + 1] * brightness;
    colAttr[i * 3 + 2] = colors[i * 3 + 2] * brightness;
    
    // 微位移
    const drift = 0.12;
    posAttr[i * 3] = positions[i * 3] + Math.sin(time * 0.15 + phase) * drift;
    posAttr[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.12 + phase * 1.3) * drift * 0.6;
    posAttr[i * 3 + 2] = positions[i * 3 + 2] + Math.sin(time * 0.18 + phase * 0.7) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新浮动星星（更大位移）============
function updateFloatingStars(data, time) {
  if (!data) return;
  
  const { points, positions, colors, phases } = data;
  const posAttr = points.geometry.attributes.position.array;
  const colAttr = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase1 = phases[i * 4];
    const speed = phases[i * 4 + 1];
    const phase2 = phases[i * 4 + 2];
    const phase3 = phases[i * 4 + 3];
    
    // 明显闪烁
    const twinkle = Math.sin(time * speed + phase1);
    const brightness = 0.6 + 0.4 * twinkle;
    
    colAttr[i * 3] = colors[i * 3] * brightness;
    colAttr[i * 3 + 1] = colors[i * 3 + 1] * brightness;
    colAttr[i * 3 + 2] = colors[i * 3 + 2] * brightness;
    
    // 较大位移（浮动感）
    const drift = 0.4;
    posAttr[i * 3] = positions[i * 3] + Math.sin(time * 0.2 + phase2) * drift;
    posAttr[i * 3 + 1] = positions[i * 3 + 1] + Math.sin(time * 0.15 + phase3) * drift * 0.8;
    posAttr[i * 3 + 2] = positions[i * 3 + 2] + Math.cos(time * 0.18 + phase1) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 电影级流星 ============
function spawnMeteor() {
  if (touchPoints.length < 2) return;
  
  const start = touchPoints[0];
  const end = touchPoints[touchPoints.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 40) return;
  
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  const dir3D = new THREE.Vector3()
    .addScaledVector(camRight, dx / len)
    .addScaledVector(camUp, -dy / len)
    .addScaledVector(camForward, 0.4)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(15))
    .add(new THREE.Vector3(
      (Math.random() - 0.5) * 8,
      3 + Math.random() * 8,
      (Math.random() - 0.5) * 8
    ));
  
  const meteor = createCinematicMeteor(spawnPos, dir3D);
  scene.add(meteor);
  meteors.push(meteor);
}

function createCinematicMeteor(pos, dir) {
  const group = new THREE.Group();
  group.position.copy(pos);
  
  // 让流星朝向飞行方向
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  
  // ===== 流星本体（椭圆拉伸精灵）=====
  const bodyMat = new THREE.SpriteMaterial({
    map: meteorTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const body = new THREE.Sprite(bodyMat);
  body.scale.set(0.6, 1.5, 1); // 椭圆形
  group.add(body);
  
  // 本体内核（更亮）
  const coreMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const core = new THREE.Sprite(coreMat);
  core.scale.set(0.35, 0.35, 1);
  group.add(core);
  
  // 外层暖色光晕
  const glowMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffeedd,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(1.0, 1.2, 1);
  group.add(glow);
  
  // ===== 粒子尾迹 =====
  const tailLength = 8 + Math.random() * 4;
  const segments = 150;
  const trailPos = new Float32Array(segments * 3);
  const trailCol = new Float32Array(segments * 3);
  
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const tCurve = Math.pow(t, 0.6);
    const spread = t * t * 0.25;
    
    trailPos[i * 3] = -dir.x * tCurve * tailLength + (Math.random() - 0.5) * spread;
    trailPos[i * 3 + 1] = -dir.y * tCurve * tailLength + (Math.random() - 0.5) * spread;
    trailPos[i * 3 + 2] = -dir.z * tCurve * tailLength + (Math.random() - 0.5) * spread;
    
    const fade = Math.pow(1 - t, 1.8);
    
    // 颜色渐变：白 → 淡黄 → 暖橙 → 淡青 → 透明
    let r, g, b;
    if (t < 0.08) {
      r = 1; g = 1; b = 1;
    } else if (t < 0.2) {
      const blend = (t - 0.08) / 0.12;
      r = 1;
      g = 1 - blend * 0.08;
      b = 1 - blend * 0.25;
    } else if (t < 0.45) {
      const blend = (t - 0.2) / 0.25;
      r = 1 - blend * 0.15;
      g = 0.92 - blend * 0.17;
      b = 0.75 - blend * 0.15;
    } else if (t < 0.7) {
      const blend = (t - 0.45) / 0.25;
      r = 0.85 - blend * 0.25;
      g = 0.75 - blend * 0.05;
      b = 0.6 + blend * 0.25;
    } else {
      const blend = (t - 0.7) / 0.3;
      r = 0.6 - blend * 0.3;
      g = 0.7 - blend * 0.2;
      b = 0.85 - blend * 0.2;
    }
    
    trailCol[i * 3] = r * fade;
    trailCol[i * 3 + 1] = g * fade;
    trailCol[i * 3 + 2] = b * fade;
  }
  
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
  
  const trailMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.35,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const trail = new THREE.Points(trailGeo, trailMat);
  group.add(trail);
  
  // ===== 细碎火花 =====
  const sparkCount = 60;
  const sparkPos = new Float32Array(sparkCount * 3);
  const sparkCol = new Float32Array(sparkCount * 3);
  
  for (let i = 0; i < sparkCount; i++) {
    const t = Math.pow(Math.random(), 0.7) * 0.6;
    const spread = t * 0.5;
    
    sparkPos[i * 3] = -dir.x * t * tailLength + (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 1] = -dir.y * t * tailLength + (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 2] = -dir.z * t * tailLength + (Math.random() - 0.5) * spread;
    
    const brightness = 0.4 + Math.random() * 0.6;
    sparkCol[i * 3] = brightness;
    sparkCol[i * 3 + 1] = brightness * 0.95;
    sparkCol[i * 3 + 2] = brightness * 0.8;
  }
  
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(sparkCol, 3));
  
  const sparkMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.1,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  group.add(sparks);
  
  group.userData = {
    direction: dir.clone(),
    speed: 8 + Math.random() * 5, // 减慢速度
    life: 0,
    maxLife: 4 + Math.random() * 2, // 延长生命
    bodyMat,
    coreMat,
    glowMat,
    trailMat,
    sparkMat,
  };
  
  return group;
}

function updateMeteors(delta) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    const d = m.userData;
    
    d.life += delta;
    m.position.addScaledVector(d.direction, d.speed * delta);
    
    const progress = d.life / d.maxLife;
    const fade = progress < 0.1 
      ? progress / 0.1 
      : Math.pow(Math.max(0, 1 - (progress - 0.1) / 0.9), 0.8);
    
    d.bodyMat.opacity = fade;
    d.coreMat.opacity = fade;
    d.glowMat.opacity = fade * 0.6;
    d.trailMat.opacity = fade;
    d.sparkMat.opacity = fade * 0.9;
    
    if (d.life >= d.maxLife) {
      scene.remove(m);
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

  // ===== Stencil 遮罩 =====
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

  // ===== 门内世界（始终存在，通过 stencil 控制可见性）=====
  // 天球
  const skyMat = new THREE.MeshBasicMaterial({
    map: panoTexture,
    side: THREE.BackSide,
    depthWrite: false,
  });
  // 门外时受 stencil 限制
  skyMat.stencilWrite = true;
  skyMat.stencilRef = 1;
  skyMat.stencilFunc = THREE.EqualStencilFunc;

  skySphere = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 64, 32), skyMat);
  skySphere.renderOrder = 1;
  skySphere.frustumCulled = false;
  scene.add(skySphere);

  // 球面星星
  starData = createSphereStars(STAR_COUNT, SKY_RADIUS * 0.8, 0.35);
  skyStars = starData.points;
  skyStars.material.stencilWrite = true;
  skyStars.material.stencilRef = 1;
  skyStars.material.stencilFunc = THREE.EqualStencilFunc;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  // 浮动星星（带十字星芒）
  floatingStarData = createFloatingStars(FLOATING_STAR_COUNT, 5, SKY_RADIUS * 0.6);
  floatingStars = floatingStarData.points;
  floatingStars.material.stencilWrite = true;
  floatingStars.material.stencilRef = 1;
  floatingStars.material.stencilFunc = THREE.EqualStencilFunc;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  // ===== 门外环境星星 =====
  ambientStarData = createAmbientStars(AMBIENT_STAR_COUNT, 20);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);
}

// ============ 放置门 ============
function onSelect() {
  if (placed) return;
  if (!reticle.visible) return;
  if (!doorGroup) build();

  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);

  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  const dir = new THREE.Vector3(_camPos.x - hitPos.x, 0, _camPos.z - hitPos.z).normalize();
  
  doorGroup.position.copy(hitPos).addScaledVector(dir, -DOOR_DISTANCE);
  doorGroup.position.y = hitPos.y;
  doorGroup.lookAt(_camPos.x, doorGroup.position.y, _camPos.z);

  ambientStars.position.set(0, 1.5, -3);

  doorPlanePoint.copy(doorGroup.position);
  doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);

  lastSide = getSide(xrCam);
  isInside = false;
  placed = true;
  reticle.visible = false;

  playAudio();
}

function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  return doorPlaneNormal.dot(_camPos.clone().sub(doorPlanePoint)) >= 0 ? 1 : -1;
}

// ============ 更新过渡状态 ============
function updateState(xrCam) {
  const currentSide = getSide(xrCam);
  
  if (lastSide === 1 && currentSide === -1) {
    isInside = true;
  } else if (lastSide === -1 && currentSide === 1) {
    isInside = false;
  }
  
  lastSide = currentSide;
  
  // 根据状态切换 stencil 模式
  if (isInside) {
    // 门内：禁用 stencil 限制，完整显示
    skySphere.material.stencilFunc = THREE.AlwaysStencilFunc;
    skyStars.material.stencilFunc = THREE.AlwaysStencilFunc;
    floatingStars.material.stencilFunc = THREE.AlwaysStencilFunc;
    portalMask.visible = false;
    ambientStars.visible = false;
  } else {
    // 门外：启用 stencil 限制，只在门洞可见
    skySphere.material.stencilFunc = THREE.EqualStencilFunc;
    skyStars.material.stencilFunc = THREE.EqualStencilFunc;
    floatingStars.material.stencilFunc = THREE.EqualStencilFunc;
    portalMask.visible = true;
    ambientStars.visible = true;
  }
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
    updateState(xrCam);
    updateMeteors(delta);

    // 门内世界跟随相机
    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    skyStars.position.copy(_camPos);
    floatingStars.position.copy(_camPos);
    
    // 更新星星动画
    updateStars(starData, time, 0.45);
    updateFloatingStars(floatingStarData, time);
    updateStars(ambientStarData, time, 0.35);
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false;
  isInside = false;
  
  if (bgAudio) { bgAudio.pause(); bgAudio.currentTime = 0; audioStarted = false; }
  meteors.forEach(m => scene.remove(m));
  meteors = [];
  
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) { scene.remove(skySphere); skySphere = null; }
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  if (floatingStars) { scene.remove(floatingStars); floatingStars = null; }
  
  ambientStars = null;
  portalMask = null;
  starData = null;
  floatingStarData = null;
  ambientStarData = null;
  
  reticle.visible = false;
}
