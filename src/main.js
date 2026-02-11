import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

/* =========================
   参数配置
========================= */
const CONFIG = {
  // 门参数
  doorTargetHeight: 2.10,
  placeDistance: 1.60,
  doorScaleMult: 0.90,
  doorYawOffset: Math.PI / 2,

  // 门洞参数
  hole: {
    width: 1.48,
    height: 1.52,
    centerY: 0.88,
  },

  // 星空世界参数
  portalWorldOffset: 3.5, // 虚拟世界原点在门后多远
  skyRadius: 80,          // 天球半径
  starCount: 8000,
  nebulaCount: 12,

  // 过门检测
  enterThreshold: 0.05,
  exitThreshold: 0.15,
  transitionCooldown: 500,
};

/* =========================
   图层定义
========================= */
const LAYER = {
  DEFAULT: 0,    // 门框 + reticle
  MASK: 1,       // stencil 写入
  PORTAL: 2,     // 门内世界（受stencil或全屏）
};

/* =========================
   全局状态
========================= */
let scene, renderer, camera, controller;
let hitTestSource = null, hitTestSourceRequested = false;
let reticle;

// 门相关
let doorModel = null;
let doorGroup = null;      // 门的根节点（position + lookAt）
let doorMesh = null;       // 门框视觉
let portalMask = null;     // stencil mask

// 星空世界（关键：作为scene的直接子节点，不是doorGroup的子节点）
let portalWorld = null;
let portalWorldAnchor = new THREE.Vector3(); // 世界坐标中虚拟世界的原点

// 状态
let placed = false;
let isInside = false;
let frontSign = 1;
let prevSignedDist = 0;
let lastTransitionTime = 0;

// 纹理
let panoTexture = null;

// 临时变量
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/* =========================
   初始化
========================= */
init();

function init() {
  // Scene
  scene = new THREE.Scene();

  // Camera
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 200);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);

  // Lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(2, 4, 2);
  scene.add(dirLight);

  // Reticle (放置指示器)
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.12, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.layers.set(LAYER.DEFAULT);
  scene.add(reticle);

  // Controller
  controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  // 加载门模型
  loadDoorModel();

  // AR Button
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: document.body },
    })
  );

  // UI
  createUI();

  // Resize
  addEventListener("resize", onResize);

  // Animation Loop
  renderer.setAnimationLoop(render);
}

function createUI() {
  // Reset 按钮
  const btn = document.createElement("button");
  btn.textContent = "🔄 Reset";
  Object.assign(btn.style, {
    position: "fixed", top: "12px", left: "12px", zIndex: 9999,
    padding: "10px 16px", fontSize: "14px", borderRadius: "8px",
    border: "none", background: "rgba(0,0,0,0.5)", color: "#fff",
    backdropFilter: "blur(4px)", cursor: "pointer"
  });
  btn.onclick = reset;
  document.body.appendChild(btn);

  // 状态指示
  const status = document.createElement("div");
  status.id = "status";
  Object.assign(status.style, {
    position: "fixed", bottom: "20px", left: "50%", transform: "translateX(-50%)",
    zIndex: 9999, padding: "8px 16px", fontSize: "14px", borderRadius: "20px",
    background: "rgba(0,0,0,0.6)", color: "#fff", backdropFilter: "blur(4px)"
  });
  status.textContent = "点击地面放置传送门";
  document.body.appendChild(status);
}

function updateStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

/* =========================
   模型加载
========================= */
function loadDoorModel() {
  new GLTFLoader().load(
    `${BASE}models/doorframe.glb`,
    (gltf) => {
      doorModel = gltf.scene;
      normalizeModel(doorModel, CONFIG.doorTargetHeight);
    },
    undefined,
    (err) => console.warn("门模型加载失败，将使用备用门框", err)
  );
}

function normalizeModel(model, targetHeight) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);

  if (size.y > 0) {
    const scale = targetHeight / size.y;
    model.scale.setScalar(scale);

    box.setFromObject(model);
    const center = new THREE.Vector3();
    box.getCenter(center);

    model.position.set(-center.x, -box.min.y, -center.z);
  }
}

