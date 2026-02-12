import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

// ============ 配置 ============
const BASE = './';
const USE_GLB_GALAXY = false;  // true = GLB模式, false = Pano模式
const SKY_RADIUS = 80;
const DOOR_HEIGHT = 2.2;

// ============ 全局变量 ============
let scene, camera, renderer;
let doorGroup, portalMask, nebulaPortal;
let skySphere, galaxyModel;
let skyStars, starData;
let floatingStars, floatingStarData;
let brightStars, brightStarData;
let ambientStars, ambientStarData;
let moonMesh, earthMesh;
let easterEggs = [];
let meteors = [];
let starTexture;

// 交互状态
let touchPoints = [];
let lastTouchTime = 0;
const _camPos = new THREE.Vector3();

// 场景状态
let isInsidePortal = false;
let portalTransition = 0;  // 0 = 门外, 1 = 门内

// ============ 初始化 ============
function init() {
  scene = new THREE.Scene();
  
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.6, 3);
  
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.sortObjects = true;
  document.body.appendChild(renderer.domElement);
  document.body.appendChild(VRButton.createButton(renderer));
  
  // 创建星星纹理
  starTexture = createStarTexture();
  
  // 构建场景
  build();
  
  // 事件监听
  setupEvents();
  
  // 开始渲染循环
  renderer.setAnimationLoop(animate);
}

function createStarTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.2, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.3)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// ============ 构建场景 ============
function build() {
  const texLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();
  
  // 提前加载 pano 纹理
  const panoTexture = texLoader.load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;

  // ===== 门框 =====
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
    // 备用简单门框
    const mat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
    left.position.set(-0.55, DOOR_HEIGHT / 2, 0);
    const right = left.clone();
    right.position.set(0.55, DOOR_HEIGHT / 2, 0);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.1), mat);
    top.position.set(0, DOOR_HEIGHT, 0);
    doorGroup.add(left, right, top);
  });

  // ===== 门户遮罩（模板缓冲）=====
  const maskShape = new THREE.Shape();
  const mw = 1.08, mh = 1.9, archR = 0.54;
  maskShape.moveTo(-mw / 2, 0);
  maskShape.lineTo(-mw / 2, mh - archR);
  maskShape.absarc(0, mh - archR, archR, Math.PI, 0, true);
  maskShape.lineTo(mw / 2, 0);
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

  // ===== 门户星云效果 =====
  nebulaPortal = createNebulaPortal();
  doorGroup.add(nebulaPortal);

  // ===== 门内环境星星 =====
  ambientStarData = createAmbientStars(200);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

  // ===== 天空背景 =====
  if (USE_GLB_GALAXY) {
    gltfLoader.load(`${BASE}models/galaxy.glb`, (gltf) => {
      galaxyModel = gltf.scene;
      galaxyModel.scale.setScalar(SKY_RADIUS * 0.5);
      galaxyModel.traverse((child) => {
        if (child.isMesh) {
          child.material.transparent = true;
          child.material.opacity = 0;
          child.material.depthWrite = false;
          child.material.side = THREE.BackSide;
          child.renderOrder = 1;
        }
      });
      galaxyModel.renderOrder = 1;
      scene.add(galaxyModel);
    }, undefined, (err) => {
      console.warn("GLB 加载失败，切换到 Pano:", err);
      createPanoSphereInternal(panoTexture);
    });
  } else {
    createPanoSphereInternal(panoTexture);
  }
  
  function createPanoSphereInternal(texture) {
    skySphere = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 64, 32),
      new THREE.MeshBasicMaterial({
        map: texture,
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

  // ===== 天空星星 =====
  starData = createStars(4000, SKY_RADIUS * 0.95, 0.22);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  // ===== 漂浮星星 =====
  floatingStarData = createFloatingStars(800, SKY_RADIUS * 0.1, SKY_RADIUS * 0.4, 0.2);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  // ===== 明亮星星 =====
  brightStarData = createBrightStars(30, SKY_RADIUS * 0.9);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = 4;
  scene.add(brightStars);

  // ===== 天体 =====
  const moonGeo = new THREE.SphereGeometry(4, 64, 64);
  moonMesh = new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({
    color: 0xdddddd,
    transparent: true,
    opacity: 0
  }));
  moonMesh.position.set(-30, 25, -50);
  moonMesh.renderOrder = 10;
  scene.add(moonMesh);

  const earthGeo = new THREE.SphereGeometry(6, 64, 64);
  earthMesh = new THREE.Mesh(earthGeo, new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0
  }));
  earthMesh.position.set(40, -20, -60);
  earthMesh.renderOrder = 10;
  scene.add(earthMesh);

  // 加载天体纹理
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

  // ===== 彩蛋 =====
  easterEggs = createEasterEggs();
  easterEggs.forEach(egg => scene.add(egg));
}

