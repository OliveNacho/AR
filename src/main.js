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
let moonMesh = null;
let jupiterMesh = null;
let marsMesh = null;
let easterEggs = [];
let sagittariusGroup = null;
let placed = false;
let isInside = false;
let placedTime = 0;
let meteorShowerTriggered = false;

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

  // Reset 按钮
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
    
    if (isInside && touchPoints.length >= 3) {
      spawnMeteor();
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

// 流星雨：从随机方向生成大量流星
function spawnMeteorShower() {
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  
  const meteorCount = 30 + Math.floor(Math.random() * 20);
  
  for (let i = 0; i < meteorCount; i++) {
    setTimeout(() => {
      const angle = Math.random() * Math.PI * 2;
      const elevation = 0.3 + Math.random() * 0.5;
      
      const spawnDir = new THREE.Vector3()
        .addScaledVector(camForward, 0.5)
        .addScaledVector(camRight, Math.cos(angle) * 0.8)
        .addScaledVector(camUp, elevation)
        .normalize();
      
      const spawnPos = _camPos.clone()
        .add(spawnDir.clone().multiplyScalar(15 + Math.random() * 20))
        .add(new THREE.Vector3(
          (Math.random() - 0.5) * 10,
          5 + Math.random() * 10,
          (Math.random() - 0.5) * 10
        ));
      
      const flyDir = new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        -0.4 - Math.random() * 0.3,
        (Math.random() - 0.5) * 0.6
      ).normalize();
      
      const curvature = (Math.random() - 0.5) * 4;
      const meteor = createArcMeteor(spawnPos, flyDir, curvature);
      scene.add(meteor);
      meteors.push(meteor);
    }, i * (80 + Math.random() * 120));
  }
}

