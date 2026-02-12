import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
let USE_GLB_GALAXY = true;
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
let swipeHistory = [];
let lastSwipeTime = 0;
let lastSwipeDir = null;

// XR 滑动追踪
let selectStartTime = 0;
let selectStartPos = new THREE.Vector2();
let isSelecting = false;

let starTexture = null;
let nebulaTexture = null;

// 调试
let debugLabel = null;

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

  // 调试标签
  debugLabel = document.createElement("div");
  debugLabel.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;padding:6px 12px;background:rgba(0,0,0,0.8);color:#0f0;border-radius:8px;font-size:12px;font-family:monospace;";
  debugLabel.textContent = "等待...";
  document.body.appendChild(debugLabel);

  // 版本切换
  const select = document.createElement("select");
  select.style.cssText = "position:fixed;top:10px;right:10px;z-index:9999;padding:6px;font-size:12px;border-radius:4px;";
  select.innerHTML = `<option value="glb" selected>GLB</option><option value="pano">Pano</option>`;
  select.onchange = (e) => { USE_GLB_GALAXY = e.target.value === "glb"; reset(); };
  document.body.appendChild(select);

  // Reset 按钮
  const btn = document.createElement("button");
  btn.textContent = "Reset";
  btn.style.cssText = "position:fixed;top:10px;left:10px;z-index:9999;padding:6px 12px;background:#333;color:#fff;border:none;border-radius:4px;";
  btn.onclick = reset;
  document.body.appendChild(btn);

  // XR Controller 事件 - 这是关键！
  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  controller.addEventListener("selectstart", onSelectStart);
  controller.addEventListener("selectend", onSelectEnd);
  scene.add(controller);

  initAudio();

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

// ============ XR Controller 滑动检测 ============
function onSelectStart(event) {
  if (!placed) return;
  
  isSelecting = true;
  selectStartTime = performance.now();
  
  // 获取触摸位置（通过 inputSource）
  const session = renderer.xr.getSession();
  if (session && session.inputSources.length > 0) {
    const inputSource = session.inputSources[0];
    if (inputSource.gamepad && inputSource.gamepad.axes.length >= 2) {
      selectStartPos.set(inputSource.gamepad.axes[0], inputSource.gamepad.axes[1]);
    }
  }
  
  // 使用屏幕中心作为起点
  selectStartPos.set(innerWidth / 2, innerHeight / 2);
  
  debugLabel.textContent = `selectstart | inside:${isInside}`;
}

function onSelectEnd(event) {
  if (!placed || !isSelecting) return;
  isSelecting = false;
  
  const duration = performance.now() - selectStartTime;
  
  debugLabel.textContent = `selectend | dur:${Math.round(duration)}ms | inside:${isInside}`;
  
  // 如果点击时间短（<300ms），视为点击而非滑动
  // 如果时间长（>300ms），视为滑动
  if (duration > 200 && isInside) {
    // 生成随机方向的流星
    const angle = Math.random() * Math.PI * 2;
    const swipeDir = { 
      dx: Math.cos(angle), 
      dy: Math.sin(angle) 
    };
    
    const now = performance.now();
    
    if (now - lastSwipeTime < 1500 && lastSwipeDir) {
      swipeHistory.push(swipeDir);
    } else {
      swipeHistory = [swipeDir];
    }
    
    lastSwipeTime = now;
    lastSwipeDir = swipeDir;
    
    if (swipeHistory.length >= 3) {
      debugLabel.textContent = `🌠 流星雨！`;
      spawnMeteorShower(swipeDir);
      swipeHistory = [];
    } else {
      debugLabel.textContent = `✨ 流星 (${swipeHistory.length}/3)`;
      spawnSingleMeteor(swipeDir);
    }
  } else if (duration > 200 && !isInside) {
    debugLabel.textContent = `⚠️ 请先进门！inside:${isInside}`;
  }
}

