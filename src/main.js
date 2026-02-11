import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;
const STAR_COUNT = 8000;
const PREVIEW_STAR_COUNT = 5000;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let skySphere = null;
let skyStars = null;
let nebulaPlanes = [];
let placed = false;
let isInside = false;

// 音频
let bgAudio = null;
let audioStarted = false;

// 过渡
let transitionValue = 0;
let wasInside = false;

// 门平面
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

// 星星数据
let starData = null;
let previewStarData = null;

// 流星
let meteors = [];
let touchPoints = [];
let isTouching = false;

// 纹理
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

// ============ 星星纹理（大光晕）============
function createStarTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d");
  
  // 多层光晕
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.05, "rgba(255, 255, 255, 0.95)");
  gradient.addColorStop(0.1, "rgba(255, 255, 255, 0.8)");
  gradient.addColorStop(0.2, "rgba(255, 255, 255, 0.5)");
  gradient.addColorStop(0.4, "rgba(255, 255, 255, 0.2)");
  gradient.addColorStop(0.6, "rgba(255, 255, 255, 0.08)");
  gradient.addColorStop(0.8, "rgba(255, 255, 255, 0.02)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  
  // 十字星芒
  ctx.globalCompositeOperation = "lighter";
  for (let angle = 0; angle < 4; angle++) {
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate((angle * Math.PI) / 2);
    const spikeGradient = ctx.createLinearGradient(0, 0, 80, 0);
    spikeGradient.addColorStop(0, "rgba(255, 255, 255, 0.6)");
    spikeGradient.addColorStop(0.3, "rgba(255, 255, 255, 0.15)");
    spikeGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = spikeGradient;
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(80, 0);
    ctx.lineTo(0, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建星星 ============
function createStars(count, radius, baseSize = 0.25) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count * 3);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.5 + 0.5 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 星星颜色
    const type = Math.random();
    if (type < 0.5) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (type < 0.7) {
      colors[i * 3] = 0.85; colors[i * 3 + 1] = 0.92; colors[i * 3 + 2] = 1;
    } else if (type < 0.85) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.75;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 0.7;
    }
    
    // 大小变化（少数亮星）
    const sizeRand = Math.random();
    if (sizeRand > 0.98) sizes[i] = baseSize * 2.5;
    else if (sizeRand > 0.92) sizes[i] = baseSize * 1.8;
    else if (sizeRand > 0.8) sizes[i] = baseSize * 1.2;
    else sizes[i] = baseSize * (0.5 + Math.random() * 0.5);
    
    phases[i * 3] = Math.random() * Math.PI * 2;
    phases[i * 3 + 1] = 0.5 + Math.random() * 2.5;
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

// ============ 更新星星 ============
function updateStars(data, time) {
  if (!data) return;
  
  const { points, positions, colors, sizes, phases } = data;
  const posAttr = points.geometry.attributes.position.array;
  const colAttr = points.geometry.attributes.color.array;
  const count = positions.length / 3;
  
  for (let i = 0; i < count; i++) {
    const phase = phases[i * 3];
    const speed = phases[i * 3 + 1];
    const type = phases[i * 3 + 2];
    
    // 闪烁
    let twinkle;
    if (type > 0.7) {
      twinkle = 0.7 + 0.3 * Math.sin(time * speed + phase);
    } else {
      twinkle = 0.85 + 0.15 * Math.sin(time * speed * 0.5 + phase);
    }
    
    colAttr[i * 3] = colors[i * 3] * twinkle;
    colAttr[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    colAttr[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    // 微位移
    const drift = 0.15;
    posAttr[i * 3] = positions[i * 3] + Math.sin(time * 0.2 + phase) * drift;
    posAttr[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.18 + phase * 1.3) * drift * 0.5;
    posAttr[i * 3 + 2] = positions[i * 3 + 2] + Math.sin(time * 0.22 + phase * 0.7) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 精美流星 ============
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
    .addScaledVector(camForward, 0.3)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(12))
    .add(new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 5, (Math.random() - 0.5) * 6));
  
  const meteor = createPremiumMeteor(spawnPos, dir3D);
  scene.add(meteor);
  meteors.push(meteor);
}

function createPremiumMeteor(pos, dir) {
  const group = new THREE.Group();
  group.position.copy(pos);
  
  const length = 6 + Math.random() * 4;
  const segments = 120;
  
  // 主尾迹粒子
  const trailPos = new Float32Array(segments * 3);
  const trailCol = new Float32Array(segments * 3);
  const trailSize = new Float32Array(segments);
  
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const tCurve = Math.pow(t, 0.7);
    
    trailPos[i * 3] = -dir.x * tCurve * length;
    trailPos[i * 3 + 1] = -dir.y * tCurve * length;
    trailPos[i * 3 + 2] = -dir.z * tCurve * length;
    
    const fade = Math.pow(1 - t, 1.5);
    
    // 颜色：白核心 → 淡黄 → 橙黄 → 淡青 → 透明
    if (t < 0.1) {
      trailCol[i * 3] = 1;
      trailCol[i * 3 + 1] = 1;
      trailCol[i * 3 + 2] = 0.98;
    } else if (t < 0.3) {
      const blend = (t - 0.1) / 0.2;
      trailCol[i * 3] = 1;
      trailCol[i * 3 + 1] = 1 - blend * 0.15;
      trailCol[i * 3 + 2] = 0.98 - blend * 0.4;
    } else if (t < 0.6) {
      const blend = (t - 0.3) / 0.3;
      trailCol[i * 3] = 1 - blend * 0.3;
      trailCol[i * 3 + 1] = 0.85 - blend * 0.2;
      trailCol[i * 3 + 2] = 0.58 + blend * 0.22;
    } else {
      const blend = (t - 0.6) / 0.4;
      trailCol[i * 3] = (0.7 - blend * 0.4) * fade;
      trailCol[i * 3 + 1] = (0.65 + blend * 0.1) * fade;
      trailCol[i * 3 + 2] = (0.8 + blend * 0.15) * fade;
    }
    
    trailCol[i * 3] *= fade;
    trailCol[i * 3 + 1] *= fade;
    trailCol[i * 3 + 2] *= fade;
    
    trailSize[i] = (1 - t * 0.85) * 0.4;
  }
  
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
  
  const trailMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.5,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const trail = new THREE.Points(trailGeo, trailMat);
  group.add(trail);
  
  // 发光核心
  const coreGeo = new THREE.SphereGeometry(0.08, 12, 12);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const core = new THREE.Mesh(coreGeo, coreMat);
  group.add(core);
  
  // 外层辉光
  const glowGeo = new THREE.SphereGeometry(0.2, 12, 12);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffffee,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  group.add(glow);
  
  // 细碎火花
  const sparkCount = 40;
  const sparkPos = new Float32Array(sparkCount * 3);
  const sparkCol = new Float32Array(sparkCount * 3);
  
  for (let i = 0; i < sparkCount; i++) {
    const t = Math.random() * 0.5;
    const spread = t * 0.4;
    sparkPos[i * 3] = -dir.x * t * length + (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 1] = -dir.y * t * length + (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 2] = -dir.z * t * length + (Math.random() - 0.5) * spread;
    
    const brightness = 0.5 + Math.random() * 0.5;
    sparkCol[i * 3] = brightness;
    sparkCol[i * 3 + 1] = brightness * 0.9;
    sparkCol[i * 3 + 2] = brightness * 0.7;
  }
  
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(sparkCol, 3));
  
  const sparkMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.12,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  group.add(sparks);
  
  group.userData = {
    direction: dir.clone(),
    speed: 18 + Math.random() * 12,
    life: 0,
    maxLife: 2.5 + Math.random(),
    trailMat,
    coreMat,
    glowMat,
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
    
    const fade = Math.pow(Math.max(0, 1 - d.life / d.maxLife), 0.7);
    d.trailMat.opacity = fade;
    d.glowMat.opacity = fade * 0.7;
    d.sparkMat.opacity = fade;
    
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

  // 预览星星
  previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.85, 0.2);
  previewStars = previewStarData.points;
  previewStars.material.stencilWrite = true;
  previewStars.material.stencilRef = 1;
  previewStars.material.stencilFunc = THREE.EqualStencilFunc;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

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

  // 门内星星（减少数量，增大尺寸）
  starData = createStars(STAR_COUNT, SKY_RADIUS * 0.8, 0.35);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = -99;
  scene.add(skyStars);
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
  wasInside = false;
  transitionValue = 0;
  placed = true;
  reticle.visible = false;

  playAudio();
}