function createArcMeteor(startPos, baseDir, userCurvature) {
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
  
  const trailCount = 50;
  const trailSprites = [];
  
  for (let i = 0; i < trailCount; i++) {
    const t = i / trailCount;
    const size = 0.4 * Math.pow(1 - t, 0.8);
    
    const spriteMat = new THREE.SpriteMaterial({
      map: starTexture,
      color: new THREE.Color(1, 1 - t * 0.3, 1 - t * 0.7),
      transparent: true,
      opacity: Math.pow(1 - t, 1.2),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(size, size, 1);
    sprite.position.copy(startPos);
    sprite.renderOrder = 200;
    sprite.visible = false;
    scene.add(sprite);
    trailSprites.push({ sprite, mat: spriteMat });
  }
  
  group.userData = {
    curve,
    progress: 0,
    speed: 0.10 + Math.random() * 0.04,
    life: 0,
    maxLife: 4.5 + Math.random() * 2,
    coreMat,
    innerMat,
    glowMat,
    history: [],
    coreSprite,
    innerSprite,
    glowSprite,
    trailCount,
    trailSprites,
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
    
    d.history.unshift(pos.clone());
    if (d.history.length > d.trailCount) d.history.pop();
    
    const historyLen = d.history.length;
    for (let j = 0; j < d.trailCount; j++) {
      const ts = d.trailSprites[j];
      if (j < historyLen) {
        ts.sprite.visible = true;
        ts.sprite.position.copy(d.history[j]);
      } else {
        ts.sprite.visible = false;
      }
    }
    
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

// ============ 星星（颜色更亮：白色、蓝色、金色、绿色）============
function getRandomStarColor() {
  const colors = [
    [1, 1, 1],           // 白色
    [0.7, 0.85, 1],      // 蓝色
    [1, 0.9, 0.5],       // 金色
    [0.6, 1, 0.7],       // 绿色
    [0.9, 0.95, 1],      // 浅蓝白
    [1, 0.95, 0.6],      // 浅金色
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

function createStars(count, radius, baseSize) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.75 + 0.25 * Math.random());
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = getRandomStarColor();
    colors[i*3] = c[0]; colors[i*3+1] = c[1]; colors[i*3+2] = c[2];
    
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.5 + Math.random() * 2;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ 
    map: starTexture, 
    size: baseSize, 
    vertexColors: true, 
    transparent: true, 
    depthWrite: false, 
    blending: THREE.AdditiveBlending, 
    sizeAttenuation: true 
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
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = getRandomStarColor();
    colors[i*3] = c[0]; colors[i*3+1] = c[1]; colors[i*3+2] = c[2];
    
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.3 + Math.random() * 1.5;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ 
    map: starTexture, 
    size: baseSize, 
    vertexColors: true, 
    transparent: true, 
    depthWrite: false, 
    blending: THREE.AdditiveBlending, 
    sizeAttenuation: true 
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 2);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    positions[i*3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.cos(phi);
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = getRandomStarColor();
    colors[i*3] = c[0]; colors[i*3+1] = c[1]; colors[i*3+2] = c[2];
    
    phases[i*2] = Math.random() * Math.PI * 2;
    phases[i*2+1] = 0.2 + Math.random() * 0.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ 
    map: starTexture, 
    size: 1.0, 
    vertexColors: true, 
    transparent: true, 
    depthWrite: false, 
    blending: THREE.AdditiveBlending, 
    sizeAttenuation: true 
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
    positions[i*3] = (Math.random() - 0.5) * 5;
    positions[i*3+1] = 0.3 + Math.random() * 2.5;
    positions[i*3+2] = -0.5 - Math.random() * 3;
    
    const c = getRandomStarColor();
    const brightness = 0.8 + Math.random() * 0.2;
    colors[i*3] = c[0] * brightness;
    colors[i*3+1] = c[1] * brightness;
    colors[i*3+2] = c[2] * brightness;
    
    phases[i*4] = Math.random() * Math.PI * 2;
    phases[i*4+1] = 0.5 + Math.random() * 2;
    phases[i*4+2] = Math.random() * Math.PI * 2;
    phases[i*4+3] = Math.random() * Math.PI * 2;
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
    sizeAttenuation: true 
  });
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
    // 更亮的闪烁效果
    const twinkle = 0.7 + 0.3 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = Math.min(1, colors[i*3] * twinkle * 1.2);
    col[i*3+1] = Math.min(1, colors[i*3+1] * twinkle * 1.2);
    col[i*3+2] = Math.min(1, colors[i*3+2] * twinkle * 1.2);
  }
  points.geometry.attributes.color.needsUpdate = true;
}

function updateFloatingStars(data, time) {
  if (!data) return;
  const { points, positions, colors, phases } = data;
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const twinkle = 0.6 + 0.4 * Math.sin(time * phases[i*4+1] + phases[i*4]);
    col[i*3] = Math.min(1, colors[i*3] * twinkle * 1.3);
    col[i*3+1] = Math.min(1, colors[i*3+1] * twinkle * 1.3);
    col[i*3+2] = Math.min(1, colors[i*3+2] * twinkle * 1.3);
    
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
    const pulse = 0.7 + 0.3 * Math.sin(time * phases[i*2+1] + phases[i*2]);
    col[i*3] = Math.min(1, colors[i*3] * pulse * 1.4);
    col[i*3+1] = Math.min(1, colors[i*3+1] * pulse * 1.4);
    col[i*3+2] = Math.min(1, colors[i*3+2] * pulse * 1.4);
  }
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 射手座 ============
function createSagittarius() {
  const group = new THREE.Group();
  
  // 射手座主要星星的相对位置（茶壶形状）
  // 简化版：大约12颗主要星星
  const starPositions = [
    // 茶壶盖
    { x: 0, y: 2, z: 0, size: 0.5, brightness: 1 },
    // 茶壶顶部
    { x: -1.5, y: 1.2, z: 0.3, size: 0.6, brightness: 1.2 },
    { x: 1.5, y: 1.2, z: -0.2, size: 0.55, brightness: 1.1 },
    // 茶壶身体
    { x: -2, y: 0, z: 0.5, size: 0.65, brightness: 1.3 },
    { x: -1, y: -0.5, z: 0.2, size: 0.5, brightness: 1 },
    { x: 0, y: -0.3, z: 0, size: 0.55, brightness: 1.1 },
    { x: 1.2, y: 0, z: -0.3, size: 0.6, brightness: 1.2 },
    { x: 2, y: 0.5, z: -0.5, size: 0.5, brightness: 1 },
    // 茶壶底部
    { x: -1.5, y: -1.5, z: 0.4, size: 0.5, brightness: 1 },
    { x: 0.5, y: -1.3, z: 0, size: 0.55, brightness: 1.1 },
    // 把手和壶嘴
    { x: -3, y: 0.5, z: 0.8, size: 0.45, brightness: 0.9 },
    { x: 2.5, y: 1.5, z: -0.6, size: 0.45, brightness: 0.9 },
  ];
  
  // 星座连线
  const lineConnections = [
    [0, 1], [0, 2],
    [1, 3], [2, 7],
    [3, 4], [4, 5], [5, 6], [6, 7],
    [3, 8], [5, 9], [6, 9],
    [3, 10], [7, 11],
  ];
  
  // 创建星星
  const starMeshes = [];
  starPositions.forEach((star, index) => {
    const starMat = new THREE.SpriteMaterial({
      map: starTexture,
      color: new THREE.Color(1, 0.95, 0.8),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(starMat);
    sprite.position.set(star.x, star.y, star.z);
    sprite.scale.setScalar(star.size);
    sprite.userData = { brightness: star.brightness, baseMat: starMat };
    group.add(sprite);
    starMeshes.push(sprite);
  });
  
  // 创建连线
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x6688aa,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  
  lineConnections.forEach(([i, j]) => {
    const points = [
      new THREE.Vector3(starPositions[i].x, starPositions[i].y, starPositions[i].z),
      new THREE.Vector3(starPositions[j].x, starPositions[j].y, starPositions[j].z),
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, lineMat.clone());
    group.add(line);
  });
  
  group.userData = { starMeshes, lineMat };
  group.scale.setScalar(1.5);
  
  return group;
}

function updateSagittarius(time, opacity) {
  if (!sagittariusGroup) return;
  
  sagittariusGroup.children.forEach((child) => {
    if (child.isSprite) {
      const brightness = child.userData.brightness || 1;
      const twinkle = 0.7 + 0.3 * Math.sin(time * 1.5 + child.position.x * 2);
      child.userData.baseMat.opacity = opacity * brightness * twinkle;
    } else if (child.isLine) {
      child.material.opacity = opacity * 0.25;
    }
  });
}

// ============ 构建 ============
function createNebulaPortal() {
  const group = new THREE.Group();
  const nebulaMat = new THREE.MeshBasicMaterial({ 
    map: nebulaTexture, 
    transparent: true, 
    opacity: 0.5, 
    side: THREE.DoubleSide, 
    blending: THREE.AdditiveBlending, 
    depthWrite: false 
  });
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
    const spriteMat = new THREE.SpriteMaterial({ 
      map: texture, 
      transparent: true, 
      opacity: 0, 
      depthWrite: false 
    });
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

  // ===== Pano 天空背景 =====
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

  // ===== 星星 =====
  starData = createStars(4000, SKY_RADIUS * 0.95, 0.25);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  floatingStarData = createFloatingStars(800, SKY_RADIUS * 0.1, SKY_RADIUS * 0.4, 0.22);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  brightStarData = createBrightStars(40, SKY_RADIUS * 0.9);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = 4;
  scene.add(brightStars);

  // ===== 月亮（更近、更大）=====
  const moonGeo = new THREE.SphereGeometry(5, 64, 64);
  moonMesh = new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ 
    color: 0xdddddd, 
    transparent: true, 
    opacity: 0 
  }));
  moonMesh.renderOrder = 10;
  scene.add(moonMesh);

  // ===== 木星 =====
  const jupiterGeo = new THREE.SphereGeometry(7, 64, 64);
  jupiterMesh = new THREE.Mesh(jupiterGeo, new THREE.MeshBasicMaterial({ 
    color: 0xddaa77, 
    transparent: true, 
    opacity: 0 
  }));
  jupiterMesh.renderOrder = 10;
  scene.add(jupiterMesh);

  // ===== 火星（更远）=====
  const marsGeo = new THREE.SphereGeometry(3, 64, 64);
  marsMesh = new THREE.Mesh(marsGeo, new THREE.MeshBasicMaterial({ 
    color: 0xdd6644, 
    transparent: true, 
    opacity: 0 
  }));
  marsMesh.renderOrder = 10;
  scene.add(marsMesh);

  // 加载贴图
  texLoader.load(`${BASE}textures/moon.jpg`, (tex) => { 
    tex.colorSpace = THREE.SRGBColorSpace; 
    moonMesh.material.map = tex; 
    moonMesh.material.color.set(0xffffff); 
    moonMesh.material.needsUpdate = true; 
  });
  texLoader.load(`${BASE}textures/jupiter.jpg`, (tex) => { 
    tex.colorSpace = THREE.SRGBColorSpace; 
    jupiterMesh.material.map = tex; 
    jupiterMesh.material.color.set(0xffffff); 
    jupiterMesh.material.needsUpdate = true; 
  });
  texLoader.load(`${BASE}textures/mars.jpg`, (tex) => { 
    tex.colorSpace = THREE.SRGBColorSpace; 
    marsMesh.material.map = tex; 
    marsMesh.material.color.set(0xffffff); 
    marsMesh.material.needsUpdate = true; 
  });

  // ===== 射手座 =====
  sagittariusGroup = createSagittarius();
  sagittariusGroup.renderOrder = 15;
  scene.add(sagittariusGroup);

  // ===== 彩蛋 =====
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
  if (moonMesh) moonMesh.material.opacity = smooth;
  if (jupiterMesh) jupiterMesh.material.opacity = smooth;
  if (marsMesh) marsMesh.material.opacity = smooth;
  easterEggs.forEach(egg => { egg.userData.spriteMat.opacity = smooth * 0.3; });
  
  // 射手座透明度
  updateSagittarius(performance.now() / 1000, smooth);
  
  const previewOp = 1 - smooth;
  if (nebulaPortal) nebulaPortal.userData.nebulaMat.opacity = previewOp * 0.5;
  if (ambientStars) ambientStars.material.opacity = previewOp * 0.8;
  if (portalMask) portalMask.visible = smooth < 0.99;
}

