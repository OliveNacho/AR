import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 版本切换 ============
const USE_GLB_GALAXY = true;

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
let galaxyModel = null;
let skyStars = null;
let floatingStars = null;
let brightStars = null;
let moonMesh = null;
let earthMesh = null;
let easterEggs = [];
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
let doorForward = new THREE.Vector3();
let doorRight = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

// 星星数据
let starData = null;
let floatingStarData = null;
let brightStarData = null;
let ambientStarData = null;

// 流星系统
let meteors = [];
let touchPoints = [];
let isTouching = false;
let swipeHistory = [];
let lastSwipeTime = 0;
let lastSwipeDir = null;

// 纹理
let starTexture = null;
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
  modeLabel.textContent = USE_GLB_GALAXY ? "GLB" : "Pano";
  modeLabel.style.cssText = "position:fixed;top:10px;right:10px;z-index:9999;padding:4px 8px;background:rgba(0,100,200,0.5);color:#fff;border-radius:4px;font-size:10px;";
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

// ============ 触摸事件 - 流星触发 ============
function initTouchEvents() {
  const canvas = renderer.domElement;
  
  canvas.addEventListener("touchstart", (e) => {
    if (!placed || !isInside) return;
    isTouching = true;
    touchPoints = [];
    for (let i = 0; i < e.touches.length; i++) {
      touchPoints.push({ 
        x: e.touches[i].clientX, 
        y: e.touches[i].clientY,
        time: performance.now()
      });
    }
  }, { passive: true });
  
  canvas.addEventListener("touchmove", (e) => {
    if (!isTouching || !isInside) return;
    for (let i = 0; i < e.touches.length; i++) {
      touchPoints.push({ 
        x: e.touches[i].clientX, 
        y: e.touches[i].clientY,
        time: performance.now()
      });
    }
    if (touchPoints.length > 50) {
      touchPoints = touchPoints.slice(-50);
    }
  }, { passive: true });
  
  canvas.addEventListener("touchend", () => {
    if (!isTouching) return;
    isTouching = false;
    
    if (!isInside || touchPoints.length < 5) {
      touchPoints = [];
      return;
    }
    
    const start = touchPoints[0];
    const end = touchPoints[touchPoints.length - 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len < 40) {
      touchPoints = [];
      return;
    }
    
    const now = performance.now();
    const swipeDir = { dx: dx / len, dy: dy / len };
    
    if (now - lastSwipeTime < 1500 && lastSwipeDir) {
      const dot = swipeDir.dx * lastSwipeDir.dx + swipeDir.dy * lastSwipeDir.dy;
      if (dot > 0.7) {
        swipeHistory.push({ dx, dy, len, points: [...touchPoints] });
      } else {
        swipeHistory = [{ dx, dy, len, points: [...touchPoints] }];
      }
    } else {
      swipeHistory = [{ dx, dy, len, points: [...touchPoints] }];
    }
    
    lastSwipeTime = now;
    lastSwipeDir = swipeDir;
    
    if (swipeHistory.length >= 3) {
      spawnMeteorShower(swipeDir);
      swipeHistory = [];
    } else {
      spawnSingleMeteor(swipeDir);
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

// ============ 纹理 ============
function createStarTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  
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

// ============ 流星生成 ============
function spawnSingleMeteor(swipeDir) {
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  const flyDir = new THREE.Vector3()
    .addScaledVector(camRight, swipeDir.dx * 0.8)
    .addScaledVector(camUp, -swipeDir.dy * 0.8)
    .addScaledVector(camForward, 0.3)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(12 + Math.random() * 8))
    .add(camUp.clone().multiplyScalar(4 + Math.random() * 5))
    .add(camRight.clone().multiplyScalar((Math.random() - 0.5) * 8));
  
  const meteor = createBeautifulMeteor(spawnPos, flyDir);
  scene.add(meteor);
  meteors.push(meteor);
}

function spawnMeteorShower(swipeDir) {
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  const count = 5 + Math.floor(Math.random() * 4);
  
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      if (!placed) return;
      
      const randAngle = (Math.random() - 0.5) * 0.3;
      const cos = Math.cos(randAngle);
      const sin = Math.sin(randAngle);
      const rdx = swipeDir.dx * cos - swipeDir.dy * sin;
      const rdy = swipeDir.dx * sin + swipeDir.dy * cos;
      
      const flyDir = new THREE.Vector3()
        .addScaledVector(camRight, rdx * 0.8)
        .addScaledVector(camUp, -rdy * 0.8)
        .addScaledVector(camForward, 0.25 + Math.random() * 0.15)
        .normalize();
      
      const spawnPos = _camPos.clone()
        .add(camForward.clone().multiplyScalar(10 + Math.random() * 12))
        .add(camUp.clone().multiplyScalar(3 + Math.random() * 8))
        .add(camRight.clone().multiplyScalar((Math.random() - 0.5) * 12));
      
      const meteor = createBeautifulMeteor(spawnPos, flyDir);
      scene.add(meteor);
      meteors.push(meteor);
    }, i * 150 + Math.random() * 100);
  }
}

