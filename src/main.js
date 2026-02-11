import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;
const STAR_COUNT = 15000;
const PREVIEW_STAR_COUNT = 4000;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let doorGlow = null;
let skySphere = null;
let skyStars = null;
let placed = false;
let isInside = false;

// 音频
let bgAudio = null;
let audioStarted = false;

// 过渡
let transitionProgress = 0;
let transitionTarget = 0;

// 门平面
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

// 星星动画
let starBaseOpacities = null;
let starPhases = null;
let previewStarBaseOpacities = null;
let previewStarPhases = null;

// 流星系统
let meteors = [];
let isDrawing = false;
let drawPoints = [];
let lastDrawTime = 0;

// 星星纹理
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

  // 创建星星纹理（圆形发光点）
  starTexture = createStarTexture();

  // Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // 初始化音频
  initAudio();

  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  controller.addEventListener("selectstart", onDrawStart);
  controller.addEventListener("selectend", onDrawEnd);
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

// ============ 音频初始化 ============
function initAudio() {
  bgAudio = new Audio(`${BASE}audio/bg.flac`);
  bgAudio.loop = true;
  bgAudio.volume = 0.5;
}

function playAudio() {
  if (bgAudio && !audioStarted) {
    bgAudio.play().catch(e => console.log("Audio play failed:", e));
    audioStarted = true;
  }
}

// ============ 创建圆形星星纹理 ============
function createStarTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  
  // 清透明背景
  ctx.clearRect(0, 0, 64, 64);
  
  // 绘制柔和的圆形发光点
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.15, "rgba(255, 255, 255, 0.9)");
  gradient.addColorStop(0.4, "rgba(255, 255, 255, 0.4)");
  gradient.addColorStop(0.7, "rgba(255, 255, 255, 0.1)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建星星 ============
function createStars(count, radius, size = 0.12) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const baseOpacities = new Float32Array(count);
  const phases = new Float32Array(count * 2);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.5 + 0.5 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 颜色
    const colorType = Math.random();
    if (colorType < 0.65) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (colorType < 0.80) {
      colors[i * 3] = 0.8; colors[i * 3 + 1] = 0.9; colors[i * 3 + 2] = 1;
    } else if (colorType < 0.92) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.7;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.7; colors[i * 3 + 2] = 0.6;
    }
    
    baseOpacities[i] = 0.4 + Math.random() * 0.6;
    phases[i * 2] = Math.random() * Math.PI * 2;
    phases[i * 2 + 1] = 0.3 + Math.random() * 2.0;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starTexture,
    size,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, baseOpacities, phases };
}

