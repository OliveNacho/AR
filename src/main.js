import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let nebulaPortal = null;
let ambientStars = null;
let skySphere = null;
let skyStars = null;
let floatingStars = null;
let brightStars = null;
let nearbyStars = null;       // ★ 新增：近身星星
let nearbyStarData = null;    // ★ 新增
let moonMesh = null;
let jupiterMesh = null;
let marsMesh = null;
let saturnMesh = null;
let saturnRingMesh = null;
let sunMesh = null;
let sunGlowSprite = null;
let easterEggs = [];
let constellationGroups = [];
let placed = false;
let isInside = false;
let placedTime = 0;
let meteorShowerTriggered = false;

let spaceStars = null;
let spaceStarData = null;

let constellationStates = new Map();
let constellationLabels = [];

let bgAudio = null;
let audioStarted = false;
let transitionValue = 0;

let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let doorForward = new THREE.Vector3();
let doorRight = new THREE.Vector3();
let doorUp = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

let starData = null;
let floatingStarData = null;
let brightStarData = null;
let ambientStarData = null;

let meteors = [];
let touchPoints = [];
let isTouching = false;

let starTexture = null;
let starPngTexture = null;
let star01PngTexture = null;
let nebulaTexture = null;

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

  const texLoader = new THREE.TextureLoader();
  nebulaTexture = texLoader.load(`${BASE}textures/nebula.png`);
  nebulaTexture.colorSpace = THREE.SRGBColorSpace;
  
  starPngTexture = texLoader.load(`${BASE}textures/star.png`);
  starPngTexture.colorSpace = THREE.SRGBColorSpace;
  
  star01PngTexture = texLoader.load(`${BASE}textures/star_01.png`);
  star01PngTexture.colorSpace = THREE.SRGBColorSpace;
  
  starTexture = createStarTexture();

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const btn = document.createElement("button");
  btn.textContent = "Reset";
  btn.style.cssText = "position:fixed;top:10px;left:10px;z-index:9999;padding:6px 12px;background:#333;color:#fff;border:none;border-radius:4px;";
  btn.onclick = reset;
  document.body.appendChild(btn);

  initAudio();
  initTouchEvents();

  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  document.body.appendChild(
    ARButton.createButton(renderer, { requiredFeatures: ["hit-test"] })
  );

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  renderer.setAnimationLoop(render);
}

function initTouchEvents() {
  const canvas = renderer.domElement;
  canvas.addEventListener("touchstart", (e) => {
    if (!placed) return;
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
    if (isInside && touchPoints.length >= 3) spawnMeteor();
    touchPoints = [];
  }, { passive: true });
}

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

function createStarTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cx = size / 2;
  const gradient = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.2, "rgba(255,255,255,0.6)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.15)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSunGlowTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cx = size / 2;
  const gradient = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gradient.addColorStop(0, "rgba(255,255,200,1)");
  gradient.addColorStop(0.1, "rgba(255,240,150,0.8)");
  gradient.addColorStop(0.3, "rgba(255,200,100,0.4)");
  gradient.addColorStop(0.5, "rgba(255,150,50,0.15)");
  gradient.addColorStop(0.7, "rgba(255,100,30,0.05)");
  gradient.addColorStop(1, "rgba(255,50,0,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSaturnRingTexture() {
  const width = 512, height = 64;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "rgba(180,160,120,0)");
  gradient.addColorStop(0.1, "rgba(200,180,140,0.3)");
  gradient.addColorStop(0.15, "rgba(180,160,130,0.6)");
  gradient.addColorStop(0.2, "rgba(160,140,100,0.2)");
  gradient.addColorStop(0.25, "rgba(200,185,150,0.8)");
  gradient.addColorStop(0.35, "rgba(190,175,140,0.7)");
  gradient.addColorStop(0.4, "rgba(150,130,90,0.1)");
  gradient.addColorStop(0.45, "rgba(210,195,160,0.9)");
  gradient.addColorStop(0.55, "rgba(200,180,145,0.85)");
  gradient.addColorStop(0.65, "rgba(180,165,130,0.6)");
  gradient.addColorStop(0.7, "rgba(140,120,80,0.2)");
  gradient.addColorStop(0.75, "rgba(190,175,140,0.5)");
  gradient.addColorStop(0.85, "rgba(170,155,120,0.3)");
  gradient.addColorStop(0.95, "rgba(150,135,100,0.1)");
  gradient.addColorStop(1, "rgba(130,115,80,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * width;
    ctx.strokeStyle = `rgba(100,80,50,${Math.random() * 0.3})`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ============ 星星颜色（金/白/蓝）============
function getRandomStarColor() {
  const colors = [
    [1, 1, 1], [0.6, 0.8, 1], [0.7, 0.85, 1], [1, 0.95, 0.7],
    [1, 0.9, 0.5], [0.9, 0.95, 1], [1, 0.98, 0.8],
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ============ 门前环境星星 ============
function createAmbientStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    positions[i*3] = (Math.random() - 0.5) * 4;
    positions[i*3+1] = 0.3 + Math.random() * 2.5;
    positions[i*3+2] = -0.3 - Math.random() * 2;
    const c = getRandomStarColor();
    const brightness = 0.7 + Math.random() * 0.3;
    colors[i*3] = c[0] * brightness; colors[i*3+1] = c[1] * brightness; colors[i*3+2] = c[2] * brightness;
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.5 + Math.random() * 2;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starPngTexture, size: 0.1, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ 天空背景星星 ============
function createStars(count, radius, baseSize) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.7 + 0.3 * Math.random());
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    const c = getRandomStarColor();
    const brightness = 0.6 + Math.random() * 0.4;
    colors[i*3] = c[0] * brightness; colors[i*3+1] = c[1] * brightness; colors[i*3+2] = c[2] * brightness;
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.3 + Math.random() * 2.5;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starPngTexture, size: baseSize, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ 浮动星星（中距离）============
function createFloatingStars(count, minR, maxR, baseSize) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = minR + Math.random() * (maxR - minR);
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    const c = getRandomStarColor();
    const brightness = 0.7 + Math.random() * 0.3;
    colors[i*3] = c[0] * brightness; colors[i*3+1] = c[1] * brightness; colors[i*3+2] = c[2] * brightness;
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.2 + Math.random() * 1.8;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starPngTexture, size: baseSize, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ 明亮星星 ============
function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.5 + 0.5 * Math.random());
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    const c = getRandomStarColor();
    colors[i*3] = c[0]; colors[i*3+1] = c[1]; colors[i*3+2] = c[2];
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.15 + Math.random() * 0.8;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starPngTexture, size: 1.2, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ ★★★ 近身星星（围绕用户）★★★ ============
function createNearbyStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count * 5);
  
  for (let i = 0; i < count; i++) {
    // 球形分布，距离 2-12 米
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 2 + Math.random() * 10;
    
    // 相对于用户的偏移（初始值，后续会加上用户位置）
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi) * 0.6 + (Math.random() - 0.3) * 4; // 稍微压缩垂直分布，偏上方
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = getRandomStarColor();
    const brightness = 0.8 + Math.random() * 0.2;
    colors[i*3] = c[0] * brightness;
    colors[i*3+1] = c[1] * brightness;
    colors[i*3+2] = c[2] * brightness;
    
    // 大小变化：近处大，远处小
    sizes[i] = 0.08 + Math.random() * 0.15;
    
    // 相位：用于闪烁、浮动
    phases[i*5] = Math.random() * Math.PI * 2;     // 闪烁相位
    phases[i*5+1] = 0.3 + Math.random() * 2.0;     // 闪烁速度
    phases[i*5+2] = Math.random() * Math.PI * 2;   // X浮动相位
    phases[i*5+3] = Math.random() * Math.PI * 2;   // Y浮动相位
    phases[i*5+4] = Math.random() * Math.PI * 2;   // Z浮动相位
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  
  const mat = new THREE.PointsMaterial({
    map: starPngTexture,
    size: 0.15,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 20; // 高渲染顺序，确保在前面
  
  return {
    points,
    baseOffsets: positions.slice(), // 相对于用户的基础偏移
    colors: colors.slice(),
    sizes: sizes.slice(),
    phases,
    count
  };
}

// ============ ★★★ 更新近身星星（跟随用户 + 闪烁 + 浮动）★★★ ============
function updateNearbyStars(data, time, camPos) {
  if (!data) return;
  
  const { points, baseOffsets, colors, phases, count } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  
  for (let i = 0; i < count; i++) {
    // 闪烁效果（强烈）
    const twinkle = 0.3 + 0.7 * Math.sin(time * phases[i*5+1] + phases[i*5]);
    col[i*3] = Math.min(1, colors[i*3] * twinkle * 1.5);
    col[i*3+1] = Math.min(1, colors[i*3+1] * twinkle * 1.5);
    col[i*3+2] = Math.min(1, colors[i*3+2] * twinkle * 1.5);
    
    // 浮动漂移
    const driftX = Math.sin(time * 0.15 + phases[i*5+2]) * 0.3;
    const driftY = Math.sin(time * 0.12 + phases[i*5+3]) * 0.2;
    const driftZ = Math.cos(time * 0.18 + phases[i*5+4]) * 0.3;
    
    // 缓慢旋转整体（围绕用户转动）
    const rotAngle = time * 0.02;
    const baseX = baseOffsets[i*3];
    const baseZ = baseOffsets[i*3+2];
    const rotX = baseX * Math.cos(rotAngle) - baseZ * Math.sin(rotAngle);
    const rotZ = baseX * Math.sin(rotAngle) + baseZ * Math.cos(rotAngle);
    
    // 最终位置 = 用户位置 + 旋转后的偏移 + 漂移
    pos[i*3] = camPos.x + rotX + driftX;
    pos[i*3+1] = camPos.y + baseOffsets[i*3+1] + driftY;
    pos[i*3+2] = camPos.z + rotZ + driftZ;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新天空星星 ============
function updateStars(data, time) {
  if (!data) return;
  const { points, colors, phases } = data;
  const col = points.geometry.attributes.color.array;
  const count = colors.length / 3;
  for (let i = 0; i < count; i++) {
    const twinkle = 0.5 + 0.5 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = Math.min(1, colors[i*3] * twinkle * 1.4);
    col[i*3+1] = Math.min(1, colors[i*3+1] * twinkle * 1.4);
    col[i*3+2] = Math.min(1, colors[i*3+2] * twinkle * 1.4);
  }
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新浮动星星 ============
function updateFloatingStars(data, time) {
  if (!data) return;
  const { points, positions, colors, phases } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const twinkle = 0.4 + 0.6 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = Math.min(1, colors[i*3] * twinkle * 1.5);
    col[i*3+1] = Math.min(1, colors[i*3+1] * twinkle * 1.5);
    col[i*3+2] = Math.min(1, colors[i*3+2] * twinkle * 1.5);
    const drift = 0.5;
    pos[i*3] = positions[i*3] + Math.sin(time * 0.08 + phases[i*4+2]) * drift;
    pos[i*3+1] = positions[i*3+1] + Math.sin(time * 0.06 + phases[i*4]) * drift * 0.4;
    pos[i*3+2] = positions[i*3+2] + Math.cos(time * 0.1 + phases[i*4+3]) * drift;
  }
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新明亮星星 ============
function updateBrightStars(data, time) {
  if (!data) return;
  const { points, positions, colors, phases } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const count = colors.length / 3;
  for (let i = 0; i < count; i++) {
    const pulse = 0.3 + 0.7 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = Math.min(1, colors[i*3] * pulse * 1.6);
    col[i*3+1] = Math.min(1, colors[i*3+1] * pulse * 1.6);
    col[i*3+2] = Math.min(1, colors[i*3+2] * pulse * 1.6);
    const drift = 0.2;
    pos[i*3] = positions[i*3] + Math.sin(time * 0.05 + phases[i*4+2]) * drift;
    pos[i*3+1] = positions[i*3+1] + Math.sin(time * 0.04 + phases[i*4]) * drift * 0.3;
    pos[i*3+2] = positions[i*3+2] + Math.cos(time * 0.06 + phases[i*4+3]) * drift;
  }
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 空间星星（增加空间感）============
function createSpaceStars(count) {
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    positions[i*3] = (Math.random() - 0.5) * 60;
    positions[i*3+1] = -5 + Math.random() * 35;
    positions[i*3+2] = 3 + Math.random() * 50;
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.5 + Math.random() * 1.5;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ map: star01PngTexture, size: 0.12, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, basePositions: positions.slice(), phases, count };
}

function updateSpaceStars(data, time) {
  if (!data || !placed) return;
  const { points, basePositions, phases, count } = data;
  const pos = points.geometry.attributes.position.array;
  for (let i = 0; i < count; i++) {
    const floatX = Math.sin(time * 0.06 + phases[i*4+2]) * 0.1;
    const floatY = Math.sin(time * 0.04 + phases[i*4]) * 0.08;
    const floatZ = Math.cos(time * 0.05 + phases[i*4+3]) * 0.1;
    const localX = basePositions[i*3] + floatX;
    const localY = basePositions[i*3+1] + floatY;
    const localZ = basePositions[i*3+2] + floatZ;
    const worldPos = doorPlanePoint.clone()
      .addScaledVector(doorRight, localX)
      .addScaledVector(doorUp, localY)
      .addScaledVector(doorForward, localZ);
    pos[i*3] = worldPos.x;
    pos[i*3+1] = worldPos.y;
    pos[i*3+2] = worldPos.z;
  }
  points.geometry.attributes.position.needsUpdate = true;
}

// ============ 流星系统 ============
function spawnMeteor() {
  if (touchPoints.length < 3) return;
  const start = touchPoints[0];
  const end = touchPoints[touchPoints.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 30) return;
  let userCurvature = 0;
  if (touchPoints.length >= 5) {
    const midIdx = Math.floor(touchPoints.length / 2);
    const mid = touchPoints[midIdx];
    const midExpectedX = (start.x + end.x) / 2;
    const midExpectedY = (start.y + end.y) / 2;
    const perpX = -dy / len;
    const perpY = dx / len;
    const offsetDist = (mid.x - midExpectedX) * perpX + (mid.y - midExpectedY) * perpY;
    userCurvature = offsetDist / len * 8;
  }
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  const ndx = dx / len;
  const ndy = dy / len;
  const flyDir = new THREE.Vector3()
    .addScaledVector(camRight, ndx * 0.85)
    .addScaledVector(camUp, -ndy * 0.75)
    .addScaledVector(camForward, 0.4)
    .normalize();
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(6 + Math.random() * 4))
    .add(camRight.clone().multiplyScalar(-ndx * 4 + (Math.random() - 0.5) * 2))
    .add(camUp.clone().multiplyScalar(ndy * 3 + 2 + Math.random() * 2));
  const meteor = createArcMeteor(spawnPos, flyDir, userCurvature);
  scene.add(meteor);
  meteors.push(meteor);
}

function spawnMeteorShower() {
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const meteorCount = 150 + Math.floor(Math.random() * 50);
  for (let i = 0; i < meteorCount; i++) {
    setTimeout(() => {
      const horizontalBias = 0.8 + Math.random() * 0.4;
      const fromLeft = Math.random() > 0.5;
      const sideOffset = fromLeft ? -1 : 1;
      const spawnPos = _camPos.clone()
        .add(camForward.clone().multiplyScalar(10 + Math.random() * 35))
        .add(camRight.clone().multiplyScalar(sideOffset * (10 + Math.random() * 20)))
        .add(camUp.clone().multiplyScalar(5 + Math.random() * 20))
        .add(new THREE.Vector3((Math.random() - 0.5) * 15, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 15));
      const flyDir = new THREE.Vector3()
        .addScaledVector(camRight, -sideOffset * horizontalBias)
        .addScaledVector(camUp, -0.15 - Math.random() * 0.25)
        .addScaledVector(camForward, (Math.random() - 0.5) * 0.4)
        .normalize();
      const curvature = (Math.random() - 0.5) * 2.5;
      const meteor = createArcMeteor(spawnPos, flyDir, curvature);
      scene.add(meteor);
      meteors.push(meteor);
    }, i * (80 + Math.random() * 150));
  }
}

function createArcMeteor(startPos, baseDir, userCurvature) {
  const group = new THREE.Group();
  group.renderOrder = 200;
  const arcLength = 20 + Math.random() * 15;
  const arcBend = userCurvature + (Math.random() - 0.5) * 3;
  const gravity = -0.35 - Math.random() * 0.25;
  let perpendicular = new THREE.Vector3().crossVectors(baseDir, new THREE.Vector3(0, 1, 0));
  if (perpendicular.length() < 0.1) perpendicular.crossVectors(baseDir, new THREE.Vector3(1, 0, 0));
  perpendicular.normalize();
  const p0 = startPos.clone();
  const p1 = startPos.clone().addScaledVector(baseDir, arcLength * 0.3).addScaledVector(perpendicular, arcBend * 1.2).add(new THREE.Vector3(0, gravity * arcLength * 0.1, 0));
  const p2 = startPos.clone().addScaledVector(baseDir, arcLength * 0.65).addScaledVector(perpendicular, arcBend * 0.6).add(new THREE.Vector3(0, gravity * arcLength * 0.35, 0));
  const p3 = startPos.clone().addScaledVector(baseDir, arcLength).add(new THREE.Vector3(0, gravity * arcLength * 0.75, 0));
  const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
  const coreMat = new THREE.SpriteMaterial({ map: starTexture, color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
  const coreSprite = new THREE.Sprite(coreMat);
  coreSprite.scale.set(1.0, 0.4, 1);
  coreSprite.renderOrder = 202;
  group.add(coreSprite);
  const innerMat = new THREE.SpriteMaterial({ map: starTexture, color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
  const innerSprite = new THREE.Sprite(innerMat);
  innerSprite.scale.set(0.5, 0.5, 1);
  innerSprite.renderOrder = 203;
  group.add(innerSprite);
  const glowMat = new THREE.SpriteMaterial({ map: starTexture, color: 0xffffee, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
  const glowSprite = new THREE.Sprite(glowMat);
  glowSprite.scale.set(1.5, 0.6, 1);
  glowSprite.renderOrder = 201;
  group.add(glowSprite);
  const trailCount = 50;
  const trailSprites = [];
  for (let i = 0; i < trailCount; i++) {
    const t = i / trailCount;
    const size = 0.4 * Math.pow(1 - t, 0.8);
    const spriteMat = new THREE.SpriteMaterial({ map: starTexture, color: new THREE.Color(1, 1 - t * 0.3, 1 - t * 0.7), transparent: true, opacity: Math.pow(1 - t, 1.2), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(size, size, 1);
    sprite.position.copy(startPos);
    sprite.renderOrder = 200;
    sprite.visible = false;
    scene.add(sprite);
    trailSprites.push({ sprite, mat: spriteMat });
  }
  group.userData = { curve, progress: 0, speed: 0.10 + Math.random() * 0.04, life: 0, maxLife: 4.5 + Math.random() * 2, coreMat, innerMat, glowMat, history: [], coreSprite, innerSprite, glowSprite, trailCount, trailSprites };
  return group;
}

function updateMeteors(delta) {
  const xrCam = renderer.xr.getCamera(camera);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    const d = m.userData;
    d.life += delta;
    d.progress += d.speed * delta;
    const t = Math.min(d.progress, 1);
    const pos = d.curve.getPoint(t);
    const tangent = d.curve.getTangent(t).normalize();
    m.position.copy(pos);
    const tangentScreenX = tangent.dot(camRight);
    const tangentScreenY = tangent.dot(camUp);
    const screenAngle = Math.atan2(tangentScreenY, tangentScreenX);
    d.coreSprite.material.rotation = screenAngle;
    d.glowSprite.material.rotation = screenAngle;
    d.history.unshift(pos.clone());
    if (d.history.length > d.trailCount) d.history.pop();
    const historyLen = d.history.length;
    for (let j = 0; j < d.trailCount; j++) {
      const ts = d.trailSprites[j];
      if (j < historyLen) { ts.sprite.visible = true; ts.sprite.position.copy(d.history[j]); }
      else ts.sprite.visible = false;
    }
    const lifeRatio = d.life / d.maxLife;
    let opacity = lifeRatio < 0.08 ? lifeRatio / 0.08 : Math.pow(1 - (lifeRatio - 0.08) / 0.92, 0.6);
    d.coreMat.opacity = opacity;
    d.innerMat.opacity = opacity;
    d.glowMat.opacity = opacity * 0.4;
    for (let j = 0; j < d.trailSprites.length; j++) {
      const ts = d.trailSprites[j];
      const baseOpacity = Math.pow(1 - j / d.trailCount, 1.2);
      ts.mat.opacity = baseOpacity * opacity;
    }
    if (d.life >= d.maxLife || d.progress >= 1) {
      scene.remove(m);
      d.trailSprites.forEach(ts => scene.remove(ts.sprite));
      meteors.splice(i, 1);
    }
  }
}

// ============ 12星座数据 ============
function getConstellationsData() {
  return [
    { name: "Aries", stars: [{ x: 0, y: 0, z: 0, size: 0.7 },{ x: -1.0, y: 0.5, z: 0.1, size: 0.55 },{ x: -1.8, y: 1.0, z: 0, size: 0.5 },{ x: 1.2, y: -0.3, z: -0.1, size: 0.45 }], lines: [[2,1], [1,0], [0,3]], position: { forward: 32, right: 38, up: 14 } },
    { name: "Taurus", stars: [{ x: 0, y: 0, z: 0, size: 0.8 },{ x: -3.0, y: 1.5, z: 0.1, size: 0.6 },{ x: 0.5, y: -1.0, z: 0, size: 0.5 },{ x: -0.8, y: 0.8, z: -0.1, size: 0.5 },{ x: -0.3, y: 0.5, z: 0.1, size: 0.5 },{ x: -1.5, y: 1.0, z: 0, size: 0.5 },{ x: -2.2, y: 2.0, z: -0.1, size: 0.5 }], lines: [[0,3], [0,4], [3,4], [4,5], [5,1], [5,6], [0,2]], position: { forward: 14, right: -42, up: 2 } },
    { name: "Gemini", stars: [{ x: 0, y: 3.0, z: 0, size: 0.7 },{ x: 1.5, y: 2.8, z: 0.1, size: 0.7 },{ x: 0.1, y: 2.0, z: 0, size: 0.45 },{ x: 1.4, y: 1.8, z: 0.1, size: 0.45 },{ x: 0.2, y: 1.0, z: -0.1, size: 0.5 },{ x: 1.3, y: 0.8, z: 0, size: 0.5 },{ x: 0.3, y: 0, z: 0.1, size: 0.45 },{ x: 1.2, y: -0.2, z: -0.1, size: 0.45 },{ x: 0.4, y: -1.0, z: 0, size: 0.45 },{ x: 1.1, y: -1.2, z: 0.1, size: 0.55 }], lines: [[0,2], [2,4], [4,6], [6,8], [1,3], [3,5], [5,7], [7,9]], position: { forward: 40, right: 5, up: 10 } },
    { name: "Cancer", stars: [{ x: 0, y: 0, z: 0, size: 0.55 },{ x: 0.5, y: -1.5, z: 0.1, size: 0.6 },{ x: -1.0, y: 0.8, z: 0, size: 0.5 },{ x: 0.8, y: 0.6, z: -0.1, size: 0.5 },{ x: -0.5, y: 1.5, z: 0.1, size: 0.45 }], lines: [[0,1], [0,2], [0,3], [2,4], [3,4]], position: { forward: 15, right: 30, up: 4 } },
    { name: "Leo", stars: [{ x: 0, y: 0, z: 0, size: 0.85 },{ x: -0.8, y: 1.5, z: 0.1, size: 0.55 },{ x: 0.5, y: 1.0, z: 0, size: 0.6 },{ x: 1.8, y: 2.0, z: -0.1, size: 0.5 },{ x: 0.3, y: 2.2, z: 0.1, size: 0.5 },{ x: -0.5, y: 2.8, z: 0, size: 0.5 },{ x: 1.5, y: 0.8, z: -0.1, size: 0.55 },{ x: 2.5, y: 0.5, z: 0.1, size: 0.5 },{ x: 3.5, y: 0, z: 0, size: 0.6 }], lines: [[0,1], [1,5], [5,4], [4,3], [1,2], [2,6], [6,7], [7,8], [2,0]], position: { forward: 28, right: -28, up: 16 } },
    { name: "Virgo", stars: [{ x: 0, y: 0, z: 0, size: 0.85 },{ x: -0.8, y: 1.5, z: 0.1, size: 0.55 },{ x: -0.5, y: 2.5, z: 0, size: 0.5 },{ x: 0, y: 3.5, z: -0.1, size: 0.55 },{ x: -1.5, y: 1.0, z: 0.1, size: 0.5 },{ x: 0.5, y: 1.8, z: 0, size: 0.5 },{ x: 1.5, y: 2.2, z: -0.1, size: 0.5 }], lines: [[0,4], [4,1], [1,2], [2,3], [1,5], [5,6]], position: { forward: 22, right: 45, up: 6 } },
    { name: "Libra", stars: [{ x: 0, y: 0, z: 0, size: 0.6 },{ x: -1.2, y: 1.5, z: 0.1, size: 0.6 },{ x: 1.0, y: 1.2, z: -0.1, size: 0.55 },{ x: -0.8, y: 2.8, z: 0, size: 0.5 },{ x: 0.6, y: 2.5, z: 0.1, size: 0.5 }], lines: [[0,1], [0,2], [1,3], [2,4]], position: { forward: 35, right: -5, up: 0 } },
    { name: "Scorpius", stars: [{ x: 0, y: 0, z: 0, size: 0.9 },{ x: -1.5, y: 1.5, z: 0.1, size: 0.55 },{ x: -0.5, y: 1.8, z: 0, size: 0.55 },{ x: 0.5, y: 2.0, z: -0.1, size: 0.5 },{ x: -0.3, y: 0.8, z: 0.1, size: 0.5 },{ x: 0.5, y: -0.8, z: 0, size: 0.5 },{ x: 1.2, y: -1.5, z: -0.1, size: 0.5 },{ x: 2.0, y: -1.2, z: 0.1, size: 0.5 },{ x: 2.5, y: -1.0, z: 0, size: 0.45 },{ x: 2.8, y: -1.8, z: -0.1, size: 0.5 },{ x: 3.2, y: -2.2, z: 0.1, size: 0.45 },{ x: 3.6, y: -2.6, z: 0, size: 0.45 },{ x: 4.0, y: -2.2, z: -0.1, size: 0.55 },{ x: 4.2, y: -1.8, z: 0.1, size: 0.5 }], lines: [[1,2], [2,3], [2,4], [4,0], [0,5], [5,6], [6,7], [7,8], [7,9], [9,10], [10,11], [11,12], [12,13]], position: { forward: 20, right: -45, up: 8 } },
    { name: "Sagittarius", stars: [{ x: 0, y: 0, z: 0, size: 0.65 },{ x: 0.3, y: 1.2, z: 0.1, size: 0.6 },{ x: 0.8, y: 2.0, z: 0, size: 0.55 },{ x: -0.8, y: 0.5, z: -0.1, size: 0.55 },{ x: -0.3, y: 1.5, z: 0.1, size: 0.5 },{ x: -1.0, y: 1.2, z: 0, size: 0.55 },{ x: -0.5, y: -0.5, z: -0.1, size: 0.5 },{ x: 1.2, y: 0.8, z: 0.1, size: 0.55 }], lines: [[0,1], [1,2], [2,4], [4,5], [5,0], [3,5], [3,0], [3,6], [1,7]], position: { forward: 45, right: 22, up: 18 } },
    { name: "Capricornus", stars: [{ x: 0, y: 0, z: 0, size: 0.55 },{ x: 2.0, y: 0.3, z: 0.1, size: 0.55 },{ x: 0.5, y: -0.8, z: 0, size: 0.45 },{ x: 0.8, y: -1.5, z: -0.1, size: 0.45 },{ x: 1.5, y: -1.8, z: 0.1, size: 0.5 },{ x: 2.5, y: -1.2, z: 0, size: 0.55 },{ x: 3.0, y: -0.5, z: -0.1, size: 0.55 },{ x: 2.0, y: -1.0, z: 0.1, size: 0.45 },{ x: 2.5, y: 0, z: 0, size: 0.45 }], lines: [[0,1], [0,2], [2,3], [3,4], [4,5], [5,6], [1,8], [8,7], [7,4]], position: { forward: 18, right: 35, up: -2 } },
    { name: "Aquarius", stars: [{ x: 0, y: 2.0, z: 0, size: 0.6 },{ x: -1.2, y: 1.5, z: 0.1, size: 0.6 },{ x: 0.8, y: 0.5, z: 0, size: 0.55 },{ x: 0.3, y: 1.2, z: -0.1, size: 0.5 },{ x: 0.5, y: 0.8, z: 0.1, size: 0.5 },{ x: 0.2, y: 0, z: 0, size: 0.5 },{ x: 0.8, y: -0.5, z: -0.1, size: 0.55 },{ x: 1.2, y: -1.2, z: 0.1, size: 0.5 },{ x: 1.8, y: -1.5, z: 0, size: 0.45 },{ x: -0.8, y: 2.5, z: -0.1, size: 0.5 }], lines: [[0,1], [0,3], [3,4], [4,2], [2,5], [5,6], [6,7], [7,8], [1,9]], position: { forward: 12, right: -22, up: 16 } },
    { name: "Pisces", stars: [{ x: 0, y: 0, z: 0, size: 0.55 },{ x: -0.8, y: -0.5, z: 0.1, size: 0.5 },{ x: -1.5, y: -0.8, z: 0, size: 0.5 },{ x: -2.2, y: -0.5, z: -0.1, size: 0.55 },{ x: -2.8, y: -0.2, z: 0.1, size: 0.5 },{ x: -3.2, y: 0.2, z: 0, size: 0.5 },{ x: 0.6, y: 0.5, z: -0.1, size: 0.5 },{ x: 1.2, y: 1.0, z: 0.1, size: 0.55 },{ x: 1.8, y: 1.5, z: 0, size: 0.5 },{ x: 2.4, y: 1.8, z: -0.1, size: 0.5 }], lines: [[0,1], [1,2], [2,3], [3,4], [4,5], [0,6], [6,7], [7,8], [8,9]], position: { forward: 30, right: -35, up: 4 } },
  ];
}

function createConstellation(data) {
  const group = new THREE.Group();
  group.userData.name = data.name;
  const starMeshes = [];
  data.stars.forEach((star) => {
    const starMat = new THREE.SpriteMaterial({ map: star01PngTexture, color: new THREE.Color(1, 0.98, 0.9), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const sprite = new THREE.Sprite(starMat);
    sprite.position.set(star.x, star.y, star.z);
    sprite.scale.setScalar(star.size * 0.85);
    sprite.userData = { baseMat: starMat, baseSize: star.size * 0.85 };
    group.add(sprite);
    starMeshes.push(sprite);
  });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x6688aa, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const lineMeshes = [];
  data.lines.forEach(([i, j]) => {
    const points = [new THREE.Vector3(data.stars[i].x, data.stars[i].y, data.stars[i].z), new THREE.Vector3(data.stars[j].x, data.stars[j].y, data.stars[j].z)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, lineMat.clone());
    group.add(line);
    lineMeshes.push(line);
  });
  group.userData.starMeshes = starMeshes;
  group.userData.lineMeshes = lineMeshes;
  group.userData.relPos = data.position;
  group.scale.setScalar(1.2);
  return group;
}

function createConstellationLabel(name) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 28px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(200, 220, 255, 0.8)";
  ctx.shadowBlur = 15;
  ctx.fillStyle = "rgba(220, 230, 255, 0.9)";
  ctx.fillText(name, 128, 32);
  ctx.shadowBlur = 8;
  ctx.fillText(name, 128, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3, 0.75, 1);
  sprite.renderOrder = 100;
  return { sprite, mat, fadeState: 'hidden', fadeTime: 0 };
}

function checkConstellationDiscovery() {
  if (!isInside) return;
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  constellationGroups.forEach((group) => {
    const name = group.userData.name;
    const state = constellationStates.get(name) || 'undiscovered';
    const dist = _camPos.distanceTo(group.position);
    const toConstellation = group.position.clone().sub(_camPos).normalize();
    const dot = camDir.dot(toConstellation);
    if (state === 'undiscovered') {
      if (dot > 0.75 && dist < 40) { constellationStates.set(name, 'discovered'); group.userData.discoveredTime = performance.now(); }
    } else if (state === 'discovered') {
      if (dist < 6) { constellationStates.set(name, 'named'); showConstellationName(group); }
    }
  });
}

function showConstellationName(group) {
  const name = group.userData.name;
  const label = createConstellationLabel(name);
  label.sprite.position.copy(group.position);
  label.sprite.position.y += 2.5;
  scene.add(label.sprite);
  label.fadeState = 'fadeIn';
  label.fadeTime = 0;
  label.groupRef = group;
  constellationLabels.push(label);
}

function updateConstellationLabels(delta) {
  for (let i = constellationLabels.length - 1; i >= 0; i--) {
    const label = constellationLabels[i];
    label.fadeTime += delta;
    if (label.fadeState === 'fadeIn') {
      label.mat.opacity = Math.min(1, label.fadeTime * 2);
      if (label.fadeTime > 2.5) { label.fadeState = 'fadeOut'; label.fadeTime = 0; }
    } else if (label.fadeState === 'fadeOut') {
      label.mat.opacity = Math.max(0, 1 - label.fadeTime * 0.4);
      if (label.mat.opacity <= 0) { scene.remove(label.sprite); constellationLabels.splice(i, 1); }
    }
    if (label.groupRef) { label.sprite.position.copy(label.groupRef.position); label.sprite.position.y += 2.5; }
  }
}

function updateConstellations(time, opacity) {
  constellationGroups.forEach((group) => {
    const name = group.userData.name;
    const state = constellationStates.get(name) || 'undiscovered';
    let brightnessMult = 1, lineBrightness = 0.2;
    if (state === 'undiscovered') { brightnessMult = 0.3; lineBrightness = 0.05; }
    else if (state === 'discovered') {
      const elapsed = (performance.now() - (group.userData.discoveredTime || 0)) / 1000;
      const breath = 0.6 + 0.4 * Math.sin(elapsed * 2.5);
      brightnessMult = 1.2 * breath; lineBrightness = 0.4 * breath;
    }
    group.userData.starMeshes.forEach((star, idx) => {
      const twinkle = 0.7 + 0.3 * Math.sin(time * 1.5 + idx * 0.5 + star.position.x);
      star.userData.baseMat.opacity = opacity * twinkle * brightnessMult;
    });
    group.userData.lineMeshes.forEach((line) => { line.material.opacity = opacity * lineBrightness; });
  });
}

function createNebulaPortal() {
  const group = new THREE.Group();
  const nebulaMat = new THREE.MeshBasicMaterial({ map: nebulaTexture, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  nebulaMat.stencilWrite = true; nebulaMat.stencilRef = 1; nebulaMat.stencilFunc = THREE.EqualStencilFunc;
  const nebulaMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.85), nebulaMat);
  nebulaMesh.position.set(0, 0.95, -0.02);
  nebulaMesh.renderOrder = 1;
  group.add(nebulaMesh);
  group.userData = { nebulaMat };
  return group;
}

function createEasterEggs() {
  const eggs = [];
  const eggData = [
    { text: "Ad Astra", relPos: { forward: 25, right: -18, up: 8 } },
    { text: "Dream", relPos: { forward: 30, right: 20, up: -1 } },
    { text: "✦", relPos: { forward: 35, right: 0, up: 12 } },
  ];
  eggData.forEach((egg) => {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.font = "24px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(180, 180, 200, 0.3)";
    ctx.fillText(egg.text, 128, 32);
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1.5, 0.4, 1);
    sprite.userData = { relPos: egg.relPos, spriteMat };
    eggs.push(sprite);
  });
  return eggs;
}

function build() {
  const texLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();
  const panoTexture = texLoader.load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;

  doorGroup = new THREE.Group();
  scene.add(doorGroup);

  gltfLoader.load(`${BASE}models/doorframe.glb`, (gltf) => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    model.scale.setScalar((DOOR_HEIGHT / size.y) * 0.9);
    model.rotation.y = Math.PI / 2;
    box.setFromObject(model);
    model.position.y = -box.min.y;
    doorGroup.add(model);
  }, undefined, () => {
    const mat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
    left.position.set(-0.55, DOOR_HEIGHT / 2, 0);
    const right = left.clone(); right.position.set(0.55, DOOR_HEIGHT / 2, 0);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.1), mat);
    top.position.set(0, DOOR_HEIGHT, 0);
    doorGroup.add(left, right, top);
  });

  const maskShape = new THREE.Shape();
  const mw = 1.08, mh = 1.9, archR = 0.54;
  maskShape.moveTo(-mw/2, 0);
  maskShape.lineTo(-mw/2, mh - archR);
  maskShape.absarc(0, mh - archR, archR, Math.PI, 0, true);
  maskShape.lineTo(mw/2, 0);
  maskShape.closePath();

  const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  maskMat.stencilWrite = true; maskMat.stencilRef = 1; maskMat.stencilFunc = THREE.AlwaysStencilFunc; maskMat.stencilZPass = THREE.ReplaceStencilOp;
  portalMask = new THREE.Mesh(new THREE.ShapeGeometry(maskShape, 32), maskMat);
  portalMask.position.set(0, 0.01, -0.03);
  portalMask.renderOrder = 0;
  doorGroup.add(portalMask);

  nebulaPortal = createNebulaPortal();
  doorGroup.add(nebulaPortal);

  ambientStarData = createAmbientStars(150);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

  skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 64, 32),
    new THREE.MeshBasicMaterial({ map: panoTexture, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false })
  );
  skySphere.rotation.y = Math.PI;
  skySphere.renderOrder = 1;
  scene.add(skySphere);

  // 背景星星
  starData = createStars(8000, SKY_RADIUS * 0.95, 0.35);
  skyStars = starData.points;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  // 浮动星星
  floatingStarData = createFloatingStars(2500, SKY_RADIUS * 0.08, SKY_RADIUS * 0.5, 0.3);
  floatingStars = floatingStarData.points;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  // 明亮星星
  brightStarData = createBrightStars(150, SKY_RADIUS * 0.85);
  brightStars = brightStarData.points;
  brightStars.renderOrder = 4;
  scene.add(brightStars);

  // ★★★ 近身星星（围绕用户，数量多）★★★
  nearbyStarData = createNearbyStars(500);
  nearbyStars = nearbyStarData.points;
  scene.add(nearbyStars);

  // 空间星星
  spaceStarData = createSpaceStars(600);
  spaceStars = spaceStarData.points;
  spaceStars.renderOrder = 6;
  scene.add(spaceStars);

  const moonGeo = new THREE.SphereGeometry(4, 64, 64);
  moonMesh = new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0 }));
  moonMesh.renderOrder = 10;
  scene.add(moonMesh);

  const jupiterGeo = new THREE.SphereGeometry(7, 64, 64);
  jupiterMesh = new THREE.Mesh(jupiterGeo, new THREE.MeshBasicMaterial({ color: 0xddaa77, transparent: true, opacity: 0 }));
  jupiterMesh.renderOrder = 10;
  scene.add(jupiterMesh);

  const marsGeo = new THREE.SphereGeometry(3, 64, 64);
  marsMesh = new THREE.Mesh(marsGeo, new THREE.MeshBasicMaterial({ color: 0xdd6644, transparent: true, opacity: 0 }));
  marsMesh.renderOrder = 10;
  scene.add(marsMesh);

  const saturnGeo = new THREE.SphereGeometry(5, 64, 64);
  saturnMesh = new THREE.Mesh(saturnGeo, new THREE.MeshBasicMaterial({ color: 0xddcc88, transparent: true, opacity: 0 }));
  saturnMesh.renderOrder = 10;
  scene.add(saturnMesh);

  const ringInnerRadius = 6.5, ringOuterRadius = 11;
  const ringGeo = new THREE.RingGeometry(ringInnerRadius, ringOuterRadius, 128);
  const ringUV = ringGeo.attributes.uv;
  const ringPos = ringGeo.attributes.position;
  for (let i = 0; i < ringUV.count; i++) {
    const x = ringPos.getX(i), y = ringPos.getY(i);
    const r = Math.sqrt(x * x + y * y);
    const u = (r - ringInnerRadius) / (ringOuterRadius - ringInnerRadius);
    ringUV.setXY(i, u, 0.5);
  }
  const ringTexture = createSaturnRingTexture();
  saturnRingMesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ map: ringTexture, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.NormalBlending }));
  saturnRingMesh.rotation.x = Math.PI / 2.2;
  saturnRingMesh.renderOrder = 11;
  scene.add(saturnRingMesh);

  const sunGeo = new THREE.SphereGeometry(8, 64, 64);
  sunMesh = new THREE.Mesh(sunGeo, new THREE.MeshBasicMaterial({ color: 0xffdd88, transparent: true, opacity: 0 }));
  sunMesh.renderOrder = 10;
  scene.add(sunMesh);

  const sunGlowTexture = createSunGlowTexture();
  const sunGlowMat = new THREE.SpriteMaterial({ map: sunGlowTexture, color: 0xffeeaa, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  sunGlowSprite = new THREE.Sprite(sunGlowMat);
  sunGlowSprite.scale.set(40, 40, 1);
  sunGlowSprite.renderOrder = 9;
  scene.add(sunGlowSprite);

  texLoader.load(`${BASE}textures/moon.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; moonMesh.material.map = tex; moonMesh.material.color.set(0xffffff); moonMesh.material.needsUpdate = true; });
  texLoader.load(`${BASE}textures/earth.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; jupiterMesh.material.map = tex; jupiterMesh.material.color.set(0xffffff); jupiterMesh.material.needsUpdate = true; });
  texLoader.load(`${BASE}textures/mars.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; marsMesh.material.map = tex; marsMesh.material.color.set(0xffffff); marsMesh.material.needsUpdate = true; });
  texLoader.load(`${BASE}textures/saturn.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; saturnMesh.material.map = tex; saturnMesh.material.color.set(0xffffff); saturnMesh.material.needsUpdate = true; });
  texLoader.load(`${BASE}textures/saturn_ring.png`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; saturnRingMesh.material.map = tex; saturnRingMesh.material.needsUpdate = true; });
  texLoader.load(`${BASE}textures/sun.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; sunMesh.material.map = tex; sunMesh.material.color.set(0xffffff); sunMesh.material.needsUpdate = true; });

  const constellationsData = getConstellationsData();
  constellationsData.forEach((data) => {
    const constellation = createConstellation(data);
    constellation.renderOrder = 15;
    scene.add(constellation);
    constellationGroups.push(constellation);
    constellationStates.set(data.name, 'undiscovered');
  });

  easterEggs = createEasterEggs();
  easterEggs.forEach(egg => scene.add(egg));
}

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

  doorPlanePoint.copy(doorGroup.position);
  doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);
  doorForward.set(0, 0, -1).applyQuaternion(doorGroup.quaternion);
  doorRight.set(1, 0, 0).applyQuaternion(doorGroup.quaternion);
  doorUp.set(0, 1, 0);

  lastSide = getSide(xrCam);
  isInside = false;
  transitionValue = 0;
  placed = true;
  placedTime = performance.now();
  meteorShowerTriggered = false;
  reticle.visible = false;

  playAudio();
}

function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  return doorPlaneNormal.dot(_camPos.clone().sub(doorPlanePoint)) >= 0 ? 1 : -1;
}

function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  const signedDist = doorPlaneNormal.dot(_camPos.clone().sub(doorPlanePoint));
  const currentSide = signedDist >= 0 ? 1 : -1;
  
  if (lastSide === 1 && currentSide === -1 && !isInside) isInside = true;
  else if (lastSide === -1 && currentSide === 1 && isInside) isInside = false;
  lastSide = currentSide;
  
  const target = isInside ? 1 : 0;
  transitionValue += (target - transitionValue) * delta * 1.8;
  transitionValue = Math.max(0, Math.min(1, transitionValue));
  
  const t = transitionValue;
  const smooth = t * t * t * (t * (t * 6 - 15) + 10);
  
  if (skySphere) skySphere.material.opacity = smooth;
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  if (nearbyStars) nearbyStars.material.opacity = smooth;  // ★ 近身星星
  if (spaceStars) spaceStars.material.opacity = smooth;
  if (moonMesh) moonMesh.material.opacity = smooth;
  if (jupiterMesh) jupiterMesh.material.opacity = smooth;
  if (marsMesh) marsMesh.material.opacity = smooth;
  if (saturnMesh) saturnMesh.material.opacity = smooth;
  if (saturnRingMesh) saturnRingMesh.material.opacity = smooth * 0.85;
  if (sunMesh) sunMesh.material.opacity = smooth;
  if (sunGlowSprite) sunGlowSprite.material.opacity = smooth * 0.6;
  
  easterEggs.forEach(egg => { egg.userData.spriteMat.opacity = smooth * 0.3; });
  updateConstellations(performance.now() / 1000, smooth);
  
  const previewOp = 1 - smooth;
  if (nebulaPortal) nebulaPortal.userData.nebulaMat.opacity = previewOp * 0.5;
  if (ambientStars) ambientStars.material.opacity = previewOp * 0.8;
  if (portalMask) portalMask.visible = smooth < 0.99;
}

function updateCelestialBodies(time, delta) {
  if (moonMesh) {
    const moonPos = doorPlanePoint.clone().addScaledVector(doorForward, 12).addScaledVector(doorRight, -8);
    moonPos.y = doorPlanePoint.y + 6;
    moonMesh.position.copy(moonPos);
    moonMesh.rotation.y += delta * 0.05;
  }
  if (jupiterMesh) {
    const jupiterPos = doorPlanePoint.clone().addScaledVector(doorForward, 28).addScaledVector(doorRight, 15);
    jupiterPos.y = doorPlanePoint.y + 5;
    jupiterMesh.position.copy(jupiterPos);
    jupiterMesh.rotation.y += delta * 0.03;
  }
  if (marsMesh) {
    const marsPos = doorPlanePoint.clone().addScaledVector(doorForward, 25).addScaledVector(doorRight, 5);
    marsPos.y = doorPlanePoint.y - 8;
    marsMesh.position.copy(marsPos);
    marsMesh.rotation.y += delta * 0.04;
  }
  if (saturnMesh) {
    const saturnPos = doorPlanePoint.clone().addScaledVector(doorForward, -25).addScaledVector(doorRight, -15);
    saturnPos.y = doorPlanePoint.y + 10;
    saturnMesh.position.copy(saturnPos);
    saturnMesh.rotation.y += delta * 0.015;
    if (saturnRingMesh) {
      saturnRingMesh.position.copy(saturnPos);
      saturnRingMesh.rotation.z = Math.sin(time * 0.1) * 0.02;
    }
  }
  if (sunMesh) {
    const sunPos = doorPlanePoint.clone().addScaledVector(doorForward, -55).addScaledVector(doorRight, 25);
    sunPos.y = doorPlanePoint.y + 18;
    sunMesh.position.copy(sunPos);
    sunMesh.rotation.y += delta * 0.01;
    if (sunGlowSprite) {
      sunGlowSprite.position.copy(sunPos);
      const glowScale = 40 + Math.sin(time * 0.5) * 3;
      sunGlowSprite.scale.set(glowScale, glowScale, 1);
    }
  }
  constellationGroups.forEach((group) => {
    const rel = group.userData.relPos;
    const pos = doorPlanePoint.clone().addScaledVector(doorForward, rel.forward).addScaledVector(doorRight, rel.right);
    pos.y = doorPlanePoint.y + rel.up;
    group.position.copy(pos);
    group.lookAt(_camPos);
  });
  easterEggs.forEach((egg) => {
    const rel = egg.userData.relPos;
    const eggPos = doorPlanePoint.clone().addScaledVector(doorForward, rel.forward).addScaledVector(doorRight, rel.right);
    eggPos.y = doorPlanePoint.y + rel.up;
    egg.position.copy(eggPos);
  });
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  if (skySphere) { skySphere.position.copy(_camPos); skySphere.rotation.y += delta * 0.003; }
  if (skyStars) { skyStars.position.copy(_camPos); skyStars.rotation.y += delta * 0.003; }
  if (floatingStars) floatingStars.position.copy(_camPos);
  if (brightStars) brightStars.position.copy(_camPos);
}

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
        session.requestHitTestSource({ space }).then((src) => { hitTestSource = src; });
      });
      session.addEventListener("end", () => { hitTestSource = null; reset(); });
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
    updateCelestialBodies(time, delta);
    
    // 更新所有星星
    updateStars(starData, time);
    updateFloatingStars(floatingStarData, time);
    updateBrightStars(brightStarData, time);
    updateSpaceStars(spaceStarData, time);
    
    // ★★★ 更新近身星星（传入用户位置）★★★
    xrCam.getWorldPosition(_camPos);
    updateNearbyStars(nearbyStarData, time, _camPos);
    
    updateConstellationLabels(delta);
    checkConstellationDiscovery();
    
    if (!meteorShowerTriggered && isInside && (now - placedTime) >= 190000) {
      meteorShowerTriggered = true;
      spawnMeteorShower();
    }
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false; isInside = false; transitionValue = 0; placedTime = 0; meteorShowerTriggered = false;
  constellationStates.clear();
  if (bgAudio) { bgAudio.pause(); bgAudio.currentTime = 0; audioStarted = false; }
  meteors.forEach(m => { scene.remove(m); if (m.userData.trailSprites) m.userData.trailSprites.forEach(ts => scene.remove(ts.sprite)); });
  meteors = [];
  constellationLabels.forEach(l => scene.remove(l.sprite));
  constellationLabels = [];
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) { scene.remove(skySphere); skySphere = null; }
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  if (floatingStars) { scene.remove(floatingStars); floatingStars = null; }
  if (brightStars) { scene.remove(brightStars); brightStars = null; }
  if (nearbyStars) { scene.remove(nearbyStars); nearbyStars = null; }  // ★ 清理近身星星
  if (spaceStars) { scene.remove(spaceStars); spaceStars = null; }
  if (moonMesh) { scene.remove(moonMesh); moonMesh = null; }
  if (jupiterMesh) { scene.remove(jupiterMesh); jupiterMesh = null; }
  if (marsMesh) { scene.remove(marsMesh); marsMesh = null; }
  if (saturnMesh) { scene.remove(saturnMesh); saturnMesh = null; }
  if (saturnRingMesh) { scene.remove(saturnRingMesh); saturnRingMesh = null; }
  if (sunMesh) { scene.remove(sunMesh); sunMesh = null; }
  if (sunGlowSprite) { scene.remove(sunGlowSprite); sunGlowSprite = null; }
  constellationGroups.forEach(g => scene.remove(g));
  constellationGroups = [];
  easterEggs.forEach(egg => scene.remove(egg));
  easterEggs = [];
  nebulaPortal = null; ambientStars = null; portalMask = null;
  starData = null; floatingStarData = null; brightStarData = null; ambientStarData = null; spaceStarData = null; nearbyStarData = null;
  reticle.visible = false;
}