function createBeautifulMeteor(startPos, baseDir) {
  const group = new THREE.Group();
  
  const arcLength = 12 + Math.random() * 8;
  const arcBend = (Math.random() - 0.5) * 2;
  const gravity = -0.3 - Math.random() * 0.3;
  
  const perpendicular = new THREE.Vector3()
    .crossVectors(baseDir, new THREE.Vector3(0, 1, 0))
    .normalize();
  if (perpendicular.length() < 0.1) {
    perpendicular.set(1, 0, 0);
  }
  
  const p0 = startPos.clone();
  const p1 = startPos.clone()
    .addScaledVector(baseDir, arcLength * 0.33)
    .addScaledVector(perpendicular, arcBend)
    .add(new THREE.Vector3(0, gravity * arcLength * 0.25, 0));
  const p2 = startPos.clone()
    .addScaledVector(baseDir, arcLength * 0.66)
    .addScaledVector(perpendicular, arcBend * 0.5)
    .add(new THREE.Vector3(0, gravity * arcLength * 0.6, 0));
  const p3 = startPos.clone()
    .addScaledVector(baseDir, arcLength)
    .add(new THREE.Vector3(0, gravity * arcLength * 1.1, 0));
  
  const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
  
  // 流星核心
  const coreMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const coreSprite = new THREE.Sprite(coreMat);
  coreSprite.scale.set(0.5, 0.18, 1);
  group.add(coreSprite);
  
  // 中层光晕
  const midGlowMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xfffef0,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const midGlow = new THREE.Sprite(midGlowMat);
  midGlow.scale.set(0.7, 0.28, 1);
  group.add(midGlow);
  
  // 外层光晕
  const outerGlowMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffeedd,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const outerGlow = new THREE.Sprite(outerGlowMat);
  outerGlow.scale.set(1.0, 0.4, 1);
  group.add(outerGlow);
  
  // 拖尾粒子
  const trailCount = 30;
  const trailPositions = new Float32Array(trailCount * 3);
  const trailColors = new Float32Array(trailCount * 3);
  
  for (let i = 0; i < trailCount; i++) {
    trailPositions[i * 3] = startPos.x;
    trailPositions[i * 3 + 1] = startPos.y;
    trailPositions[i * 3 + 2] = startPos.z;
    trailColors[i * 3] = 1;
    trailColors[i * 3 + 1] = 1;
    trailColors[i * 3 + 2] = 1;
  }
  
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
  
  const trailMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.12,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const trail = new THREE.Points(trailGeo, trailMat);
  trail.frustumCulled = false;
  scene.add(trail);
  
  group.userData = {
    curve,
    progress: 0,
    speed: 0.055 + Math.random() * 0.02,
    life: 0,
    maxLife: 6 + Math.random() * 2,
    coreMat,
    midGlowMat,
    outerGlowMat,
    trailMat,
    trailGeo,
    trailPositions,
    trailColors,
    trail,
    history: [],
    coreSprite,
    midGlow,
    outerGlow,
  };
  
  return group;
}

