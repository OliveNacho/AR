import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;
const STAR_COUNT = 6000;
const FLOATING_STAR_COUNT = 2000;
const PREVIEW_STAR_COUNT = 8000;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let skySphere = null;
let skyStars = null;
let floatingStars = null;
let brightStars = null;
let placed = false;
let isInside = false;

// 音频
let bgAudio = null;
let audioStarted = false;

// 过渡
let transitionValue = 0;

// 门平面
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

// 星星数据
let starData = null;
let floatingStarData = null;
let brightStarData = null;
let previewStarData = null;

// 流星
let meteors = [];
let touchPoints = [];
let isTouching = false;

// 纹理
let starTexture = null;
let brightStarTexture = null;
let meteorHeadTexture = null;

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
  starTexture = createCleanStarTexture();
  brightStarTexture = createBrightStarTexture();
  meteorHeadTexture = createMeteorHeadTexture();

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

// ============ 干净的普通星星纹理 ============
function createCleanStarTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  
  // 完全透明背景
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  const cy = size / 2;
  
  // 纯白色柔和圆形光点
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

// ============ 亮星纹理（带干净的十字星芒）============
function createBrightStarTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  const cy = size / 2;
  
  // 核心光晕
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.15);
  coreGrad.addColorStop(0, "rgba(255, 255, 255, 1)");
  coreGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.8)");
  coreGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.15, 0, Math.PI * 2);
  ctx.fill();
  
  // 外层光晕
  const outerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.4);
  outerGrad.addColorStop(0, "rgba(255, 255, 255, 0.6)");
  outerGrad.addColorStop(0.3, "rgba(255, 255, 255, 0.2)");
  outerGrad.addColorStop(0.6, "rgba(255, 255, 255, 0.05)");
  outerGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = outerGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.4, 0, Math.PI * 2);
  ctx.fill();
  
  // 十字星芒（纯白色，干净渐变）
  ctx.globalCompositeOperation = "lighter";
  
  const spikeLength = size * 0.45;
  const spikeWidth = 3;
  
  for (let angle = 0; angle < 4; angle++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((angle * Math.PI) / 2);
    
    // 主星芒
    const spikeGrad = ctx.createLinearGradient(0, 0, spikeLength, 0);
    spikeGrad.addColorStop(0, "rgba(255, 255, 255, 0.9)");
    spikeGrad.addColorStop(0.1, "rgba(255, 255, 255, 0.5)");
    spikeGrad.addColorStop(0.4, "rgba(255, 255, 255, 0.15)");
    spikeGrad.addColorStop(0.7, "rgba(255, 255, 255, 0.03)");
    spikeGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    
    ctx.fillStyle = spikeGrad;
    ctx.beginPath();
    ctx.moveTo(0, -spikeWidth);
    ctx.lineTo(spikeLength, 0);
    ctx.lineTo(0, spikeWidth);
    ctx.closePath();
    ctx.fill();
    
    ctx.restore();
  }
  
  // 45度次级星芒（更细更短）
  for (let angle = 0; angle < 4; angle++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((angle * Math.PI) / 2 + Math.PI / 4);
    
    const shortLength = spikeLength * 0.5;
    const shortGrad = ctx.createLinearGradient(0, 0, shortLength, 0);
    shortGrad.addColorStop(0, "rgba(255, 255, 255, 0.4)");
    shortGrad.addColorStop(0.3, "rgba(255, 255, 255, 0.1)");
    shortGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    
    ctx.fillStyle = shortGrad;
    ctx.beginPath();
    ctx.moveTo(0, -1.5);
    ctx.lineTo(shortLength, 0);
    ctx.lineTo(0, 1.5);
    ctx.closePath();
    ctx.fill();
    
    ctx.restore();
  }
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 流星头部纹理（椭圆拉长光斑）============
function createMeteorHeadTexture() {
  const width = 128;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  
  ctx.clearRect(0, 0, width, height);
  
  const cx = width / 2;
  const cy = height * 0.3; // 偏上
  
  // 椭圆形光斑 - 从上往下渐变
  // 白色核心
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 20);
  coreGrad.addColorStop(0, "rgba(255, 255, 255, 1)");
  coreGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.9)");
  coreGrad.addColorStop(1, "rgba(255, 255, 255, 0.5)");
  
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 15, 25, 0, 0, Math.PI * 2);
  ctx.fill();
  
  // 外层暖色光晕
  ctx.globalCompositeOperation = "lighter";
  
  const glowGrad = ctx.createRadialGradient(cx, cy + 10, 0, cx, cy + 10, 50);
  glowGrad.addColorStop(0, "rgba(255, 250, 240, 0.7)");
  glowGrad.addColorStop(0.3, "rgba(255, 220, 180, 0.4)");
  glowGrad.addColorStop(0.6, "rgba(255, 180, 120, 0.15)");
  glowGrad.addColorStop(1, "rgba(255, 150, 100, 0)");
  
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 10, 40, 70, 0, 0, Math.PI * 2);
  ctx.fill();
  
  // 向下的拖尾渐变
  const tailGrad = ctx.createLinearGradient(cx, cy, cx, height);
  tailGrad.addColorStop(0, "rgba(255, 240, 220, 0.5)");
  tailGrad.addColorStop(0.3, "rgba(255, 200, 150, 0.2)");
  tailGrad.addColorStop(0.6, "rgba(200, 180, 255, 0.08)");
  tailGrad.addColorStop(1, "rgba(150, 150, 255, 0)");
  
  ctx.fillStyle = tailGrad;
  ctx.beginPath();
  ctx.moveTo(cx - 25, cy);
  ctx.quadraticCurveTo(cx - 35, cy + 80, cx - 8, height);
  ctx.lineTo(cx + 8, height);
  ctx.quadraticCurveTo(cx + 35, cy + 80, cx + 25, cy);
  ctx.closePath();
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建普通星星 ============
function createStars(count, radius, baseSize = 0.2) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 3);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 纯净的星星颜色
    const type = Math.random();
    if (type < 0.6) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (type < 0.75) {
      colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 1;
    } else if (type < 0.88) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.97; colors[i * 3 + 2] = 0.85;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.8;
    }
    
    phases[i * 3] = Math.random() * Math.PI * 2;
    phases[i * 3 + 1] = 0.3 + Math.random() * 2.0;
    phases[i * 3 + 2] = Math.random();
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
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
  
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ 创建浮动星星（空间分布）============
function createFloatingStars(count, minRadius, maxRadius, baseSize = 0.25) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = minRadius + Math.random() * (maxRadius - minRadius);
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const type = Math.random();
    if (type < 0.5) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (type < 0.7) {
      colors[i * 3] = 0.85; colors[i * 3 + 1] = 0.92; colors[i * 3 + 2] = 1;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.8;
    }
    
    phases[i * 4] = Math.random() * Math.PI * 2;
    phases[i * 4 + 1] = 0.5 + Math.random() * 2.5;
    phases[i * 4 + 2] = Math.random() * Math.PI * 2;
    phases[i * 4 + 3] = Math.random() * Math.PI * 2;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
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
  
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ 创建亮星（带十字星芒）============
function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count * 2);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.5 + 0.5 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 亮星颜色偏白/淡蓝
    const type = Math.random();
    if (type < 0.6) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else {
      colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 1;
    }
    
    // 大小变化
    sizes[i] = 0.8 + Math.random() * 1.2;
    
    phases[i * 2] = Math.random() * Math.PI * 2;
    phases[i * 2 + 1] = 0.3 + Math.random() * 1.5;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: brightStarTexture,
    size: 1.0,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, positions: positions.slice(), colors: colors.slice(), sizes, phases };
}

