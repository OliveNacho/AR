import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 8;
const STAR_COUNT = 6000;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let previewGlow = null;
let skySphere = null;
let skyStars = null;
let skyNebula = null;
let placed = false;
let isInside = false;

// 过渡效果
let transitionProgress = 0; // 0=门外, 1=门内
let transitionTarget = 0;
let fadeOverlay = null;

// 门平面参数
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1;

const _camPos = new THREE.Vector3();

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

  // Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // 过渡遮罩（用于进出门淡入淡出）
  createFadeOverlay();

  // 控制器
  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  document.body.appendChild(
    ARButton.createButton(renderer, { requiredFeatures: ["hit-test"] })
  );

  // Reset按钮
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

// ============ 过渡遮罩 ============
function createFadeOverlay() {
  fadeOverlay = document.createElement("div");
  fadeOverlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: radial-gradient(ellipse at center, rgba(20,10,40,0) 0%, rgba(10,5,30,0.9) 100%);
    pointer-events: none; opacity: 0; z-index: 999;
    transition: opacity 0.3s ease;
  `;
  document.body.appendChild(fadeOverlay);
}

// ============ 创建星星纹理 ============
function createStarTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.1, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.4, "rgba(200,220,255,0.3)");
  gradient.addColorStop(1, "rgba(100,150,255,0)");
  
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建星星粒子 ============
function createStars(count, radius, size = 0.15) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    // 随机颜色：白/蓝/黄
    const colorType = Math.random();
    if (colorType < 0.6) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (colorType < 0.8) {
      colors[i * 3] = 0.7; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 1;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.9; colors[i * 3 + 2] = 0.6;
    }
    
    sizes[i] = size * (0.5 + Math.random());
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  
  const mat = new THREE.PointsMaterial({
    map: createStarTexture(),
    size,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

// ============ 创建薄雾/星云 ============
function createNebula(count, radius) {
  const group = new THREE.Group();
  
  for (let i = 0; i < count; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    
    // 随机色相
    const hue = Math.random() * 360;
    
    for (let j = 0; j < 5; j++) {
      const x = 128 + (Math.random() - 0.5) * 100;
      const y = 128 + (Math.random() - 0.5) * 100;
      const r = 60 + Math.random() * 60;
      
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, `hsla(${hue + j * 20}, 60%, 50%, 0.15)`);
      gradient.addColorStop(0.5, `hsla(${hue + j * 20}, 50%, 40%, 0.05)`);
      gradient.addColorStop(1, "transparent");
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 256);
    }
    
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(15, 15), mat);
    mesh.position.set(
      (Math.random() - 0.5) * radius,
      (Math.random() - 0.5) * radius * 0.6,
      (Math.random() - 0.5) * radius
    );
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  
  return group;
}

// ============ 创建门框边缘辉光 ============
function createPortalGlow() {
  const group = new THREE.Group();
  
  // 拱形辉光路径
  const shape = new THREE.Shape();
  const w = 1.5, h = 1.8, archR = 0.75;
  shape.moveTo(-w/2, 0);
  shape.lineTo(-w/2, h - archR);
  shape.absarc(0, h - archR, archR, Math.PI, 0, true);
  shape.lineTo(w/2, 0);
  
  // 内发光（多层叠加）
  for (let i = 0; i < 4; i++) {
    const glowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.7 - i * 0.05, 0.8, 0.5 + i * 0.1),
      transparent: true,
      opacity: 0.15 - i * 0.03,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    
    const geo = new THREE.ShapeGeometry(shape, 32);
    const mesh = new THREE.Mesh(geo, glowMat);
    mesh.position.z = -0.02 - i * 0.01;
    mesh.scale.setScalar(1 + i * 0.08);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  
  // 边缘光线
  const edgeGeo = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3([
      new THREE.Vector3(-w/2, 0, 0),
      new THREE.Vector3(-w/2, h - archR, 0),
      new THREE.Vector3(-archR * 0.7, h - archR + archR * 0.7, 0),
      new THREE.Vector3(0, h, 0),
      new THREE.Vector3(archR * 0.7, h - archR + archR * 0.7, 0),
      new THREE.Vector3(w/2, h - archR, 0),
      new THREE.Vector3(w/2, 0, 0),
    ]),
    64, 0.03, 8, false
  );
  const edgeMat = new THREE.MeshBasicMaterial({
    color: 0x8080ff,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
  });
  const edge = new THREE.Mesh(edgeGeo, edgeMat);
  edge.position.z = -0.01;
  group.add(edge);
  
  return group;
}

// ============ 构建场景 ============
function build() {
  const panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  panoTexture.colorSpace = THREE.SRGBColorSpace;

  // === 门框组 ===
  doorGroup = new THREE.Group();
  scene.add(doorGroup);

  // 加载门模型
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
      // 备用门框
      const mat = new THREE.MeshBasicMaterial({ color: 0x222222 });
      const left = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
      left.position.set(-0.65, DOOR_HEIGHT / 2, 0);
      const right = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
      right.position.set(0.65, DOOR_HEIGHT / 2, 0);
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.1), mat);
      top.position.set(0, DOOR_HEIGHT, 0);
      doorGroup.add(left, right, top);
    }
  );

  // === 门洞 stencil 遮罩 ===
  const maskShape = new THREE.Shape();
  const mw = 1.4, mh = 1.85, archR = 0.7;
  maskShape.moveTo(-mw/2, 0);
  maskShape.lineTo(-mw/2, mh - archR);
  maskShape.absarc(0, mh - archR, archR, Math.PI, 0, true);
  maskShape.lineTo(mw/2, 0);
  maskShape.closePath();

  const maskMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
  });
  maskMat.stencilWrite = true;
  maskMat.stencilRef = 1;
  maskMat.stencilFunc = THREE.AlwaysStencilFunc;
  maskMat.stencilZPass = THREE.ReplaceStencilOp;

  portalMask = new THREE.Mesh(new THREE.ShapeGeometry(maskShape, 32), maskMat);
  portalMask.position.set(0, 0.02, -0.02);
  portalMask.renderOrder = 0;
  doorGroup.add(portalMask);

  // === 门框边缘辉光 ===
  previewGlow = createPortalGlow();
  previewGlow.position.y = 0.02;
  doorGroup.add(previewGlow);

  // === 门外预览：天球（受stencil限制）===
  const previewMat = new THREE.MeshBasicMaterial({
    map: panoTexture,
    side: THREE.BackSide,
    depthWrite: false,
  });
  previewMat.stencilWrite = true;
  previewMat.stencilRef = 1;
  previewMat.stencilFunc = THREE.EqualStencilFunc;

  previewSphere = new THREE.Mesh(
    new THREE.SphereGeometry(PREVIEW_RADIUS, 48, 32),
    previewMat
  );
  previewSphere.renderOrder = 1;
  previewSphere.frustumCulled = false;
  doorGroup.add(previewSphere);

  // === 门外预览：星星（受stencil限制）===
  previewStars = createStars(1500, PREVIEW_RADIUS * 0.9, 0.08);
  previewStars.material.stencilWrite = true;
  previewStars.material.stencilRef = 1;
  previewStars.material.stencilFunc = THREE.EqualStencilFunc;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

  // === 门内世界：天球 ===
  skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 64, 32),
    new THREE.MeshBasicMaterial({
      map: panoTexture,
      side: THREE.BackSide,
      depthWrite: false,
    })
  );
  skySphere.visible = false;
  skySphere.renderOrder = -100;
  scene.add(skySphere);

  // === 门内世界：星星 ===
  skyStars = createStars(STAR_COUNT, SKY_RADIUS * 0.85, 0.2);
  skyStars.visible = false;
  skyStars.renderOrder = -99;
  scene.add(skyStars);

  // === 门内世界：星云/薄雾 ===
  skyNebula = createNebula(10, SKY_RADIUS * 0.5);
  skyNebula.visible = false;
  skyNebula.renderOrder = -98;
  scene.add(skyNebula);
}

// ============ 放置门 ============
function onSelect() {
  if (placed || !reticle.visible) return;
  if (!doorGroup) build();

  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);

  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  const dir = new THREE.Vector3(_camPos.x - hitPos.x, 0, _camPos.z - hitPos.z).normalize();
  
  doorGroup.position.copy(hitPos).addScaledVector(dir, -DOOR_DISTANCE);
  doorGroup.position.y = hitPos.y;
  doorGroup.lookAt(_camPos.x, doorGroup.position.y, _camPos.z);

  // 预览球放在门后一点
  previewSphere.position.set(0, 1, -PREVIEW_RADIUS * 0.5);
  previewStars.position.set(0, 1, -PREVIEW_RADIUS * 0.5);

  // 门平面
  doorPlanePoint.copy(doorGroup.position);
  doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);

  lastSide = getSide(xrCam);
  isInside = false;
  transitionTarget = 0;
  placed = true;
  reticle.visible = false;
}

// ============ 判断相机位置 ============
function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  return doorPlaneNormal.dot(toCamera) >= 0 ? 1 : -1;
}

// ============ 检测穿越 ============
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

// ============ 更新过渡效果 ============
function updateTransition(delta) {
  const speed = 4.0; // 过渡速度
  
  if (transitionProgress < transitionTarget) {
    transitionProgress = Math.min(transitionProgress + delta * speed, 1);
  } else if (transitionProgress > transitionTarget) {
    transitionProgress = Math.max(transitionProgress - delta * speed, 0);
  }
  
  // 过渡时显示遮罩（只在中间最不透明）
  const fadeAmount = Math.sin(transitionProgress * Math.PI) * 0.6;
  fadeOverlay.style.opacity = fadeAmount;
  
  // 根据过渡进度控制可见性
  const entering = transitionProgress > 0.5;
  skySphere.visible = entering;
  skyStars.visible = entering;
  skyNebula.visible = entering;
  
  // 门外预览在完全进入后隐藏
  const showPreview = transitionProgress < 0.9;
  previewSphere.visible = showPreview;
  previewStars.visible = showPreview;
  portalMask.visible = showPreview;
  previewGlow.visible = showPreview;
}

// ============ 渲染 ============
let lastTime = performance.now();

function render(_, frame) {
  const now = performance.now();
  const delta = (now - lastTime) / 1000;
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

  // 更新状态
  if (placed) {
    checkCrossing(xrCam);
    updateTransition(delta);

    // 门内世界跟随相机
    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    skyStars.position.copy(_camPos);
    skyNebula.position.copy(_camPos);
    
    // 星星缓慢旋转
    if (skyStars.visible) {
      skyStars.rotation.y += delta * 0.01;
    }
    if (previewStars.visible) {
      previewStars.rotation.y += delta * 0.02;
    }
  }

  // === 渲染 ===
  renderer.clear(true, true, true);
  
  if (!placed || transitionProgress < 0.95) {
    // 门外或过渡中：渲染门框 + stencil预览
    renderer.render(scene, xrCam);
  }
  
  if (transitionProgress > 0.05) {
    // 进入中或门内：渲染沉浸世界
    renderer.clearDepth();
    renderer.render(scene, xrCam);
  }
}

// ============ 重置 ============
function reset() {
  placed = false;
  isInside = false;
  transitionProgress = 0;
  transitionTarget = 0;
  fadeOverlay.style.opacity = 0;
  
  if (doorGroup) { scene.remove(doorGroup); doorGroup = null; }
  if (skySphere) { skySphere.visible = false; }
  if (skyStars) { skyStars.visible = false; }
  if (skyNebula) { skyNebula.visible = false; }
  
  reticle.visible = false;
}
