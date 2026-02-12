import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";

const BASE = import.meta.env.BASE_URL;

// ============ 版本切换 ============
const USE_GLB_GALAXY = true;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let fogPortal = null;
let ambientStars = null;
let skySphere = null;
let galaxyModel = null;
let skyStars = null;
let floatingStars = null;
let brightStars = null;
let moonMesh = null;
let earthMesh = null;
let easterEggs = [];
let portalGlow = null;
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
let ambientStarData = null;

// 流星
let meteors = [];
let touchPoints = [];
let isTouching = false;

// 纹理
let starTexture = null;
let starSpriteTexture = null;
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

  const texLoader = new THREE.TextureLoader();
  starSpriteTexture = texLoader.load(`${BASE}textures/stars.png`);
  starSpriteTexture.colorSpace = THREE.SRGBColorSpace;
  
  meteorTexture = texLoader.load(`${BASE}textures/meteor.png`);
  meteorTexture.colorSpace = THREE.SRGBColorSpace;
  
  starTexture = createStarTexture();

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

  const modeLabel = document.createElement("div");
  modeLabel.textContent = USE_GLB_GALAXY ? "🌌 GLB Mode" : "🖼️ Pano Mode";
  modeLabel.style.cssText = "position:fixed;top:10px;right:10px;z-index:9999;padding:8px 12px;background:rgba(0,100,200,0.7);color:#fff;border-radius:6px;font-size:12px;";
  document.body.appendChild(modeLabel);

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

function initTouchEvents() {
  const canvas = renderer.domElement;
  
  canvas.addEventListener("touchstart", (e) => {
    if (!placed) return;
    isTouching = true;
    touchPoints = [];
    for (let i = 0; i < e.touches.length; i++) {
      touchPoints.push({ x: e.touches[i].clientX, y: e.touches[i].clientY });
    }
  }, { passive: true });
  
  canvas.addEventListener("touchmove", (e) => {
    if (!isTouching) return;
    for (let i = 0; i < e.touches.length; i++) {
      touchPoints.push({ x: e.touches[i].clientX, y: e.touches[i].clientY });
    }
    if (touchPoints.length > 30) touchPoints = touchPoints.slice(-30);
  }, { passive: true });
  
  canvas.addEventListener("touchend", () => {
    if (!isTouching) return;
    isTouching = false;
    
    if (isInside && touchPoints.length >= 2) {
      const start = touchPoints[0];
      const end = touchPoints[touchPoints.length - 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 20) {
        spawnMeteor(dx, dy, len);
      }
    }
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

// ============ 星星纹理 ============
function createStarTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  const gradient = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.15, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.25)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.05)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建星星 ============
function createStars(count, radius, baseSize, useStencil = false) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  const starColors = [
    [1, 1, 1], [0.95, 0.97, 1], [0.85, 0.92, 1],
    [0.75, 0.85, 1], [1, 0.97, 0.9], [1, 0.93, 0.7],
  ];
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.75 + 0.25 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = starColors[Math.floor(Math.random() * starColors.length)];
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
    
    phases[i * 4] = Math.random() * Math.PI * 2;
    phases[i * 4 + 1] = 0.5 + Math.random() * 2.0;
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
  
  if (useStencil) {
    mat.stencilWrite = true;
    mat.stencilRef = 1;
    mat.stencilFunc = THREE.EqualStencilFunc;
  }
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

function createFloatingStars(count, minR, maxR, baseSize) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = minR + Math.random() * (maxR - minR);
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    colors[i * 3] = 1;
    colors[i * 3 + 1] = 1;
    colors[i * 3 + 2] = 1;
    
    phases[i * 4] = Math.random() * Math.PI * 2;
    phases[i * 4 + 1] = 0.3 + Math.random() * 1.5;
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

function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 2);
  
  const brightColors = [[1,1,1], [0.8,0.9,1], [1,0.95,0.7]];
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = brightColors[Math.floor(Math.random() * brightColors.length)];
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
    
    phases[i * 2] = Math.random() * Math.PI * 2;
    phases[i * 2 + 1] = 0.2 + Math.random() * 0.6;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starSpriteTexture,
    size: 1.2,
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

function createAmbientStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 5;
    positions[i * 3 + 1] = 0.3 + Math.random() * 2.5;
    positions[i * 3 + 2] = -0.5 - Math.random() * 3;
    
    const b = 0.7 + Math.random() * 0.3;
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
    
    phases[i * 4] = Math.random() * Math.PI * 2;
    phases[i * 4 + 1] = 0.5 + Math.random() * 2.0;
    phases[i * 4 + 2] = Math.random() * Math.PI * 2;
    phases[i * 4 + 3] = Math.random() * Math.PI * 2;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.06,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ 更新星星 ============
function updateStars(data, time) {
  if (!data) return;
  const { points, positions, colors, phases } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const p1 = phases[i * 4];
    const speed = phases[i * 4 + 1];
    const p2 = phases[i * 4 + 2];
    const p3 = phases[i * 4 + 3];
    
    const twinkle = 0.65 + 0.35 * Math.sin(time * speed + p1);
    col[i * 3] = colors[i * 3] * twinkle;
    col[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    col[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    const drift = 0.12;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.2 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.15 + p1) * drift * 0.4;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.sin(time * 0.18 + p3) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

function updateFloatingStars(data, time) {
  if (!data) return;
  const { points, positions, colors, phases } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const p1 = phases[i * 4];
    const speed = phases[i * 4 + 1];
    const p2 = phases[i * 4 + 2];
    const p3 = phases[i * 4 + 3];
    
    const twinkle = 0.5 + 0.5 * Math.sin(time * speed + p1);
    col[i * 3] = twinkle;
    col[i * 3 + 1] = twinkle;
    col[i * 3 + 2] = twinkle;
    
    const drift = 0.5;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.1 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.sin(time * 0.08 + p1) * drift * 0.4;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.cos(time * 0.12 + p3) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

function updateBrightStars(data, time) {
  if (!data) return;
  const { points, colors, phases } = data;
  const col = points.geometry.attributes.color.array;
  const count = colors.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase = phases[i * 2];
    const speed = phases[i * 2 + 1];
    const pulse = 0.6 + 0.4 * Math.sin(time * speed + phase);
    col[i * 3] = colors[i * 3] * pulse;
    col[i * 3 + 1] = colors[i * 3 + 1] * pulse;
    col[i * 3 + 2] = colors[i * 3 + 2] * pulse;
  }
  
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 精美流星（使用meteor.png + 粒子拖尾）============
function spawnMeteor(dx, dy, len) {
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  const dir = new THREE.Vector3()
    .addScaledVector(camRight, dx / len)
    .addScaledVector(camUp, -dy / len)
    .addScaledVector(camForward, 0.3)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(10 + Math.random() * 10))
    .add(camUp.clone().multiplyScalar(3 + Math.random() * 5))
    .add(camRight.clone().multiplyScalar((Math.random() - 0.5) * 10));
  
  const meteor = createBeautifulMeteor(spawnPos, dir);
  scene.add(meteor);
  meteors.push(meteor);
}

function createBeautifulMeteor(pos, dir) {
  const group = new THREE.Group();
  group.position.copy(pos);
  
  // 让group朝向飞行方向
  const up = new THREE.Vector3(0, 1, 0);
  const quaternion = new THREE.Quaternion();
  const lookMatrix = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up);
  quaternion.setFromRotationMatrix(lookMatrix);
  group.quaternion.copy(quaternion);
  
  // 流星核心 - 使用meteor.png
  const coreMat = new THREE.SpriteMaterial({
    map: meteorTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    rotation: Math.PI / 2,
  });
  const coreSprite = new THREE.Sprite(coreMat);
  coreSprite.scale.set(0.8, 0.3, 1);
  group.add(coreSprite);
  
  // 内层光晕
  const innerGlowMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffeedd,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
  });
  const innerGlow = new THREE.Sprite(innerGlowMat);
  innerGlow.scale.set(0.4, 0.4, 1);
  group.add(innerGlow);
  
  // 外层光晕
  const outerGlowMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffaa66,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
  });
  const outerGlow = new THREE.Sprite(outerGlowMat);
  outerGlow.scale.set(0.7, 0.7, 1);
  group.add(outerGlow);
  
  // 粒子拖尾
  const tailLength = 2.5;
  const trailCount = 50;
  const trailPositions = new Float32Array(trailCount * 3);
  const trailColors = new Float32Array(trailCount * 3);
  const trailSizes = new Float32Array(trailCount);
  
  for (let i = 0; i < trailCount; i++) {
    const t = i / (trailCount - 1);
    const spread = t * t * 0.03;
    
    trailPositions[i * 3] = (Math.random() - 0.5) * spread;
    trailPositions[i * 3 + 1] = (Math.random() - 0.5) * spread;
    trailPositions[i * 3 + 2] = -t * tailLength;
    
    const fade = Math.pow(1 - t, 1.8);
    // 渐变色：白 → 黄 → 橙 → 红 → 蓝
    let r, g, b;
    if (t < 0.1) {
      r = 1; g = 1; b = 1;
    } else if (t < 0.3) {
      const blend = (t - 0.1) / 0.2;
      r = 1; g = 1 - blend * 0.15; b = 1 - blend * 0.5;
    } else if (t < 0.5) {
      const blend = (t - 0.3) / 0.2;
      r = 1; g = 0.85 - blend * 0.25; b = 0.5 - blend * 0.3;
    } else if (t < 0.75) {
      const blend = (t - 0.5) / 0.25;
      r = 1 - blend * 0.3; g = 0.6 - blend * 0.2; b = 0.2 + blend * 0.3;
    } else {
      const blend = (t - 0.75) / 0.25;
      r = 0.7 - blend * 0.4; g = 0.4 - blend * 0.1; b = 0.5 + blend * 0.3;
    }
    
    trailColors[i * 3] = r * fade;
    trailColors[i * 3 + 1] = g * fade;
    trailColors[i * 3 + 2] = b * fade;
    
    trailSizes[i] = (1 - t * 0.8) * 0.1;
  }
  
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
  
  const trailMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.1,
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
  const sparkCount = 20;
  const sparkPositions = new Float32Array(sparkCount * 3);
  const sparkColors = new Float32Array(sparkCount * 3);
  
  for (let i = 0; i < sparkCount; i++) {
    const t = Math.random() * 0.6;
    const spread = t * 0.08;
    sparkPositions[i * 3] = (Math.random() - 0.5) * spread;
    sparkPositions[i * 3 + 1] = (Math.random() - 0.5) * spread;
    sparkPositions[i * 3 + 2] = -t * tailLength;
    
    const brightness = 0.5 + Math.random() * 0.5;
    sparkColors[i * 3] = brightness;
    sparkColors[i * 3 + 1] = brightness * 0.8;
    sparkColors[i * 3 + 2] = brightness * 0.5;
  }
  
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(sparkColors, 3));
  
  const sparkMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.05,
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
    speed: 4 + Math.random() * 3,
    life: 0,
    maxLife: 4 + Math.random() * 2,
    coreMat,
    innerGlowMat,
    outerGlowMat,
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
    let fade = progress < 0.1 ? progress / 0.1 : Math.pow(1 - (progress - 0.1) / 0.9, 0.6);
    
    d.coreMat.opacity = fade;
    d.innerGlowMat.opacity = fade * 0.8;
    d.outerGlowMat.opacity = fade * 0.4;
    d.trailMat.opacity = fade;
    d.sparkMat.opacity = fade * 0.8;
    
    if (d.life >= d.maxLife) {
      scene.remove(m);
      meteors.splice(i, 1);
    }
  }
}