function updateMeteors(delta) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    const d = m.userData;
    
    d.life += delta;
    d.progress += d.speed * delta;
    
    const t = Math.min(d.progress, 1);
    const pos = d.curve.getPoint(t);
    
    m.position.copy(pos);
    
    const tangent = d.curve.getTangent(t);
    const angle = Math.atan2(tangent.y, Math.sqrt(tangent.x * tangent.x + tangent.z * tangent.z));
    d.coreSprite.material.rotation = -angle;
    d.midGlow.material.rotation = -angle;
    d.outerGlow.material.rotation = -angle;
    
    d.history.unshift(pos.clone());
    if (d.history.length > 30) d.history.pop();
    
    const historyLen = d.history.length;
    for (let j = 0; j < 30; j++) {
      if (j < historyLen) {
        const hp = d.history[j];
        d.trailPositions[j * 3] = hp.x;
        d.trailPositions[j * 3 + 1] = hp.y;
        d.trailPositions[j * 3 + 2] = hp.z;
        
        const fade = Math.pow(1 - j / 30, 1.8);
        const ct = j / 30;
        
        let r = 1;
        let g = 1 - ct * 0.25;
        let b = 1 - ct * 0.6;
        
        d.trailColors[j * 3] = r * fade;
        d.trailColors[j * 3 + 1] = g * fade;
        d.trailColors[j * 3 + 2] = b * fade;
      } else {
        d.trailColors[j * 3] = 0;
        d.trailColors[j * 3 + 1] = 0;
        d.trailColors[j * 3 + 2] = 0;
      }
    }
    
    d.trailGeo.attributes.position.needsUpdate = true;
    d.trailGeo.attributes.color.needsUpdate = true;
    
    const lifeProgress = d.life / d.maxLife;
    let fade;
    if (lifeProgress < 0.1) {
      fade = lifeProgress / 0.1;
    } else {
      fade = Math.pow(1 - (lifeProgress - 0.1) / 0.9, 0.6);
    }
    
    d.coreMat.opacity = fade;
    d.midGlowMat.opacity = fade * 0.7;
    d.outerGlowMat.opacity = fade * 0.4;
    d.trailMat.opacity = fade;
    
    if (d.life >= d.maxLife || d.progress >= 1) {
      scene.remove(m);
      scene.remove(d.trail);
      meteors.splice(i, 1);
    }
  }
}