// ============ 更新星星闪烁 ============
function updateStarTwinkle(points, baseOpacities, phases, time) {
  if (!points || !baseOpacities || !phases) return;
  
  const colors = points.geometry.attributes.color.array;
  const count = baseOpacities.length;
  
  for (let i = 0; i < count; i++) {
    const phase = phases[i * 2];
    const speed = phases[i * 2 + 1];
    const twinkle = 0.5 + 0.5 * Math.sin(time * speed + phase);
    const brightness = baseOpacities[i] * (0.6 + 0.4 * twinkle);
    
    // 仅调节亮度，不改变色相
    const idx = i * 3;
    colors[idx] = Math.min(1, brightness * 1.2);
    colors[idx + 1] = Math.min(1, brightness * 1.2);
    colors[idx + 2] = Math.min(1, brightness * 1.2);
  }
  
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 创建门框辉光 ============
function createDoorGlow() {
  const group = new THREE.Group();
  
  // 拱形路径点
  const w = 1.1, h = 1.95, archR = 0.55;
  const pathPoints = [];
  
  // 左边
  for (let i = 0; i <= 10; i++) {
    pathPoints.push(new THREE.Vector3(-w/2, i * (h - archR) / 10, 0));
  }
  // 拱顶
  for (let i = 0; i <= 20; i++) {
    const angle = Math.PI - (i / 20) * Math.PI;
    pathPoints.push(new THREE.Vector3(
      Math.cos(angle) * archR,
      h - archR + Math.sin(angle) * archR,
      0
    ));
  }
  // 右边
  for (let i = 10; i >= 0; i--) {
    pathPoints.push(new THREE.Vector3(w/2, i * (h - archR) / 10, 0));
  }
  
  // 内发光层（多层叠加）
  for (let layer = 0; layer < 3; layer++) {
    const curve = new THREE.CatmullRomCurve3(pathPoints, false);
    const tubeGeo = new THREE.TubeGeometry(curve, 64, 0.02 + layer * 0.015, 8, false);
    
    const glowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.6 + layer * 0.05, 0.7, 0.6),
      transparent: true,
      opacity: 0.25 - layer * 0.07,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    
    const tube = new THREE.Mesh(tubeGeo, glowMat);
    tube.position.z = -0.02;
    group.add(tube);
  }
  
  // 外层光晕
  const glowShape = new THREE.Shape();
  glowShape.moveTo(-w/2 - 0.05, -0.05);
  glowShape.lineTo(-w/2 - 0.05, h - archR);
  glowShape.absarc(0, h - archR, archR + 0.05, Math.PI, 0, true);
  glowShape.lineTo(w/2 + 0.05, -0.05);
  glowShape.closePath();
  
  const innerHole = new THREE.Path();
  innerHole.moveTo(-w/2 + 0.05, 0.05);
  innerHole.lineTo(-w/2 + 0.05, h - archR);
  innerHole.absarc(0, h - archR, archR - 0.05, Math.PI, 0, true);
  innerHole.lineTo(w/2 - 0.05, 0.05);
  innerHole.closePath();
  glowShape.holes.push(innerHole);
  
  const frameGeo = new THREE.ShapeGeometry(glowShape, 32);
  const frameMat = new THREE.MeshBasicMaterial({
    color: 0x6688ff,
    transparent: true,
    opacity: 0.15,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.z = -0.01;
  group.add(frame);
  
  return group;
}

// ============ 流星系统 ============
function createMeteor(startPos, direction) {
  const group = new THREE.Group();
  group.position.copy(startPos);
  
  // 流星头部
  const headGeo = new THREE.SphereGeometry(0.08, 8, 8);
  const headMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
  });
  const head = new THREE.Mesh(headGeo, headMat);
  group.add(head);
  
  // 流星尾巴（拖尾）
  const tailLength = 2 + Math.random() * 1.5;
  const tailSegments = 30;
  const tailPositions = new Float32Array(tailSegments * 3);
  const tailColors = new Float32Array(tailSegments * 3);
  
  for (let i = 0; i < tailSegments; i++) {
    const t = i / tailSegments;
    tailPositions[i * 3] = -direction.x * t * tailLength;
    tailPositions[i * 3 + 1] = -direction.y * t * tailLength;
    tailPositions[i * 3 + 2] = -direction.z * t * tailLength;
    
    const fade = 1 - t;
    tailColors[i * 3] = fade;
    tailColors[i * 3 + 1] = fade * 0.8;
    tailColors[i * 3 + 2] = fade * 0.5;
  }
  
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute("position", new THREE.BufferAttribute(tailPositions, 3));
  tailGeo.setAttribute("color", new THREE.BufferAttribute(tailColors, 3));
  
  const tailMat = new THREE.PointsMaterial({
    map: starTexture,
    size: 0.15,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const tail = new THREE.Points(tailGeo, tailMat);
  group.add(tail);
  
  // 流星数据
  group.userData = {
    direction: direction.clone().normalize(),
    speed: 8 + Math.random() * 6,
    life: 0,
    maxLife: 2 + Math.random(),
    head,
    tail,
    headMat,
    tailMat,
  };
  
  return group;
}

function updateMeteors(delta) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const meteor = meteors[i];
    const data = meteor.userData;
    
    data.life += delta;
    
    // 移动
    meteor.position.addScaledVector(data.direction, data.speed * delta);
    
    // 淡出
    const fadeProgress = data.life / data.maxLife;
    const opacity = Math.max(0, 1 - fadeProgress);
    data.headMat.opacity = opacity;
    data.tailMat.opacity = opacity * 0.7;
    
    // 移除已消失的流星
    if (data.life >= data.maxLife) {
      scene.remove(meteor);
      meteors.splice(i, 1);
    }
  }
}

// ============ 手势绘制 ============
function onDrawStart() {
  if (!placed || !isInside) return;
  isDrawing = true;
  drawPoints = [];
  lastDrawTime = performance.now();
}

function onDrawEnd() {
  if (!isDrawing) return;
  isDrawing = false;
  
  // 如果画出了足够的轨迹，生成流星
  if (drawPoints.length >= 3) {
    spawnMeteorFromGesture();
  }
  drawPoints = [];
}

function updateDrawing() {
  if (!isDrawing || !placed || !isInside) return;
  
  const now = performance.now();
  if (now - lastDrawTime < 50) return; // 限制采样频率
  lastDrawTime = now;
  
  const controller = renderer.xr.getController(0);
  const pos = new THREE.Vector3();
  controller.getWorldPosition(pos);
  
  drawPoints.push(pos.clone());
  
  // 限制点数
  if (drawPoints.length > 20) {
    drawPoints.shift();
  }
}