// ============ 创建雾门（GLB模式用）============
function createFogPortal() {
  const group = new THREE.Group();
  
  // 神秘雾气粒子
  const fogCount = 500;
  const fogPositions = new Float32Array(fogCount * 3);
  const fogColors = new Float32Array(fogCount * 3);
  const fogPhases = new Float32Array(fogCount * 3);
  
  for (let i = 0; i < fogCount; i++) {
    // 在门框内分布
    const x = (Math.random() - 0.5) * 1.0;
    const y = Math.random() * 1.8;
    const z = (Math.random() - 0.5) * 0.3;
    
    fogPositions[i * 3] = x;
    fogPositions[i * 3 + 1] = y;
    fogPositions[i * 3 + 2] = z;
    
    // 神秘紫蓝色
    const hue = 0.6 + Math.random() * 0.2;
    const color = new THREE.Color().setHSL(hue, 0.5, 0.6);
    fogColors[i * 3] = color.r;
    fogColors[i * 3 + 1] = color.g;
    fogColors[i * 3 + 2] = color.b;
    
    fogPhases[i * 3] = Math.random() * Math.PI * 2;
    fogPhases[i * 3 + 1] = 0.5 + Math.random() * 1.5;
    fogPhases[i * 3 + 2] = Math.random() * Math.PI * 2;
  }
  
  const fogGeo = new THREE.BufferGeometry();
  fogGeo.setAttribute("position", new THREE.BufferAttribute(fogPositions, 3));
  fogGeo.setAttribute("color", new THREE.BufferAttribute(fogColors, 3));
  
  const fogMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.15,
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  fogMat.stencilWrite = true;
  fogMat.stencilRef = 1;
  fogMat.stencilFunc = THREE.EqualStencilFunc;
  
  const fog = new THREE.Points(fogGeo, fogMat);
  fog.renderOrder = 1;
  group.add(fog);
  
  // 中心光柱
  const beamGeo = new THREE.CylinderGeometry(0.3, 0.5, 1.9, 16, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0x6688ff,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  beamMat.stencilWrite = true;
  beamMat.stencilRef = 1;
  beamMat.stencilFunc = THREE.EqualStencilFunc;
  
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = 0.95;
  beam.renderOrder = 1;
  group.add(beam);
  
  group.userData = {
    fogPositions: fogPositions.slice(),
    fogGeo,
    fogPhases,
  };
  
  return group;
}

function updateFogPortal(fogPortal, time) {
  if (!fogPortal) return;
  const { fogPositions, fogGeo, fogPhases } = fogPortal.userData;
  const pos = fogGeo.attributes.position.array;
  const count = fogPositions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase = fogPhases[i * 3];
    const speed = fogPhases[i * 3 + 1];
    const offset = fogPhases[i * 3 + 2];
    
    pos[i * 3] = fogPositions[i * 3] + Math.sin(time * speed + phase) * 0.05;
    pos[i * 3 + 1] = fogPositions[i * 3 + 1] + Math.sin(time * 0.5 + offset) * 0.03;
    pos[i * 3 + 2] = fogPositions[i * 3 + 2] + Math.cos(time * speed + phase) * 0.03;
  }
  
  fogGeo.attributes.position.needsUpdate = true;
}

