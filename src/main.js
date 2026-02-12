import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 版本切换 ============
let USE_GLB_GALAXY = true;

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

let bgAudio = null;
let audioStarted = false;
let transitionValue = 0;

let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let doorForward = new THREE.Vector3();
let doorRight = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

let starData = null;
let floatingStarData = null;
let brightStarData = null;
let ambientStarData = null;

// 流星
let meteors = [];
let touchPoints = [];
let isTouching = false;

let starTexture = null;
let nebulaTexture = null;

// ===== 调试 =====
let debugDiv = null;
let touchCount = 0;

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

  // 调试面板
  debugDiv = document.createElement("div");
  debugDiv.style.cssText = "position:fixed;bottom:60px;left:10px;right:10px;z-index:9999;padding:10px;background:rgba(0,0,0,0.85);color:#0f0;border-radius:8px;font:12px monospace;white-space:pre-wrap;";
  debugDiv.textContent = "等待初始化...";
  document.body.appendChild(debugDiv);

  // 版本切换
  const select = document.createElement("select");
  select.style.cssText = "position:fixed;top:10px;right:10px;z-index:9999;padding:6px;";
  select.innerHTML = `<option value="glb">GLB</option><option value="pano">Pano</option>`;
  select.onchange = (e) => { USE_GLB_GALAXY = e.target.value === "glb"; reset(); };
  document.body.appendChild(select);

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

// ============ 触摸事件 ============
function initTouchEvents() {
  // 方案1: Canvas 事件
  const canvas = renderer.domElement;
  
  canvas.addEventListener("touchstart", (e) => {
    touchCount++;
    log(`touchstart #${touchCount} | placed:${placed}`);
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
    log(`touchend | isTouching:${isTouching} | isInside:${isInside} | pts:${touchPoints.length}`);
    if (!isTouching) return;
    isTouching = false;
    
    if (isInside && touchPoints.length >= 3) {
      log(">>> 触发 spawnMeteor!");
      spawnMeteor();
    } else {
      log(`未触发: isInside=${isInside}, pts=${touchPoints.length}`);
    }
    touchPoints = [];
  }, { passive: true });

  // 方案2: Window 事件（备用）
  window.addEventListener("touchstart", (e) => {
    if (e.target !== canvas) return;
    // 已经在canvas事件中处理
  }, { passive: true });

  log("触摸事件已初始化");
}