function onSelect() {
  // 放置门
  if (!placed && reticle.visible) {
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

    debugLabel.textContent = "门已放置，请走进门内";
    playAudio();
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
function spawnSingleMeteor(swipeDir) {
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  const flyDir = new THREE.Vector3()
    .addScaledVector(camRight, swipeDir.dx * 0.7)
    .addScaledVector(camUp, -swipeDir.dy * 0.5 - 0.3)
    .addScaledVector(camForward, 0.4)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(10 + Math.random() * 8))
    .add(camUp.clone().multiplyScalar(4 + Math.random() * 4))
    .add(camRight.clone().multiplyScalar((Math.random() - 0.5) * 8));
  
  const meteor = createMeteor(spawnPos, flyDir);
  scene.add(meteor);
  meteors.push(meteor);
}

function spawnMeteorShower(swipeDir) {
  const count = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      if (!placed) return;
      const randAngle = (Math.random() - 0.5) * 0.4;
      const rdx = swipeDir.dx * Math.cos(randAngle) - swipeDir.dy * Math.sin(randAngle);
      const rdy = swipeDir.dx * Math.sin(randAngle) + swipeDir.dy * Math.cos(randAngle);
      spawnSingleMeteor({ dx: rdx, dy: rdy });
    }, i * 120);
  }
}