/* =========================
   纹理
========================= */
function getPanoTexture() {
  if (!panoTexture) {
    panoTexture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
    panoTexture.colorSpace = THREE.SRGBColorSpace;
    panoTexture.mapping = THREE.EquirectangularReflectionMapping;
  }
  return panoTexture;
}

/* =========================
   创建星空世界
========================= */
function createPortalWorld() {
  const group = new THREE.Group();
  group.layers.set(LAYER.PORTAL);

  // 全景天球
  const skyGeo = new THREE.SphereGeometry(CONFIG.skyRadius, 64, 48);
  const skyMat = new THREE.MeshBasicMaterial({
    map: getPanoTexture(),
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.layers.set(LAYER.PORTAL);
  sky.renderOrder = -1000;
  group.add(sky);

  // 星星粒子
  const stars = createStars(CONFIG.starCount, CONFIG.skyRadius * 0.85);
  stars.layers.set(LAYER.PORTAL);
  group.add(stars);

  // 星云
  for (let i = 0; i < CONFIG.nebulaCount; i++) {
    const nebula = createNebula(i);
    nebula.position.set(
      (Math.random() - 0.5) * 50,
      (Math.random() - 0.3) * 30,
      (Math.random() - 0.5) * 50
    );
    nebula.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI
    );
    nebula.layers.set(LAYER.PORTAL);
    group.add(nebula);
  }

  return group;
}

function createStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    // 均匀球面分布
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.7 + 0.3 * Math.random());

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

    // 随机颜色（偏白/蓝/黄）
    const temp = Math.random();
    if (temp < 0.7) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (temp < 0.85) {
      colors[i * 3] = 0.7; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 1;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.7;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.15,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    sizeAttenuation: true,
    depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}

function createNebula(seed) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d");

  // 随机颜色
  const hue = (seed * 47) % 360;
  for (let i = 0; i < 8; i++) {
    const x = 128 + Math.sin(seed + i * 0.7) * 60;
    const y = 128 + Math.cos(seed + i * 1.1) * 60;
    const r = 50 + i * 12;

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, `hsla(${hue + i * 15}, 70%, 60%, 0.15)`);
    gradient.addColorStop(0.5, `hsla(${hue + i * 15}, 60%, 50%, 0.05)`);
    gradient.addColorStop(1, "transparent");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(15, 15), mat);
  mesh.frustumCulled = false;
  return mesh;
}

/* =========================
   创建门洞遮罩（拱形）
========================= */
function createArchMask(width, height) {
  const w = width;
  const h = height;
  const archRadius = w / 2;
  const rectHeight = Math.max(0.01, h - archRadius);

  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(-w / 2, rectHeight);
  shape.absarc(0, rectHeight, archRadius, Math.PI, 0, true);
  shape.lineTo(w / 2, 0);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape, 32);
  const mat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
  });

  // Stencil 设置：写入 ref=1
  mat.stencilWrite = true;
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.AlwaysStencilFunc;
  mat.stencilZPass = THREE.ReplaceStencilOp;
  mat.stencilZFail = THREE.ReplaceStencilOp;
  mat.stencilFail = THREE.ReplaceStencilOp;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.layers.set(LAYER.MASK);
  mesh.frustumCulled = false;
  return mesh;
}