// ============ 创建门框光效 ============
function createPortalGlow() {
  const group = new THREE.Group();
  
  // 门框边缘发光粒子
  const glowCount = 200;
  const glowPositions = new Float32Array(glowCount * 3);
  const glowColors = new Float32Array(glowCount * 3);
  const glowPhases = new Float32Array(glowCount * 2);
  
  for (let i = 0; i < glowCount; i++) {
    // 沿门框边缘分布
    const t = i / glowCount;
    let x, y;
    
    if (t < 0.35) {
      // 左边
      x = -0.54;
      y = (t / 0.35) * 1.4;
    } else if (t < 0.65) {
      // 顶部弧线
      const angle = Math.PI + ((t - 0.35) / 0.3) * Math.PI;
      x = Math.cos(angle) * 0.54;
      y = 1.4 + Math.sin(angle) * 0.54;
    } else {
      // 右边
      x = 0.54;
      y = 1.4 * (1 - (t - 0.65) / 0.35);
    }
    
    glowPositions[i * 3] = x + (Math.random() - 0.5) * 0.05;
    glowPositions[i * 3 + 1] = y + (Math.random() - 0.5) * 0.05;
    glowPositions[i * 3 + 2] = (Math.random() - 0.5) * 0.05;
    
    // 金色/白色光
    const brightness = 0.7 + Math.random() * 0.3;
    glowColors[i * 3] = brightness;
    glowColors[i * 3 + 1] = brightness * 0.9;
    glowColors[i * 3 + 2] = brightness * 0.6;
    
    glowPhases[i * 2] = Math.random() * Math.PI * 2;
    glowPhases[i * 2 + 1] = 1 + Math.random() * 2;
  }
  
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
  glowGeo.setAttribute("color", new THREE.BufferAttribute(glowColors, 3));
  
  const glowMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.08,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const glow = new THREE.Points(glowGeo, glowMat);
  group.add(glow);
  
  group.userData = {
    glowGeo,
    glowColors: glowColors.slice(),
    glowPhases,
  };
  
  return group;
}