function createMeteor(startPos, baseDir) {
  const group = new THREE.Group();
  
  const arcLength = 12 + Math.random() * 6;
  const arcBend = (Math.random() - 0.5) * 1.5;
  const gravity = -0.35;
  
  let perp = new THREE.Vector3().crossVectors(baseDir, new THREE.Vector3(0, 1, 0));
  if (perp.length() < 0.1) perp.set(1, 0, 0);
  perp.normalize();
  
  const p0 = startPos.clone();
  const p1 = startPos.clone().addScaledVector(baseDir, arcLength * 0.33).addScaledVector(perp, arcBend).add(new THREE.Vector3(0, gravity * arcLength * 0.2, 0));
  const p2 = startPos.clone().addScaledVector(baseDir, arcLength * 0.66).addScaledVector(perp, arcBend * 0.5).add(new THREE.Vector3(0, gravity * arcLength * 0.5, 0));
  const p3 = startPos.clone().addScaledVector(baseDir, arcLength).add(new THREE.Vector3(0, gravity * arcLength, 0));
  
  const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
  
  // 核心
  const coreMat = new THREE.SpriteMaterial({ map: starTexture, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const core = new THREE.Sprite(coreMat);
  core.scale.set(0.5, 0.18, 1);
  group.add(core);
  
  // 光晕
  const glowMat = new THREE.SpriteMaterial({ map: starTexture, color: 0xffeedd, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(0.8, 0.35, 1);
  group.add(glow);
  
  // 拖尾
  const trailCount = 25;
  const trailPos = new Float32Array(trailCount * 3);
  const trailCol = new Float32Array(trailCount * 3);
  for (let i = 0; i < trailCount; i++) {
    trailPos[i * 3] = startPos.x;
    trailPos[i * 3 + 1] = startPos.y;
    trailPos[i * 3 + 2] = startPos.z;
    trailCol[i * 3] = trailCol[i * 3 + 1] = trailCol[i * 3 + 2] = 1;
  }
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
  const trailMat = new THREE.PointsMaterial({ map: starTexture, size: 0.1, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  const trail = new THREE.Points(trailGeo, trailMat);
  trail.frustumCulled = false;
  scene.add(trail);
  
  group.userData = { curve, progress: 0, speed: 0.06, life: 0, maxLife: 5, coreMat, glowMat, trailMat, trailGeo, trailPos, trailCol, trail, history: [], core, glow };
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
    d.core.material.rotation = -angle;
    d.glow.material.rotation = -angle;
    
    d.history.unshift(pos.clone());
    if (d.history.length > 25) d.history.pop();
    
    for (let j = 0; j < 25; j++) {
      if (j < d.history.length) {
        const hp = d.history[j];
        d.trailPos[j * 3] = hp.x;
        d.trailPos[j * 3 + 1] = hp.y;
        d.trailPos[j * 3 + 2] = hp.z;
        const fade = Math.pow(1 - j / 25, 1.5);
        d.trailCol[j * 3] = fade;
        d.trailCol[j * 3 + 1] = fade * 0.9;
        d.trailCol[j * 3 + 2] = fade * 0.6;
      } else {
        d.trailCol[j * 3] = d.trailCol[j * 3 + 1] = d.trailCol[j * 3 + 2] = 0;
      }
    }
    d.trailGeo.attributes.position.needsUpdate = true;
    d.trailGeo.attributes.color.needsUpdate = true;
    
    const lp = d.life / d.maxLife;
    const fade = lp < 0.1 ? lp / 0.1 : Math.pow(1 - (lp - 0.1) / 0.9, 0.6);
    d.coreMat.opacity = fade;
    d.glowMat.opacity = fade * 0.5;
    d.trailMat.opacity = fade;
    
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
    positions[i*3] = (Math.random() - 0.5) * 12;
    positions[i*3+1] = 0.2 + Math.random() * 4;
    positions[i*3+2] = -1 - Math.random() * 6;
    const b = 0.6 + Math.random() * 0.4;
    colors[i*3] = colors[i*3+1] = colors[i*3+2] = b;
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.5 + Math.random() * 2;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ map: starTexture, size: 0.08, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

function updateStars(data, time) {
  if (!data) return;
  const { points, positions, colors, phases } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const twinkle = 0.6 + 0.4 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = colors[i*3] * twinkle;
    col[i*3+1] = colors[i*3+1] * twinkle;
    col[i*3+2] = colors[i*3+2] * twinkle;
    const drift = 0.15;
    pos[i*3] = positions[i*3] + Math.sin(time * 0.15 + phases[i*4+2]) * drift;
    pos[i*3+1] = positions[i*3+1] + Math.cos(time * 0.12 + phases[i*4]) * drift * 0.5;
    pos[i*3+2] = positions[i*3+2] + Math.sin(time * 0.1 + phases[i*4+3]) * drift;
  }
  points.geometry.attributes.position.needsUpdate = true;
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
    const drift = 0.4;
    pos[i*3] = positions[i*3] + Math.sin(time * 0.1 + phases[i*4+2]) * drift;
    pos[i*3+1] = positions[i*3+1] + Math.sin(time * 0.08 + phases[i*4]) * drift * 0.4;
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
    const pulse = 0.5 + 0.5 * Math.sin(time * phases[i*2+1] + phases[i*2]);
    col[i*3] = colors[i*3] * pulse;
    col[i*3+1] = colors[i*3+1] * pulse;
    col[i*3+2] = colors[i*3+2] * pulse;
  }
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 构建场景 ============
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

  ambientStarData = createAmbientStars(400);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

  if (USE_GLB_GALAXY) {
    gltfLoader.load(`${BASE}models/galaxy.glb`, (gltf) => {
      galaxyModel = gltf.scene;
      galaxyModel.scale.setScalar(SKY_RADIUS * 0.5);
      galaxyModel.traverse((child) => {
        if (child.isMesh) { child.material.transparent = true; child.material.opacity = 0; child.material.depthWrite = false; }
      });
      galaxyModel.renderOrder = 1;
      scene.add(galaxyModel);
    }, undefined, () => { createPanoSphere(panoTexture); });
  } else {
    createPanoSphere(panoTexture);
  }

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

  texLoader.load(`${BASE}textures/moon.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; moonMesh.material.map = tex; moonMesh.material.color.set(0xffffff); moonMesh.material.needsUpdate = true; });
  texLoader.load(`${BASE}textures/earth.jpg`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; earthMesh.material.map = tex; earthMesh.material.color.set(0xffffff); earthMesh.material.needsUpdate = true; });
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
  if (galaxyModel) galaxyModel.traverse((c) => { if (c.isMesh) c.material.opacity = smooth; });
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  if (moonMesh) moonMesh.material.opacity = smooth;
  if (earthMesh) earthMesh.material.opacity = smooth;
  if (nebulaPortal) nebulaPortal.userData.nebulaMat.opacity = (1 - smooth) * 0.5;
  if (ambientStars) ambientStars.material.opacity = (1 - smooth) * 0.9;
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
  swipeHistory = []; lastSwipeTime = 0; lastSwipeDir = null;
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
  nebulaPortal = null; ambientStars = null; portalMask = null;
  starData = null; floatingStarData = null; brightStarData = null; ambientStarData = null;
  reticle.visible = false;
  debugLabel.textContent = "等待...";
}