function spawnMeteorFromGesture() {
  if (drawPoints.length < 2) return;
  
  // 计算手势方向
  const start = drawPoints[0];
  const end = drawPoints[drawPoints.length - 1];
  const direction = end.clone().sub(start).normalize();
  
  // 在视线前方随机位置生成流星
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  // 随机偏移
  const offset = new THREE.Vector3(
    (Math.random() - 0.5) * 10,
    2 + Math.random() * 8,
    (Math.random() - 0.5) * 10
  );
  
  const meteorPos = _camPos.clone().add(camDir.multiplyScalar(15)).add(offset);
  
  // 流星方向基于手势但加入随机
  const meteorDir = direction.clone();
  meteorDir.y -= 0.5; // 向下倾斜
  meteorDir.normalize();
  
  const meteor = createMeteor(meteorPos, meteorDir);
  scene.add(meteor);
  meteors.push(meteor);
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

  // 门框辉光
  doorGlow = createDoorGlow();
  doorGroup.add(doorGlow);

  // 门洞遮罩（加高）
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

  // 门外预览天球
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

  // 门外预览星星
  const previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.85, 0.05);
  previewStars = previewStarData.points;
  previewStarBaseOpacities = previewStarData.baseOpacities;
  previewStarPhases = previewStarData.phases;
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

  // 门内星星
  const skyStarData = createStars(STAR_COUNT, SKY_RADIUS * 0.8, 0.15);
  skyStars = skyStarData.points;
  starBaseOpacities = skyStarData.baseOpacities;
  starPhases = skyStarData.phases;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = -99;
  scene.add(skyStars);
}

// ============ 放置门 ============
function onSelect() {
  if (!placed) {
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
    transitionTarget = 0;
    transitionProgress = 0;
    placed = true;
    reticle.visible = false;

    // 播放音乐
    playAudio();
  }
}

function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  return doorPlaneNormal.dot(toCamera) >= 0 ? 1 : -1;
}

function checkCrossing(xrCam) {
  const currentSide = getSide(xrCam);
  
  if (lastSide === 1 && currentSide === -1 && !isInside) {
    isInside = true;
    transitionTarget = 1;
  } else if (lastSide === -1 && currentSide === 1 && isInside) {
    isInside = false;
    transitionTarget = 0;
  }
  
  lastSide = currentSide;
}

// ============ 平滑过渡（改进版）============
function updateTransition(delta) {
  const speed = 2.5;
  const diff = transitionTarget - transitionProgress;
  
  if (Math.abs(diff) > 0.001) {
    transitionProgress += diff * delta * speed;
  } else {
    transitionProgress = transitionTarget;
  }
  
  // 使用 smoothstep 曲线使过渡更自然
  const t = transitionProgress;
  const smooth = t * t * (3 - 2 * t);
  
  // 门内世界淡入
  if (skySphere && skySphere.material) {
    skySphere.material.opacity = smooth;
  }
  if (skyStars && skyStars.material) {
    skyStars.material.opacity = smooth;
  }
  
  // 门外预览淡出
  const previewOpacity = 1 - smooth;
  if (previewSphere && previewSphere.material) {
    previewSphere.material.opacity = previewOpacity;
  }
  if (previewStars && previewStars.material) {
    previewStars.material.opacity = previewOpacity;
  }
  
  // 门框辉光强度变化
  if (doorGlow) {
    doorGlow.traverse(child => {
      if (child.material) {
        child.material.opacity = 0.15 + smooth * 0.1;
      }
    });
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

  // Hit test
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
    checkCrossing(xrCam);
    updateTransition(delta);
    updateDrawing();
    updateMeteors(delta);

    // 门内世界跟随相机
    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    skyStars.position.copy(_camPos);
    
    // 更新星星闪烁
    updateStarTwinkle(skyStars, starBaseOpacities, starPhases, time);
    updateStarTwinkle(previewStars, previewStarBaseOpacities, previewStarPhases, time);
  }

  renderer.clear(true, true, true);
  renderer.render(scene, xrCam);
}

function reset() {
  placed = false;
  isInside = false;
  transitionProgress = 0;
  transitionTarget = 0;
  
  if (bgAudio) {
    bgAudio.pause();
    bgAudio.currentTime = 0;
    audioStarted = false;
  }
  
  // 清理流星
  meteors.forEach(m => scene.remove(m));
  meteors = [];
  
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) { scene.remove(skySphere); skySphere = null; }
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  
  previewSphere = null;
  previewStars = null;
  portalMask = null;
  doorGlow = null;
  
  reticle.visible = false;
}