/* =========================
   构建场景
========================= */
function buildScene() {
  // === 门组（包含门框和mask）===
  doorGroup = new THREE.Group();
  scene.add(doorGroup);

  // 门框视觉
  const visualGroup = new THREE.Group();
  visualGroup.rotation.y = CONFIG.doorYawOffset;
  visualGroup.scale.setScalar(CONFIG.doorScaleMult);

  if (doorModel) {
    visualGroup.add(doorModel.clone(true));
  } else {
    // 备用门框
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
    const h = CONFIG.doorTargetHeight;
    const postW = 0.12, spanW = 1.2, depth = 0.1;

    const left = new THREE.Mesh(new THREE.BoxGeometry(postW, h, depth), frameMat);
    left.position.set(-spanW / 2, h / 2, 0);
    visualGroup.add(left);

    const right = new THREE.Mesh(new THREE.BoxGeometry(postW, h, depth), frameMat);
    right.position.set(spanW / 2, h / 2, 0);
    visualGroup.add(right);

    const top = new THREE.Mesh(new THREE.BoxGeometry(spanW + postW, postW, depth), frameMat);
    top.position.set(0, h, 0);
    visualGroup.add(top);
  }

  visualGroup.traverse(obj => obj.layers?.set(LAYER.DEFAULT));
  doorGroup.add(visualGroup);
  doorMesh = visualGroup;

  // 门洞遮罩
  portalMask = createArchMask(CONFIG.hole.width, CONFIG.hole.height);
  portalMask.position.set(0, CONFIG.hole.centerY, -0.02); // 略微在门后
  doorGroup.add(portalMask);

  // === 星空世界（关键：独立于门，在scene下）===
  portalWorld = createPortalWorld();
  scene.add(portalWorld);

  // 设置星空世界的 stencil 读取
  portalWorld.traverse(obj => {
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(mat => {
        mat.stencilWrite = true;
        mat.stencilRef = 1;
        mat.stencilFunc = THREE.EqualStencilFunc;
        mat.stencilFail = THREE.KeepStencilOp;
        mat.stencilZFail = THREE.KeepStencilOp;
        mat.stencilZPass = THREE.KeepStencilOp;
      });
    }
  });
}

/* =========================
   放置门
========================= */
function onSelect() {
  if (placed || !reticle.visible) return;

  // 首次构建
  if (!doorGroup) buildScene();

  const xrCam = renderer.xr.getCamera(camera);

  // 门的位置（在用户前方地面上）
  const hitPos = _v.setFromMatrixPosition(reticle.matrix);
  xrCam.getWorldPosition(_v2);

  const dir = _v2.clone().sub(hitPos);
  dir.y = 0;
  dir.normalize();

  // 门放在用户前方指定距离
  const doorPos = _v2.clone();
  doorPos.y = hitPos.y;
  doorPos.addScaledVector(dir, -CONFIG.placeDistance);

  doorGroup.position.copy(doorPos);

  // 门朝向用户
  const lookTarget = _v2.clone();
  lookTarget.y = doorPos.y;
  doorGroup.lookAt(lookTarget);

  // 计算虚拟世界锚点（门后方）
  const doorForward = new THREE.Vector3(0, 0, -1).applyQuaternion(doorGroup.quaternion);
  portalWorldAnchor.copy(doorPos).addScaledVector(doorForward, CONFIG.portalWorldOffset);
  portalWorldAnchor.y = doorPos.y; // 保持在地面高度

  // 初始化虚拟世界位置和旋转
  portalWorld.position.copy(portalWorldAnchor);
  portalWorld.quaternion.copy(doorGroup.quaternion);

  // 确定门前侧
  xrCam.getWorldPosition(_v);
  const localCam = doorGroup.worldToLocal(_v.clone());
  frontSign = localCam.z >= 0 ? 1 : -1;
  prevSignedDist = localCam.z * frontSign;

  placed = true;
  isInside = false;
  lastTransitionTime = 0;
  reticle.visible = false;

  updateStatus("走向传送门并穿过它！");
}

/* =========================
   更新过门状态
========================= */
function updatePortalState(xrCam) {
  if (!placed || !doorGroup) return;

  xrCam.getWorldPosition(_v);
  const localCam = doorGroup.worldToLocal(_v.clone());

  const signedDist = localCam.z * frontSign; // >0 在门前，<0 在门后
  const now = performance.now();

  // 检查是否在门洞范围内
  const inHoleArea =
    Math.abs(localCam.x) < CONFIG.hole.width * 0.6 &&
    localCam.y > 0 && localCam.y < CONFIG.hole.height + 0.3 &&
    Math.abs(localCam.z) < 1.5;

  if (now - lastTransitionTime > CONFIG.transitionCooldown) {
    if (!isInside) {
      // 门外 -> 门内：从前方穿过到后方
      if (prevSignedDist >= 0 && signedDist < -CONFIG.enterThreshold && inHoleArea) {
        isInside = true;
        lastTransitionTime = now;
        updateStatus("欢迎来到星空世界！环顾四周探索吧");
      }
    } else {
      // 门内 -> 门外：从后方穿回前方
      if (prevSignedDist <= 0 && signedDist > CONFIG.exitThreshold && inHoleArea) {
        isInside = false;
        lastTransitionTime = now;
        updateStatus("你已返回现实世界");
      }
    }
  }

  prevSignedDist = signedDist;

  // 🔑 关键：门内时，星空世界跟随用户但保持原始旋转
  if (isInside) {
    xrCam.getWorldPosition(_v);
    portalWorld.position.copy(_v);
    // 旋转保持不变（与放门时一致），确保方向连续
  } else {
    // 门外时，星空世界锚定在门后
    portalWorld.position.copy(portalWorldAnchor);
  }
}