// ============ 星星创建函数 ============
function createStars(count, radius, size) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.9 + Math.random() * 0.1);
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    
    const temp = Math.random();
    if (temp < 0.3) {
      colors[i * 3] = 0.8 + Math.random() * 0.2;
      colors[i * 3 + 1] = 0.85 + Math.random() * 0.15;
      colors[i * 3 + 2] = 1;
    } else if (temp < 0.6) {
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 0.95 + Math.random() * 0.05;
      colors[i * 3 + 2] = 0.8 + Math.random() * 0.2;
    } else {
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 1;
      colors[i * 3 + 2] = 1;
    }
    
    sizes[i] = size * (0.5 + Math.random() * 1);
  }
  
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  
  const material = new THREE.PointsMaterial({
    map: starTexture,
    size: size,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  
  return { points, positions, colors, sizes };
}

function createFloatingStars(count, minRadius, maxRadius, size) {
  const positions = new Float32Array(count * 3);
  const velocities = [];
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = minRadius + Math.random() * (maxRadius - minRadius);
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    
    velocities.push({
      x: (Math.random() - 0.5) * 0.02,
      y: (Math.random() - 0.5) * 0.02,
      z: (Math.random() - 0.5) * 0.02,
    });
  }
  
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  
  const material = new THREE.PointsMaterial({
    map: starTexture,
    size: size,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  
  return { points, positions, velocities, minRadius, maxRadius };
}

function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const phases = [];
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
    
    phases.push(Math.random() * Math.PI * 2);
  }
  
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  
  const material = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.8,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  
  return { points, positions, phases };
}

function createAmbientStars(count) {
  const positions = new Float32Array(count * 3);
  
  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * 2;
    const y = Math.random() * 2;
    const z = (Math.random() - 0.5) * 4 - 2;
    
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  
  const material = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.08,
    color: 0xaaccff,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  
  return { points, positions };
}

// ============ 门户效果 ============
function createNebulaPortal() {
  const group = new THREE.Group();
  
  // 中心光芒
  const coreMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0x8866ff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Sprite(coreMat);
  core.scale.set(1.5, 2, 1);
  core.position.z = -0.1;
  group.add(core);
  
  // 外层光晕
  const glowMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0x4422aa,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(2.5, 3, 1);
  glow.position.z = -0.15;
  group.add(glow);
  
  group.userData = { coreMat, glowMat };
  group.position.set(0, 1, -0.1);
  
  return group;
}