// ============ 创建星星 ============
function createStars(count, radius, baseSize) {
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
    map: starTexture,
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
  
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

function createAmbientStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 12;
    positions[i * 3 + 1] = 0.2 + Math.random() * 4;
    positions[i * 3 + 2] = -1 - Math.random() * 6;
    
    const b = 0.6 + Math.random() * 0.4;
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
    size: 0.08,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
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
    
    const twinkle = 0.6 + 0.4 * Math.sin(time * speed + p1);
    col[i * 3] = colors[i * 3] * twinkle;
    col[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    col[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    const drift = 0.15;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.15 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.12 + p1) * drift * 0.5;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.sin(time * 0.1 + p3) * drift;
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
    
    const drift = 0.4;
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
    const pulse = 0.5 + 0.5 * Math.sin(time * speed + phase);
    col[i * 3] = colors[i * 3] * pulse;
    col[i * 3 + 1] = colors[i * 3 + 1] * pulse;
    col[i * 3 + 2] = colors[i * 3 + 2] * pulse;
  }
  
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 薄雾门 ============
function createNebulaPortal() {
  const group = new THREE.Group();
  
  const nebulaMat = new THREE.MeshBasicMaterial({
    map: nebulaTexture,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  nebulaMat.stencilWrite = true;
  nebulaMat.stencilRef = 1;
  nebulaMat.stencilFunc = THREE.EqualStencilFunc;
  
  const nebulaGeo = new THREE.PlaneGeometry(1.0, 1.85);
  const nebulaMesh = new THREE.Mesh(nebulaGeo, nebulaMat);
  nebulaMesh.position.set(0, 0.95, -0.02);
  nebulaMesh.renderOrder = 1;
  group.add(nebulaMesh);
  
  group.userData = { nebulaMat };
  
  return group;
}

// ============ 彩蛋 ============
function createEasterEggs() {
  const eggs = [];
  
  const eggData = [
    { text: "Ad Astra", relPos: { forward: 40, right: 10, up: 5 }, fontSize: 32, color: "rgba(200,200,220,0.25)", scale: 2.0 },
    { text: "Dream", relPos: { forward: 5, right: 0, up: 4 }, fontSize: 28, color: "rgba(180,180,200,0.2)", scale: 1.5 },
    { text: "✦", relPos: { forward: 18, right: -12, up: -0.5 }, fontSize: 24, color: "rgba(220,220,240,0.3)", scale: 1.0 },
  ];
  
  eggData.forEach((egg) => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = `${egg.fontSize}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = egg.color;
    ctx.fillText(egg.text, 128, 32);
    
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(egg.scale, egg.scale * 0.25, 1);
    
    sprite.userData = {
      relPos: egg.relPos,
      spriteMat,
      targetOpacity: 1,
    };
    
    eggs.push(sprite);
  });
  
  return eggs;
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

  // 薄雾门
  nebulaPortal = createNebulaPortal();
  doorGroup.add(nebulaPortal);

  // 门外星星
  ambientStarData = createAmbientStars(400);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

  // 门内世界
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
    }, undefined, () => {
      createPanoSphere(panoTexture);
    });
  } else {
    createPanoSphere(panoTexture);
  }

  // 门内星星
  starData = createStars(5000, SKY_RADIUS * 0.95, 0.25);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  floatingStarData = createFloatingStars(1200, SKY_RADIUS * 0.1, SKY_RADIUS * 0.5, 0.22);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  brightStarData = createBrightStars(50, SKY_RADIUS * 0.9);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = 4;
  scene.add(brightStars);

  // 天体
  const moonGeo = new THREE.SphereGeometry(4, 64, 64);
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0 });
  moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonMesh.renderOrder = 10;
  scene.add(moonMesh);

  const earthGeo = new THREE.SphereGeometry(6, 64, 64);
  const earthMat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0 });
  earthMesh = new THREE.Mesh(earthGeo, earthMat);
  earthMesh.renderOrder = 10;
  scene.add(earthMesh);

  texLoader.load(`${BASE}textures/moon.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    moonMesh.material.map = tex;
    moonMesh.material.color.set(0xffffff);
    moonMesh.material.needsUpdate = true;
  });

  texLoader.load(`${BASE}textures/earth.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    earthMesh.material.map = tex;
    earthMesh.material.color.set(0xffffff);
    earthMesh.material.needsUpdate = true;
  });

  // 彩蛋
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

  doorPlanePoint.copy(doorGroup.position);
  doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);
  
  doorForward.set(0, 0, -1).applyQuaternion(doorGroup.quaternion);
  doorRight.set(1, 0, 0).applyQuaternion(doorGroup.quaternion);

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
  
  if (skySphere) skySphere.material.opacity = smooth;
  if (galaxyModel) {
    galaxyModel.traverse((child) => {
      if (child.isMesh) child.material.opacity = smooth;
    });
  }
  
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  
  if (moonMesh) moonMesh.material.opacity = smooth;
  if (earthMesh) earthMesh.material.opacity = smooth;
  
  easterEggs.forEach(egg => {
    egg.userData.spriteMat.opacity = smooth * egg.userData.targetOpacity;
  });
  
  if (nebulaPortal) {
    nebulaPortal.userData.nebulaMat.opacity = (1 - smooth) * 0.5;
  }
  if (ambientStars) ambientStars.material.opacity = (1 - smooth) * 0.9;
  
  if (portalMask) portalMask.visible = smooth < 0.99;
  
  return smooth;
}

// ============ 更新天体位置 ============
function updateCelestialBodies(time, delta) {
  if (moonMesh) {
    const moonPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, 18)
      .addScaledVector(doorRight, -12);
    moonPos.y = doorPlanePoint.y + 4;
    moonMesh.position.copy(moonPos);
    moonMesh.rotation.y += delta * 0.05;
  }
  
  if (earthMesh) {
    const earthPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, 28)
      .addScaledVector(doorRight, 15);
    earthPos.y = doorPlanePoint.y + 2;
    earthMesh.position.copy(earthPos);
    earthMesh.rotation.y += delta * 0.08;
  }
  
  easterEggs.forEach((egg) => {
    const rel = egg.userData.relPos;
    const eggPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, rel.forward)
      .addScaledVector(doorRight, rel.right);
    eggPos.y = doorPlanePoint.y + rel.up;
    egg.position.copy(eggPos);
  });
  
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
    updateTransition(xrCam, delta);
    updateMeteors(delta);
    updateCelestialBodies(time, delta);
    
    updateStars(starData, time);
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
  swipeHistory = [];
  lastSwipeTime = 0;
  lastSwipeDir = null;
  
  if (bgAudio) { bgAudio.pause(); bgAudio.currentTime = 0; audioStarted = false; }
  
  meteors.forEach(m => {
    scene.remove(m);
    if (m.userData.trail) scene.remove(m.userData.trail);
  });
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
  
  nebulaPortal = null;
  ambientStars = null;
  portalMask = null;
  starData = null;
  floatingStarData = null;
  brightStarData = null;
  ambientStarData = null;
  
  reticle.visible = false;
}