/* =========================
   Hit Test
========================= */
function updateHitTest(frame) {
  const session = renderer.xr.getSession();
  const refSpace = renderer.xr.getReferenceSpace();

  if (!hitTestSourceRequested) {
    session.requestReferenceSpace("viewer").then(viewerSpace => {
      session.requestHitTestSource({ space: viewerSpace }).then(source => {
        hitTestSource = source;
      });
    });

    session.addEventListener("end", () => {
      hitTestSource?.cancel?.();
      hitTestSource = null;
      hitTestSourceRequested = false;
      reset();
    });

    hitTestSourceRequested = true;
  }

  if (hitTestSource) {
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(refSpace);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      reticle.visible = false;
    }
  }
}

/* =========================
   渲染 - 核心逻辑
========================= */
function render(_, frame) {
  if (frame && !placed) updateHitTest(frame);

  const xrCam = renderer.xr.getCamera(camera);
  if (placed) updatePortalState(xrCam);

  // === 清除所有缓冲 ===
  renderer.clear(true, true, true);

  // === 辅助函数：设置相机图层 ===
  const setCamLayers = (cam, ...layers) => {
    cam.layers.disableAll();
    layers.forEach(l => cam.layers.enable(l));
    if (cam.cameras) cam.cameras.forEach(c => {
      c.layers.disableAll();
      layers.forEach(l => c.layers.enable(l));
    });
  };

  if (!placed) {
    // 未放置：只渲染默认层（reticle）
    setCamLayers(xrCam, LAYER.DEFAULT);
    renderer.render(scene, xrCam);
    return;
  }

  if (isInside) {
    // ========== 门内：全屏星空 ==========
    // 禁用星空世界的 stencil 测试（全屏渲染）
    portalWorld.traverse(obj => {
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(mat => {
          mat.stencilWrite = false;
          mat.stencilFunc = THREE.AlwaysStencilFunc;
        });
      }
    });

    // 1. 先渲染星空世界（背景）
    renderer.clearDepth();
    setCamLayers(xrCam, LAYER.PORTAL);
    renderer.render(scene, xrCam);

    // 2. 再渲染门框（可选：让用户能看到出口）
    setCamLayers(xrCam, LAYER.DEFAULT);
    renderer.render(scene, xrCam);

  } else {
    // ========== 门外：通过门洞看星空 ==========
    // 启用星空世界的 stencil 测试
    portalWorld.traverse(obj => {
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(mat => {
          mat.stencilWrite = true;
          mat.stencilRef = 1;
          mat.stencilFunc = THREE.EqualStencilFunc;
        });
      }
    });

    // 1. 渲染门框和 reticle（现实世界叠加）
    setCamLayers(xrCam, LAYER.DEFAULT);
    renderer.render(scene, xrCam);

    // 2. 写入门洞 stencil mask
    renderer.clearStencil();
    setCamLayers(xrCam, LAYER.MASK);
    renderer.render(scene, xrCam);

    // 3. 渲染星空（只在门洞内可见）
    setCamLayers(xrCam, LAYER.PORTAL);
    renderer.render(scene, xrCam);
  }
}

/* =========================
   重置
========================= */
function reset() {
  placed = false;
  isInside = false;
  reticle.visible = false;

  if (doorGroup) scene.remove(doorGroup);
  if (portalWorld) scene.remove(portalWorld);

  doorGroup = null;
  portalMask = null;
  portalWorld = null;

  updateStatus("点击地面放置传送门");
}

/* =========================
   窗口调整
========================= */
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