function log(msg) {
  console.log(msg);
  if (debugDiv) {
    const lines = debugDiv.textContent.split("\n");
    lines.push(msg);
    if (lines.length > 8) lines.shift();
    debugDiv.textContent = lines.join("\n");
  }
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

// ============ 流星 ============
// ============ 流星系统 ============
function spawnMeteor() {
  if (touchPoints.length < 3) return;
  
  const start = touchPoints[0];
  const end = touchPoints[touchPoints.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  
  if (len < 30) return;
  
  // 计算用户滑动的曲率（通过中间点偏离直线的程度）
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
  
  // 飞行方向：跟随用户滑动
  const flyDir = new THREE.Vector3()
    .addScaledVector(camRight, ndx * 0.85)
    .addScaledVector(camUp, -ndy * 0.75)
    .addScaledVector(camForward, 0.4)
    .normalize();
  
  // 起点：在滑动方向的反向（让流星从"来的方向"飞来）
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(6 + Math.random() * 4))
    .add(camRight.clone().multiplyScalar(-ndx * 4 + (Math.random() - 0.5) * 2))
    .add(camUp.clone().multiplyScalar(ndy * 3 + 2 + Math.random() * 2));
  
  const meteor = createArcMeteor(spawnPos, flyDir, userCurvature, xrCam);
  scene.add(meteor);
  meteors.push(meteor);
}

function createArcMeteor(startPos, baseDir, userCurvature, xrCam) {
  const group = new THREE.Group();
  group.renderOrder = 200;
  
  const arcLength = 20 + Math.random() * 15;
  const arcBend = userCurvature + (Math.random() - 0.5) * 3;
  const gravity = -0.35 - Math.random() * 0.25;
  
  let perpendicular = new THREE.Vector3().crossVectors(baseDir, new THREE.Vector3(0, 1, 0));
  if (perpendicular.length() < 0.1) {
    perpendicular.crossVectors(baseDir, new THREE.Vector3(1, 0, 0));
  }
  perpendicular.normalize();
  
  const p0 = startPos.clone();
  const p1 = startPos.clone()
    .addScaledVector(baseDir, arcLength * 0.3)
    .addScaledVector(perpendicular, arcBend * 1.2)
    .add(new THREE.Vector3(0, gravity * arcLength * 0.1, 0));
  const p2 = startPos.clone()
    .addScaledVector(baseDir, arcLength * 0.65)
    .addScaledVector(perpendicular, arcBend * 0.6)
    .add(new THREE.Vector3(0, gravity * arcLength * 0.35, 0));
  const p3 = startPos.clone()
    .addScaledVector(baseDir, arcLength)
    .add(new THREE.Vector3(0, gravity * arcLength * 0.75, 0));
  
  const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
  
  // 流星核心
  const coreMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const coreSprite = new THREE.Sprite(coreMat);
  coreSprite.scale.set(1.0, 0.4, 1);
  coreSprite.renderOrder = 202;
  group.add(coreSprite);
  
  // 内核亮点
  const innerMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const innerSprite = new THREE.Sprite(innerMat);
  innerSprite.scale.set(0.5, 0.5, 1);
  innerSprite.renderOrder = 203;
  group.add(innerSprite);
  
  // 外层光晕
  const glowMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffffee,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const glowSprite = new THREE.Sprite(glowMat);
  glowSprite.scale.set(1.5, 0.6, 1);
  glowSprite.renderOrder = 201;
  group.add(glowSprite);
  
  // ===== 拖尾粒子 =====
  const trailCount = 50;
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
  
  // 关键：使用 NormalBlending + 高亮度 代替 AdditiveBlending
  const trailMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.28,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: true,
  });
  
  const trail = new THREE.Points(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.renderOrder = 200;
  scene.add(trail);
  
  group.userData = {
    curve,
    progress: 0,
    speed: 0.10 + Math.random() * 0.04,
    life: 0,
    maxLife: 4.5 + Math.random() * 2,
    coreMat,
    innerMat,
    glowMat,
    trailMat,
    trailGeo,
    trailPositions,
    trailColors,
    trail,
    history: [],
    coreSprite,
    innerSprite,
    glowSprite,
    trailCount,
  };
  
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
    
    // 拖尾历史
    d.history.unshift(pos.clone());
    if (d.history.length > d.trailCount) d.history.pop();
    
    // 更新拖尾位置和颜色
    const historyLen = d.history.length;
    for (let j = 0; j < d.trailCount; j++) {
      if (j < historyLen) {
        const hp = d.history[j];
        d.trailPositions[j * 3] = hp.x;
        d.trailPositions[j * 3 + 1] = hp.y;
        d.trailPositions[j * 3 + 2] = hp.z;
        
        const fadeProgress = j / d.trailCount;
        const fade = Math.pow(1 - fadeProgress, 1.0);  // 更缓慢的衰减
        
        // 更亮的颜色
        d.trailColors[j * 3] = fade;
        d.trailColors[j * 3 + 1] = (1 - fadeProgress * 0.3) * fade;
        d.trailColors[j * 3 + 2] = (1 - fadeProgress * 0.65) * fade;
      } else {
        // 未使用的点移到远处并设为透明
        d.trailPositions[j * 3] = pos.x;
        d.trailPositions[j * 3 + 1] = pos.y;
        d.trailPositions[j * 3 + 2] = pos.z;
        d.trailColors[j * 3] = 0;
        d.trailColors[j * 3 + 1] = 0;
        d.trailColors[j * 3 + 2] = 0;
      }
    }
    
    d.trailGeo.attributes.position.needsUpdate = true;
    d.trailGeo.attributes.color.needsUpdate = true;
    
    const lifeRatio = d.life / d.maxLife;
    let opacity;
    if (lifeRatio < 0.08) {
      opacity = lifeRatio / 0.08;
    } else {
      opacity = Math.pow(1 - (lifeRatio - 0.08) / 0.92, 0.6);
    }
    
    d.coreMat.opacity = opacity;
    d.innerMat.opacity = opacity;
    d.glowMat.opacity = opacity * 0.4;
    d.trailMat.opacity = opacity;
    
    if (d.life >= d.maxLife || d.progress >= 1) {
      scene.remove(m);
      scene.remove(d.trail);
      meteors.splice(i, 1);
    }
  }
}