function updatePortalGlow(portalGlow, time) {
  if (!portalGlow) return;
  const { glowGeo, glowColors, glowPhases } = portalGlow.userData;
  const col = glowGeo.attributes.color.array;
  const count = glowColors.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase = glowPhases[i * 2];
    const speed = glowPhases[i * 2 + 1];
    const pulse = 0.5 + 0.5 * Math.sin(time * speed + phase);
    col[i * 3] = glowColors[i * 3] * pulse;
    col[i * 3 + 1] = glowColors[i * 3 + 1] * pulse;
    col[i * 3 + 2] = glowColors[i * 3 + 2] * pulse;
  }
  
  glowGeo.attributes.color.needsUpdate = true;
}

// ============ 创建彩蛋文字 ============
function createEasterEggs() {
  const eggs = [];
  
  // 彩蛋内容
  const eggContents = [
    { text: "✨ Ad Astra ✨", pos: [-15, 3, -20], color: 0xffd700 },
    { text: "🌙 Dream Big 🌙", pos: [18, 5, -25], color: 0x88ccff },
    { text: "⭐ You Found Me ⭐", pos: [0, -2, -30], color: 0xff88cc },
  ];
  
  eggContents.forEach((egg, index) => {
    const group = new THREE.Group();
    
    // 用粒子组成文字效果
    const textParticleCount = 100;
    const positions = new Float32Array(textParticleCount * 3);
    const colors = new Float32Array(textParticleCount * 3);
    const phases = new Float32Array(textParticleCount * 2);
    
    const color = new THREE.Color(egg.color);
    
    // 在小范围内随机分布，形成发光云
    for (let i = 0; i < textParticleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 2;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 0.8;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
      
      const brightness = 0.6 + Math.random() * 0.4;
      colors[i * 3] = color.r * brightness;
      colors[i * 3 + 1] = color.g * brightness;
      colors[i * 3 + 2] = color.b * brightness;
      
      phases[i * 2] = Math.random() * Math.PI * 2;
      phases[i * 2 + 1] = 0.5 + Math.random() * 1.5;
    }
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    
    const mat = new THREE.PointsMaterial({
      map: starSpriteTexture,
      size: 0.15,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    
    const particles = new THREE.Points(geo, mat);
    group.add(particles);
    
    // 创建2D文字精灵
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "transparent";
    ctx.fillRect(0, 0, 512, 128);
    ctx.font = "bold 48px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `#${color.getHexString()}`;
    ctx.shadowColor = `#${color.getHexString()}`;
    ctx.shadowBlur = 20;
    ctx.fillText(egg.text, 256, 64);
    
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(4, 1, 1);
    group.add(sprite);
    
    group.position.set(...egg.pos);
    
    group.userData = {
      particleMat: mat,
      spriteMat,
      geo,
      positions: positions.slice(),
      colors: colors.slice(),
      phases,
      basePos: new THREE.Vector3(...egg.pos),
    };
    
    eggs.push(group);
  });
  
  return eggs;
}

function updateEasterEggs(eggs, time, camPos, smooth) {
  eggs.forEach((egg, index) => {
    const d = egg.userData;
    
    // 透明度随过渡
    d.particleMat.opacity = smooth * 0.8;
    d.spriteMat.opacity = smooth * 0.9;
    
    // 粒子动画
    const pos = d.geo.attributes.position.array;
    const col = d.geo.attributes.color.array;
    const count = d.positions.length / 3;
    
    for (let i = 0; i < count; i++) {
      const phase = d.phases[i * 2];
      const speed = d.phases[i * 2 + 1];
      
      pos[i * 3] = d.positions[i * 3] + Math.sin(time * speed + phase) * 0.1;
      pos[i * 3 + 1] = d.positions[i * 3 + 1] + Math.cos(time * speed * 0.7 + phase) * 0.05;
      
      const pulse = 0.6 + 0.4 * Math.sin(time * speed + phase);
      col[i * 3] = d.colors[i * 3] * pulse;
      col[i * 3 + 1] = d.colors[i * 3 + 1] * pulse;
      col[i * 3 + 2] = d.colors[i * 3 + 2] * pulse;
    }
    
    d.geo.attributes.position.needsUpdate = true;
    d.geo.attributes.color.needsUpdate = true;
    
    // 轻微浮动
    egg.position.y = d.basePos.y + Math.sin(time * 0.3 + index) * 0.2;
  });
}

// ============ 构建场景 ============
function build() {
  const texLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();
  
  const panoTexture = texLoader.load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;

  doorGroup = new THREE.Group();
  scene.add(doorGroup);

  gltfLoader.load(
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

  // 门框发光效果
  portalGlow = createPortalGlow();
  portalGlow.position.set(0, 0.05, 0);
  doorGroup.add(portalGlow);

  if (USE_GLB_GALAXY) {
    // GLB模式：使用雾门
    fogPortal = createFogPortal();
    fogPortal.position.set(0, 0.05, -0.05);
    doorGroup.add(fogPortal);
  } else {
    // Pano模式：预览天球
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
    previewSphere.rotation.y = Math.PI;
    previewSphere.renderOrder = 1;
    previewSphere.frustumCulled = false;
    doorGroup.add(previewSphere);

    // 预览星星
    previewStarData = createStars(5000, PREVIEW_RADIUS * 0.9, 0.1, true);
    previewStars = previewStarData.points;
    previewStars.renderOrder = 2;
    doorGroup.add(previewStars);
  }

  // 门外环境星星
  ambientStarData = createAmbientStars(200);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

  // ===== 门内世界 =====
  if (USE_GLB_GALAXY) {
    gltfLoader.load(`${BASE}models/galaxy.glb`, (gltf) => {
      galaxyModel = gltf.scene;
      galaxyModel.scale.setScalar(SKY_RADIUS * 0.5);
      galaxyModel.traverse((child) => {
        if (child.isMesh) {
          child.material.transparent = true;
          child.material.opacity = 0;
          child.material.depthWrite = false;
        }
      });
      galaxyModel.renderOrder = 1;
      scene.add(galaxyModel);
    }, undefined, (err) => {
      console.warn("Galaxy GLB load failed");
      createPanoSphere(panoTexture);
    });
  } else {
    createPanoSphere(panoTexture);
  }

  // 星星
  starData = createStars(4000, SKY_RADIUS * 0.95, 0.22, false);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  floatingStarData = createFloatingStars(1000, SKY_RADIUS * 0.1, SKY_RADIUS * 0.4, 0.25);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  brightStarData = createBrightStars(40, SKY_RADIUS * 0.9);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = 4;
  scene.add(brightStars);

  // ===== 天体 - 放在门后更深处 =====
  // 月球 - 门后左侧深处
  const moonGeo = new THREE.SphereGeometry(4, 64, 64);
  const moonMat = new THREE.MeshBasicMaterial({
    color: 0xdddddd,
    transparent: true,
    opacity: 0,
  });
  moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonMesh.renderOrder = 10;
  scene.add(moonMesh);

  // 地球 - 门后右侧深处
  const earthGeo = new THREE.SphereGeometry(6, 64, 64);
  const earthMat = new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0,
  });
  earthMesh = new THREE.Mesh(earthGeo, earthMat);
  earthMesh.renderOrder = 10;
  scene.add(earthMesh);

  // 加载贴图
  texLoader.load(`${BASE}textures/moon.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    moonMesh.material.map = tex;
    moonMesh.material.color.set(0xffffff);
    moonMesh.material.needsUpdate = true;
  }, undefined, () => {});

  texLoader.load(`${BASE}textures/earth.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    earthMesh.material.map = tex;
    earthMesh.material.color.set(0xffffff);
    earthMesh.material.needsUpdate = true;
  }, undefined, () => {});

  // ===== 彩蛋 =====
  easterEggs = createEasterEggs();
  easterEggs.forEach(egg => scene.add(egg));
}