// ============ 更新星星动画 ============
function updateStars(data, time, twinkleStrength = 0.4) {
  if (!data) return;
  
  const { points, positions, colors, phases } = data;
  const posAttr = points.geometry.attributes.position.array;
  const colAttr = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase = phases[i * 3];
    const speed = phases[i * 3 + 1];
    
    const twinkle = (1 - twinkleStrength) + twinkleStrength * (0.5 + 0.5 * Math.sin(time * speed + phase));
    
    colAttr[i * 3] = colors[i * 3] * twinkle;
    colAttr[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    colAttr[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    // 微位移
    const drift = 0.1;
    posAttr[i * 3] = positions[i * 3] + Math.sin(time * 0.15 + phase) * drift;
    posAttr[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.12 + phase * 1.3) * drift * 0.5;
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
    
    const twinkle = 0.6 + 0.4 * Math.sin(time * speed + phase1);
    
    colAttr[i * 3] = colors[i * 3] * twinkle;
    colAttr[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    colAttr[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    // 更大的位移
    const drift = 0.5;
    posAttr[i * 3] = positions[i * 3] + Math.sin(time * 0.1 + phase2) * drift;
    posAttr[i * 3 + 1] = positions[i * 3 + 1] + Math.sin(time * 0.08 + phase1) * drift * 0.6;
    posAttr[i * 3 + 2] = positions[i * 3 + 2] + Math.cos(time * 0.12 + phase3) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新亮星 ============
function updateBrightStars(data, time) {
  if (!data) return;
  
  const { points, colors, phases } = data;
  const colAttr = points.geometry.attributes.color.array;
  const count = colors.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase = phases[i * 2];
    const speed = phases[i * 2 + 1];
    
    // 缓慢脉动
    const pulse = 0.7 + 0.3 * Math.sin(time * speed + phase);
    
    colAttr[i * 3] = colors[i * 3] * pulse;
    colAttr[i * 3 + 1] = colors[i * 3 + 1] * pulse;
    colAttr[i * 3 + 2] = colors[i * 3 + 2] * pulse;
  }
  
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
    .addScaledVector(camForward, 0.25)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(15))
    .add(new THREE.Vector3((Math.random() - 0.5) * 8, 3 + Math.random() * 6, (Math.random() - 0.5) * 8));
  
  const meteor = createCinematicMeteor(spawnPos, dir3D);
  scene.add(meteor);
  meteors.push(meteor);
}

function createCinematicMeteor(pos, dir) {
  const group = new THREE.Group();
  group.position.copy(pos);
  
  // 计算朝向
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const matrix = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up);
  quaternion.setFromRotationMatrix(matrix);
  
  // 流星头部 - 使用精灵实现椭圆光斑
  const headMat = new THREE.SpriteMaterial({
    map: meteorHeadTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const head = new THREE.Sprite(headMat);
  head.scale.set(0.8, 1.6, 1);
  head.material.rotation = Math.atan2(dir.y, Math.sqrt(dir.x * dir.x + dir.z * dir.z));
  group.add(head);
  
  // 内核高亮
  const coreMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Sprite(coreMat);
  core.scale.set(0.3, 0.3, 1);
  group.add(core);
  
  // 长尾迹
  const tailLength = 8 + Math.random() * 4;
  const segments = 150;
  const trailPos = new Float32Array(segments * 3);
  const trailCol = new Float32Array(segments * 3);
  
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const tCurve = Math.pow(t, 0.6);
    const spread = t * t * 0.15;
    
    trailPos[i * 3] = -dir.x * tCurve * tailLength + (Math.random() - 0.5) * spread;
    trailPos[i * 3 + 1] = -dir.y * tCurve * tailLength + (Math.random() - 0.5) * spread;
    trailPos[i * 3 + 2] = -dir.z * tCurve * tailLength + (Math.random() - 0.5) * spread;
    
    const fade = Math.pow(1 - t, 1.3);
    
    // 颜色渐变：白 → 淡黄 → 暖橙 → 淡青/紫
    let r, g, b;
    if (t < 0.08) {
      r = 1; g = 1; b = 1;
    } else if (t < 0.25) {
      const blend = (t - 0.08) / 0.17;
      r = 1;
      g = 1 - blend * 0.1;
      b = 1 - blend * 0.3;
    } else if (t < 0.5) {
      const blend = (t - 0.25) / 0.25;
      r = 1 - blend * 0.15;
      g = 0.9 - blend * 0.2;
      b = 0.7 - blend * 0.1;
    } else {
      const blend = (t - 0.5) / 0.5;
      r = 0.85 - blend * 0.35;
      g = 0.7 - blend * 0.1;
      b = 0.6 + blend * 0.3;
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
  
  // 细碎火花
  const sparkCount = 60;
  const sparkPos = new Float32Array(sparkCount * 3);
  const sparkCol = new Float32Array(sparkCount * 3);
  
  for (let i = 0; i < sparkCount; i++) {
    const t = Math.random() * 0.4;
    const spread = t * 0.5;
    sparkPos[i * 3] = -dir.x * t * tailLength + (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 1] = -dir.y * t * tailLength + (Math.random() - 0.5) * spread - Math.random() * 0.1;
    sparkPos[i * 3 + 2] = -dir.z * t * tailLength + (Math.random() - 0.5) * spread;
    
    const brightness = 0.4 + Math.random() * 0.6;
    sparkCol[i * 3] = brightness;
    sparkCol[i * 3 + 1] = brightness * (0.8 + Math.random() * 0.2);
    sparkCol[i * 3 + 2] = brightness * (0.5 + Math.random() * 0.3);
  }
  
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(sparkCol, 3));
  
  const sparkMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.1,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  group.add(sparks);
  
  group.userData = {
    direction: dir.clone(),
    speed: 6 + Math.random() * 4, // 减慢速度
    life: 0,
    maxLife: 4 + Math.random() * 2, // 延长生命
    headMat,
    coreMat,
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
      : Math.pow(Math.max(0, 1 - (progress - 0.1) / 0.9), 0.6);
    
    d.headMat.opacity = fade;
    d.coreMat.opacity = fade;
    d.trailMat.opacity = fade;
    d.sparkMat.opacity = fade * 0.8;
    
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

  // Stencil mask
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

  // 预览天球
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

  // 预览星星（更多）
  previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.85, 0.18);
  previewStars = previewStarData.points;
  previewStars.material.stencilWrite = true;
  previewStars.material.stencilRef = 1;
  previewStars.material.stencilFunc = THREE.EqualStencilFunc;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

  // 门内天球（使用同一张全景图）
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

  // 门内球面星星
  starData = createStars(STAR_COUNT, SKY_RADIUS * 0.85, 0.28);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = -99;
  scene.add(skyStars);

  // 门内浮动星星
  floatingStarData = createFloatingStars(FLOATING_STAR_COUNT, SKY_RADIUS * 0.3, SKY_RADIUS * 0.7, 0.22);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = -98;
  scene.add(floatingStars);

  // 门内亮星（带十字星芒）
  brightStarData = createBrightStars(80, SKY_RADIUS * 0.8);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = -97;
  scene.add(brightStars);
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

  previewSphere.position.set(0, 1, -PREVIEW_RADIUS * 0.4);
  previewStars.position.set(0, 1, -PREVIEW_RADIUS * 0.4);

  doorPlanePoint.copy(doorGroup.position);
  doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);

  lastSide = getSide(xrCam);
  isInside = false;
  transitionValue = 0;
  placed = true;
  reticle.visible = false;

  playAudio();
}

function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  return doorPlaneNormal.dot(_camPos.clone().sub(doorPlanePoint)) >= 0 ? 1 : -1;
}

// ============ 改进的过渡逻辑 ============
function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  const signedDist = doorPlaneNormal.dot(toCamera);
  
  const currentSide = signedDist >= 0 ? 1 : -1;
  if (lastSide === 1 && currentSide === -1) isInside = true;
  else if (lastSide === -1 && currentSide === 1) isInside = false;
  lastSide = currentSide;
  
  // 目标值计算
  let target;
  if (isInside) {
    // 门内：完全显示门内世界
    target = 1;
  } else {
    // 门外：基于距离，越近越透
    const dist = Math.abs(signedDist);
    target = Math.max(0, 0.2 * (1 - dist / 2.0));
  }
  
  // 平滑过渡
  const speed = 4.0;
  transitionValue += (target - transitionValue) * Math.min(1, delta * speed);
  
  // smoothstep
  const t = transitionValue;
  const smooth = t * t * (3 - 2 * t);
  
  // 应用到门内世界
  if (skySphere) skySphere.material.opacity = smooth;
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  
  // 预览：从1淡出到0
  const previewOp = 1 - smooth;
  if (previewSphere) previewSphere.material.opacity = previewOp;
  if (previewStars) previewStars.material.opacity = previewOp;
  
  // 遮罩可见性
  if (portalMask) portalMask.visible = smooth < 0.95;
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
    updateTransition(xrCam, delta);
    updateMeteors(delta);

    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    skyStars.position.copy(_camPos);
    floatingStars.position.copy(_camPos);
    brightStars.position.copy(_camPos);
    
    // 更新星星动画
    updateStars(starData, time, 0.35);
    updateStars(previewStarData, time, 0.3);
    updateFloatingStars(floatingStarData, time);
    updateBrightStars(brightStarData, time);
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false;
  isInside = false;
  transitionValue = 0;
  
  if (bgAudio) { bgAudio.pause(); bgAudio.currentTime = 0; audioStarted = false; }
  meteors.forEach(m => scene.remove(m));
  meteors = [];
  
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) { scene.remove(skySphere); skySphere = null; }
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  if (floatingStars) { scene.remove(floatingStars); floatingStars = null; }
  if (brightStars) { scene.remove(brightStars); brightStars = null; }
  
  previewSphere = null;
  previewStars = null;
  portalMask = null;
  starData = null;
  floatingStarData = null;
  brightStarData = null;
  previewStarData = null;
  
  reticle.visible = false;
}