function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  return doorPlaneNormal.dot(_camPos.clone().sub(doorPlanePoint)) >= 0 ? 1 : -1;
}

// ============ 过渡（改进版）============
function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  const signedDist = doorPlaneNormal.dot(toCamera);
  
  const currentSide = signedDist >= 0 ? 1 : -1;
  if (lastSide === 1 && currentSide === -1) isInside = true;
  else if (lastSide === -1 && currentSide === 1) isInside = false;
  lastSide = currentSide;
  
  // 目标值
  let target;
  if (isInside) {
    target = 1;
  } else {
    const dist = Math.abs(signedDist);
    target = Math.max(0, 1 - dist / 1.5) * 0.15;
  }
  
  // 平滑过渡
  const speed = isInside ? 5.0 : 3.0;
  transitionValue += (target - transitionValue) * Math.min(1, delta * speed);
  
  const t = transitionValue;
  
  // 门内世界
  if (skySphere) skySphere.material.opacity = t;
  if (skyStars) skyStars.material.opacity = t;
  
  // 预览
  const previewOp = Math.max(0, 1 - t * 1.2);
  if (previewSphere) previewSphere.material.opacity = previewOp;
  if (previewStars) previewStars.material.opacity = previewOp;
  
  if (portalMask) portalMask.visible = t < 0.9;
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
    
    updateStars(starData, time);
    updateStars(previewStarData, time);
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
  
  previewSphere = null;
  previewStars = null;
  portalMask = null;
  starData = null;
  previewStarData = null;
  
  reticle.visible = false;
}