// ============ 星星 ============
function createStars(count, radius, baseSize) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  const starColors = [[1,1,1],[0.95,0.97,1],[0.85,0.92,1],[0.75,0.85,1],[1,0.97,0.9],[1,0.93,0.7]];
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.75 + 0.25 * Math.random());
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    const c = starColors[Math.floor(Math.random() * starColors.length)];
    colors[i*3] = c[0]; colors[i*3+1] = c[1]; colors[i*3+2] = c[2];
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.5 + Math.random() * 2;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starTexture, size: baseSize, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
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
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    colors[i*3] = colors[i*3+1] = colors[i*3+2] = 1;
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.3 + Math.random() * 1.5;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starTexture, size: baseSize, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 2);
  const bc = [[1,1,1],[0.8,0.9,1],[1,0.95,0.7]];
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    const c = bc[Math.floor(Math.random() * bc.length)];
    colors[i*3] = c[0]; colors[i*3+1] = c[1]; colors[i*3+2] = c[2];
    phases[i*2] = Math.random() * Math.PI * 2;
    phases[i*2+1] = 0.2 + Math.random() * 0.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starTexture, size: 0.8, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

function createAmbientStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    positions[i*3] = (Math.random() - 0.5) * 5;
    positions[i*3+1] = 0.3 + Math.random() * 2.5;
    positions[i*3+2] = -0.5 - Math.random() * 3;
    const b = 0.7 + Math.random() * 0.3;
    colors[i*3] = colors[i*3+1] = colors[i*3+2] = b;
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.5 + Math.random() * 2;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starTexture, size: 0.06, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

function updateStars(data, time) {
  if (!data) return;
  const { points, colors, phases } = data;
  const col = points.geometry.attributes.color.array;
  const count = colors.length / 3;
  for (let i = 0; i < count; i++) {
    const twinkle = 0.65 + 0.35 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = colors[i*3] * twinkle;
    col[i*3+1] = colors[i*3+1] * twinkle;
    col[i*3+2] = colors[i*3+2] * twinkle;
  }
  points.geometry.attributes.color.needsUpdate = true;
}

function updateFloatingStars(data, time) {
  if (!data) return;
  const { points, positions, phases } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const twinkle = 0.5 + 0.5 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = col[i*3+1] = col[i*3+2] = twinkle;
    const drift = 0.3;
    pos[i*3] = positions[i*3] + Math.sin(time * 0.1 + phases[i*4+2]) * drift;
    pos[i*3+1] = positions[i*3+1] + Math.sin(time * 0.08 + phases[i*4]) * drift * 0.3;
    pos[i*3+2] = positions[i*3+2] + Math.cos(time * 0.12 + phases[i*4+3]) * drift;
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
    const pulse = 0.6 + 0.4 * Math.sin(time * phases[i*2+1] + phases[i*2]);
    col[i*3] = colors[i*3] * pulse;
    col[i*3+1] = colors[i*3+1] * pulse;
    col[i*3+2] = colors[i*3+2] * pulse;
  }
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 构建 ============
function createNebulaPortal() {
  const group = new THREE.Group();
  const nebulaMat = new THREE.MeshBasicMaterial({ map: nebulaTexture, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  nebulaMat.stencilWrite = true;
  nebulaMat.stencilRef = 1;
  nebulaMat.stencilFunc = THREE.EqualStencilFunc;
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
    { text: "Dream", relPos: { forward: 30, right: 20, up: -3 } },
    { text: "✦", relPos: { forward: 35, right: 0, up: 12 } },
  ];
  eggData.forEach((egg) => {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.font = "24px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
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
  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMask = new THREE.Mesh(new THREE.ShapeGeometry(maskShape, 32), maskMat);
  portalMask.position.set(0, 0.01, -0.03);
  portalMask.renderOrder = 0;
  doorGroup.add(portalMask);

  nebulaPortal = createNebulaPortal();
  doorGroup.add(nebulaPortal);

  ambientStarData = createAmbientStars(200);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

  if (USE_GLB_GALAXY) {
  gltfLoader.load(`${BASE}models/galaxy.glb`, (gltf) => {
    galaxyModel = gltf.scene;
    galaxyModel.scale.setScalar(SKY_RADIUS * 0.5);
    galaxyModel.traverse((child) => {
      if (child.isMesh) {
        child.material.transparent = true;
        child.material.opacity = 0;
        child.material.depthWrite = false;
        child.material.depthTest = true;  // 新增
        child.renderOrder = 1;            // 新增：确保每个mesh都有低renderOrder
      }
    });
    galaxyModel.renderOrder = 1;
    scene.add(galaxyModel);
  }, undefined, () => { createPanoSphere(panoTexture); });
}

  starData = createStars(4000, SKY_RADIUS * 0.95, 0.22);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  floatingStarData = createFloatingStars(800, SKY_RADIUS * 0.1, SKY_RADIUS * 0.4, 0.2);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  brightStarData = createBrightStars(30, SKY_RADIUS * 0.9);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = 4;
  scene.add(brightStars);

  const moonGeo = new THREE.SphereGeometry(4, 64, 64);
  moonMesh = new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0 }));
  moonMesh.renderOrder = 10;
  scene.add(moonMesh);

  const earthGeo = new THREE.SphereGeometry(6, 64, 64);
  earthMesh = new THREE.Mesh(earthGeo, new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0 }));
  earthMesh.renderOrder = 10;
  scene.add(earthMesh);

  texLoader.load(`${BASE}textures/moon.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; moonMesh.material.map = tex; moonMesh.material.color.set(0xffffff); moonMesh.material.needsUpdate = true; });
  texLoader.load(`${BASE}textures/earth.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; earthMesh.material.map = tex; earthMesh.material.color.set(0xffffff); earthMesh.material.needsUpdate = true; });

  easterEggs = createEasterEggs();
  easterEggs.forEach(egg => scene.add(egg));
}