function updateCelestialBodies(time, delta) {
  // 月亮：更近的位置
  if (moonMesh) {
    const moonPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, 12)
      .addScaledVector(doorRight, -8);
    moonPos.y = doorPlanePoint.y + 6;
    moonMesh.position.copy(moonPos);
    moonMesh.rotation.y += delta * 0.05;
  }
  
  // 木星：中等距离
  if (jupiterMesh) {
    const jupiterPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, 28)
      .addScaledVector(doorRight, 15);
    jupiterPos.y = doorPlanePoint.y + 2;
    jupiterMesh.position.copy(jupiterPos);
    jupiterMesh.rotation.y += delta * 0.03;
  }
  
  // 火星：更远的位置
  if (marsMesh) {
    const marsPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, 40)
      .addScaledVector(doorRight, -20);
    marsPos.y = doorPlanePoint.y + 15;
    marsMesh.position.copy(marsPos);
    marsMesh.rotation.y += delta * 0.04;
  }
  
  // 射手座位置
  if (sagittariusGroup) {
    const sagPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, 35)
      .addScaledVector(doorRight, -5);
    sagPos.y = doorPlanePoint.y + 10;
    sagittariusGroup.position.copy(sagPos);
    sagittariusGroup.lookAt(_camPos);
  }
  
  // 彩蛋位置
  easterEggs.forEach((egg) => {
    const rel = egg.userData.relPos;
    const eggPos = doorPlanePoint.clone()
      .addScaledVector(doorForward, rel.forward)
      .addScaledVector(doorRight, rel.right);
    eggPos.y = doorPlanePoint.y + rel.up;
    egg.position.copy(eggPos);
  });
  
  // 天空跟随相机
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  if (skySphere) skySphere.position.copy(_camPos);
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
    
    // 流星雨触发：放置后 3分10秒 = 190秒
    if (!meteorShowerTriggered && isInside && (now - placedTime) >= 190000) {
      meteorShowerTriggered = true;
      spawnMeteorShower();
    }
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false; 
  isInside = false; 
  transitionValue = 0;
  placedTime = 0;
  meteorShowerTriggered = false;
  
  if (bgAudio) { 
    bgAudio.pause(); 
    bgAudio.currentTime = 0; 
    audioStarted = false; 
  }
  
  meteors.forEach(m => { 
    scene.remove(m); 
    if (m.userData.trailSprites) {
      m.userData.trailSprites.forEach(ts => scene.remove(ts.sprite));
    }
  });
  meteors = [];
  
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) { scene.remove(skySphere); skySphere = null; }
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  if (floatingStars) { scene.remove(floatingStars); floatingStars = null; }
  if (brightStars) { scene.remove(brightStars); brightStars = null; }
  if (moonMesh) { scene.remove(moonMesh); moonMesh = null; }
  if (jupiterMesh) { scene.remove(jupiterMesh); jupiterMesh = null; }
  if (marsMesh) { scene.remove(marsMesh); marsMesh = null; }
  if (sagittariusGroup) { scene.remove(sagittariusGroup); sagittariusGroup = null; }
  
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