// ============ 彩蛋 ============
function createEasterEggs() {
  const eggs = [];
  
  // UFO
  const ufoGroup = new THREE.Group();
  const bodyGeo = new THREE.SphereGeometry(0.5, 32, 16);
  bodyGeo.scale(1, 0.3, 1);
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  ufoGroup.add(body);
  
  const domeGeo = new THREE.SphereGeometry(0.25, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  const domeMat = new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0 });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.position.y = 0.1;
  ufoGroup.add(dome);
  
  ufoGroup.position.set(20, 30, -40);
  ufoGroup.userData = { type: 'ufo', bodyMat, domeMat, angle: 0 };
  eggs.push(ufoGroup);
  
  // 卫星
  const satGroup = new THREE.Group();
  const satBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.3, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0 })
  );
  satGroup.add(satBody);
  
  const panelGeo = new THREE.BoxGeometry(0.8, 0.02, 0.4);
  const panelMat = new THREE.MeshBasicMaterial({ color: 0x2244aa, transparent: true, opacity: 0 });
  const leftPanel = new THREE.Mesh(panelGeo, panelMat);
  leftPanel.position.set(-0.55, 0, 0);
  satGroup.add(leftPanel);
  const rightPanel = new THREE.Mesh(panelGeo, panelMat);
  rightPanel.position.set(0.55, 0, 0);
  satGroup.add(rightPanel);
  
  satGroup.position.set(-25, 15, -35);
  satGroup.userData = { type: 'satellite', mats: [satBody.material, panelMat], angle: 0 };
  eggs.push(satGroup);
  
  return eggs;
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
  
  // 计算用户滑动的曲率
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
  
  // 飞行方向
  const flyDir = new THREE.Vector3()
    .addScaledVector(camRight, ndx * 0.85)
    .addScaledVector(camUp, -ndy * 0.75)
    .addScaledVector(camForward, 0.4)
    .normalize();
  
  // 起点
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
  
  // ===== 拖尾：使用多个 Sprite =====
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
    
    // 记录历史位置
    d.history.unshift(pos.clone());
    if (d.history.length > d.trailCount) d.history.pop();
    
    // 更新拖尾 Sprites
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
    
    // 生命周期淡入淡出
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
    
    // 拖尾淡出
    for (let j = 0; j < d.trailSprites.length; j++) {
      const ts = d.trailSprites[j];
      const baseOpacity = Math.pow(1 - j / d.trailCount, 1.2);
      ts.mat.opacity = baseOpacity * opacity;
    }
    
    // 移除完成的流星
    if (d.life >= d.maxLife || d.progress >= 1) {
      scene.remove(m);
      d.trailSprites.forEach(ts => scene.remove(ts.sprite));
      meteors.splice(i, 1);
    }
  }
}

// ============ 事件处理 ============
function setupEvents() {
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  
  // 触摸事件
  renderer.domElement.addEventListener('touchstart', (e) => {
    touchPoints = [];
    for (let touch of e.touches) {
      touchPoints.push({ x: touch.clientX, y: touch.clientY });
    }
  });
  
  renderer.domElement.addEventListener('touchmove', (e) => {
    for (let touch of e.touches) {
      touchPoints.push({ x: touch.clientX, y: touch.clientY });
    }
    if (touchPoints.length > 100) touchPoints = touchPoints.slice(-100);
  });
  
  renderer.domElement.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTouchTime > 200 && isInsidePortal) {
      spawnMeteor();
    }
    lastTouchTime = now;
    touchPoints = [];
  });
  
  // 鼠标事件（PC测试）
  let mouseDown = false;
  renderer.domElement.addEventListener('mousedown', (e) => {
    mouseDown = true;
    touchPoints = [{ x: e.clientX, y: e.clientY }];
  });
  
  renderer.domElement.addEventListener('mousemove', (e) => {
    if (mouseDown) {
      touchPoints.push({ x: e.clientX, y: e.clientY });
      if (touchPoints.length > 100) touchPoints = touchPoints.slice(-100);
    }
  });
  
  renderer.domElement.addEventListener('mouseup', () => {
    mouseDown = false;
    if (isInsidePortal) {
      spawnMeteor();
    }
    touchPoints = [];
  });
}

// ============ 辅助函数 ============
function setSkyOpacity(opacity) {
  if (USE_GLB_GALAXY && galaxyModel) {
    galaxyModel.traverse((child) => {
      if (child.isMesh) {
        child.material.opacity = opacity;
      }
    });
  } else if (skySphere) {
    skySphere.material.opacity = opacity;
  }
}