function createPanoSphere(panoTexture) {
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
  skySphere.rotation.y = Math.PI;
  skySphere.renderOrder = 1;
  scene.add(skySphere);
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

  if (previewSphere) previewSphere.position.set(0, 1, -PREVIEW_RADIUS * 0.4);
  if (previewStars) previewStars.position.set(0, 1, -PREVIEW_RADIUS * 0.4);

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

// ============ 过渡 ============
function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  const signedDist = doorPlaneNormal.dot(toCamera);
  
  const currentSide = signedDist >= 0 ? 1 : -1;
  
  if (lastSide === 1 && currentSide === -1 && !isInside) {
    isInside = true;
  } else if (lastSide === -1 && currentSide === 1 && isInside) {
    isInside = false;
  }
  lastSide = currentSide;
  
  const target = isInside ? 1 : 0;
  const speed = 1.8;
  transitionValue += (target - transitionValue) * delta * speed;
  transitionValue = Math.max(0, Math.min(1, transitionValue));
  
  const t = transitionValue;
  const smooth = t * t * t * (t * (t * 6 - 15) + 10);
  
  // 门内世界
  if (skySphere) skySphere.material.opacity = smooth;
  if (galaxyModel) {
    galaxyModel.traverse((child) => {
      if (child.isMesh) child.material.opacity = smooth;
    });
  }
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  
  // 天体
  if (moonMesh) moonMesh.material.opacity = smooth;
  if (earthMesh) earthMesh.material.opacity = smooth;
  
  // 预览
  const previewOp = 1 - smooth;
  if (previewSphere) previewSphere.material.opacity = previewOp;
  if (previewStars) previewStars.material.opacity = previewOp;
  if (fogPortal) {
    fogPortal.children.forEach(child => {
      if (child.material) child.material.opacity = previewOp * 0.6;
    });
  }
  if (ambientStars) ambientStars.material.opacity = previewOp * 0.8;
  
  if (portalMask) portalMask.visible = smooth < 0.99;
  
  return smooth;
}