function createPanoSphere(panoTexture) {
  skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 64, 32),
    new THREE.MeshBasicMaterial({ map: panoTexture, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false })
  );
  skySphere.rotation.y = Math.PI;
  skySphere.renderOrder = 1;
  scene.add(skySphere);
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

  lastSide = getSide(xrCam);
  isInside = false;
  transitionValue = 0;
  placed = true;
  reticle.visible = false;

  log("门已放置，请走进门内");
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
  
  const wasInside = isInside;
  if (lastSide === 1 && currentSide === -1 && !isInside) isInside = true;
  else if (lastSide === -1 && currentSide === 1 && isInside) isInside = false;
  lastSide = currentSide;
  
  if (isInside !== wasInside) {
    log(isInside ? ">>> 已进入门内！可以滑动生成流星" : "已离开门内");
  }
  
  const target = isInside ? 1 : 0;
  transitionValue += (target - transitionValue) * delta * 1.8;
  transitionValue = Math.max(0, Math.min(1, transitionValue));
  
  const t = transitionValue;
  const smooth = t * t * t * (t * (t * 6 - 15) + 10);
  
  if (skySphere) skySphere.material.opacity = smooth;
  if (galaxyModel) galaxyModel.traverse((c) => { if (c.isMesh) c.material.opacity = smooth; });
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  if (moonMesh) moonMesh.material.opacity = smooth;
  if (earthMesh) earthMesh.material.opacity = smooth;
  easterEggs.forEach(egg => { egg.userData.spriteMat.opacity = smooth * 0.3; });
  
  const previewOp = 1 - smooth;
  if (nebulaPortal) nebulaPortal.userData.nebulaMat.opacity = previewOp * 0.5;
  if (ambientStars) ambientStars.material.opacity = previewOp * 0.8;
  if (portalMask) portalMask.visible = smooth < 0.99;
}

function updateCelestialBodies(time, delta) {
  if (moonMesh) {
    const moonPos = doorPlanePoint.clone().addScaledVector(doorForward, 18).addScaledVector(doorRight, -12);
    moonPos.y = doorPlanePoint.y + 4;
    moonMesh.position.copy(moonPos);
    moonMesh.rotation.y += delta * 0.05;
  }
  if (earthMesh) {
    const earthPos = doorPlanePoint.clone().addScaledVector(doorForward, 28).addScaledVector(doorRight, 15);
    earthPos.y = doorPlanePoint.y + 2;
    earthMesh.position.copy(earthPos);
    earthMesh.rotation.y += delta * 0.08;
  }
  easterEggs.forEach((egg) => {
    const rel = egg.userData.relPos;
    const eggPos = doorPlanePoint.clone().addScaledVector(doorForward, rel.forward).addScaledVector(doorRight, rel.right);
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
    updateStars(starData, time);
    updateStars(ambientStarData, time);
    updateFloatingStars(floatingStarData, time);
    updateBrightStars(brightStarData, time);
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false; isInside = false; transitionValue = 0;
  if (bgAudio) { bgAudio.pause(); bgAudio.currentTime = 0; audioStarted = false; }
  meteors.forEach(m => { scene.remove(m); if (m.userData.trail) scene.remove(m.userData.trail); });
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
  nebulaPortal = null; ambientStars = null; portalMask = null;
  starData = null; floatingStarData = null; brightStarData = null; ambientStarData = null;
  reticle.visible = false;
  log("已重置");
}