// ============ 动画循环 ============
let clock = new THREE.Clock();

function animate() {
  const delta = Math.min(clock.getDelta(), 0.1);
  const elapsed = clock.getElapsedTime();
  
  // 获取相机位置
  const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : camera;
  xrCam.getWorldPosition(_camPos);
  
  // 判断是否在门内（z < 0 视为门内）
  const wasInside = isInsidePortal;
  isInsidePortal = _camPos.z < 0;
  
  // 平滑过渡
  const targetTransition = isInsidePortal ? 1 : 0;
  portalTransition += (targetTransition - portalTransition) * delta * 3;
  
  // ===== 更新天空透明度 =====
  const skyOpacity = portalTransition;
  setSkyOpacity(skyOpacity);
  
  // 星星透明度
  if (skyStars) skyStars.material.opacity = skyOpacity;
  if (floatingStars) floatingStars.material.opacity = skyOpacity * 0.8;
  if (brightStars) brightStars.material.opacity = skyOpacity;
  
  // 天体透明度
  if (moonMesh) moonMesh.material.opacity = skyOpacity;
  if (earthMesh) earthMesh.material.opacity = skyOpacity;
  
  // 彩蛋透明度和动画
  easterEggs.forEach(egg => {
    if (egg.userData.type === 'ufo') {
      egg.userData.angle += delta * 0.5;
      egg.rotation.y = egg.userData.angle;
      egg.position.y = 30 + Math.sin(elapsed * 0.3) * 2;
      egg.userData.bodyMat.opacity = skyOpacity * 0.8;
      egg.userData.domeMat.opacity = skyOpacity * 0.6;
    } else if (egg.userData.type === 'satellite') {
      egg.userData.angle += delta * 0.2;
      egg.rotation.y = egg.userData.angle;
      egg.rotation.x = Math.sin(elapsed * 0.2) * 0.1;
      egg.userData.mats.forEach(mat => mat.opacity = skyOpacity * 0.8);
    }
  });
  
  // ===== 门户效果 =====
  if (nebulaPortal) {
    const { coreMat, glowMat } = nebulaPortal.userData;
    coreMat.opacity = 0.3 + Math.sin(elapsed * 2) * 0.15;
    glowMat.opacity = 0.2 + Math.sin(elapsed * 1.5 + 1) * 0.1;
  }
  
  // ===== 漂浮星星动画 =====
  if (floatingStarData && floatingStars.material.opacity > 0.01) {
    const pos = floatingStarData.positions;
    const vel = floatingStarData.velocities;
    const minR = floatingStarData.minRadius;
    const maxR = floatingStarData.maxRadius;
    
    for (let i = 0; i < vel.length; i++) {
      pos[i * 3] += vel[i].x;
      pos[i * 3 + 1] += vel[i].y;
      pos[i * 3 + 2] += vel[i].z;
      
      const dist = Math.sqrt(
        pos[i * 3] ** 2 + pos[i * 3 + 1] ** 2 + pos[i * 3 + 2] ** 2
      );
      
      if (dist > maxR || dist < minR) {
        vel[i].x *= -1;
        vel[i].y *= -1;
        vel[i].z *= -1;
      }
    }
    floatingStars.geometry.attributes.position.needsUpdate = true;
  }
  
  // ===== 明亮星星闪烁 =====
  if (brightStarData && brightStars.material.opacity > 0.01) {
    const baseSize = 0.8;
    const variation = 0.3;
    const newSize = baseSize + Math.sin(elapsed * 3) * variation;
    brightStars.material.size = newSize;
  }
  
  // ===== 天体旋转 =====
  if (moonMesh) moonMesh.rotation.y += delta * 0.02;
  if (earthMesh) earthMesh.rotation.y += delta * 0.01;
  
  // ===== 流星更新 =====
  updateMeteors(delta);
  
  renderer.render(scene, camera);
}

// ============ 启动 ============
init();