// ============ 更新天体位置 ============
function updateCelestialBodies(time, delta) {
  const doorForward = new THREE.Vector3(0, 0, -1);
  const doorRight = new THREE.Vector3(1, 0, 0);
  if (doorGroup) {
    doorForward.applyQuaternion(doorGroup.quaternion);
    doorRight.applyQuaternion(doorGroup.quaternion);
  }
  
  // 月球 - 门后深处左侧 (走进门后约10米处)
  if (moonMesh) {
    const moonPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, -15)  // 门后15米
      .addScaledVector(doorRight, -8);    // 左侧8米
    moonPos.y = doorPlanePoint.y + 3;
    moonMesh.position.copy(moonPos);
    moonMesh.rotation.y += delta * 0.05;
  }
  
  // 地球 - 门后深处右侧
  if (earthMesh) {
    const earthPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, -20)  // 门后20米
      .addScaledVector(doorRight, 10);    // 右侧10米
    earthPos.y = doorPlanePoint.y + 1;
    earthMesh.position.copy(earthPos);
    earthMesh.rotation.y += delta * 0.08;
  }
  
  // 彩蛋位置相对于门
  easterEggs.forEach((egg, index) => {
    const basePos = egg.userData.basePos;
    const worldPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, basePos.z)
      .addScaledVector(doorRight, basePos.x);
    worldPos.y = doorPlanePoint.y + basePos.y;
    egg.position.copy(worldPos);
    egg.position.y += Math.sin(time * 0.3 + index) * 0.2;
  });
  
  // 天球跟随相机
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  if (skySphere) skySphere.position.copy(_camPos);
  if (galaxyModel) galaxyModel.position.copy(_camPos);
  if (skyStars) skyStars.position.copy(_camPos);
  if (floatingStars) floatingStars.position.copy(_camPos);
  if (brightStars) brightStars.position.copy(_camPos);
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
    const smooth = updateTransition(xrCam, delta);
    updateMeteors(delta);
    updateCelestialBodies(time, delta);
    updatePortalGlow(portalGlow, time);
    if (fogPortal) updateFogPortal(fogPortal, time);
    updateEasterEggs(easterEggs, time, _camPos, smooth);
    
    updateStars(starData, time);
    if (previewStarData) updateStars(previewStarData, time);
    updateStars(ambientStarData, time);
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
  if (galaxyModel) { scene.remove(galaxyModel); galaxyModel = null; }
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  if (floatingStars) { scene.remove(floatingStars); floatingStars = null; }
  if (brightStars) { scene.remove(brightStars); brightStars = null; }
  if (moonMesh) { scene.remove(moonMesh); moonMesh = null; }
  if (earthMesh) { scene.remove(earthMesh); earthMesh = null; }
  easterEggs.forEach(egg => scene.remove(egg));
  easterEggs = [];
  
  previewSphere = null;
  previewStars = null;
  fogPortal = null;
  portalGlow = null;
  ambientStars = null;
  portalMask = null;
  starData = null;
  floatingStarData = null;
  brightStarData = null;
  previewStarData = null;
  ambientStarData = null;
  
  reticle.visible = false;
}
