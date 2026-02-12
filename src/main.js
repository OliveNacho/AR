import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;
const STAR_COUNT = 5000;
const FLOATING_STAR_COUNT = 1200;
const BRIGHT_STAR_COUNT = 50;
const PREVIEW_STAR_COUNT = 5000;
const AMBIENT_STAR_COUNT = 300;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let ambientStars = null;
let skySphere = null;
let skyStars = null;
let floatingStars = null;
let brightStars = null;
let nebulaPlane = null;
let moonModel = null;
let earthModel = null;
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

  // 加载用户提供的星星纹理
  const texLoader = new THREE.TextureLoader();
  starSpriteTexture = texLoader.load(`${BASE}textures/stars.png`);
  starSpriteTexture.colorSpace = THREE.SRGBColorSpace;
  
  starTexture = createCleanStarTexture();

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
    if (touchPoints.length > 20) touchPoints.shift();
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

// ============ 干净的星星纹理 ============
function createCleanStarTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  const gradient = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.1, "rgba(255,255,255,0.9)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.4)");
  gradient.addColorStop(0.6, "rgba(255,255,255,0.1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建普通星星 ============
function createStars(count, radius, baseSize = 0.2, useStencil = false) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  // 星星颜色：白、蓝、金
  const starColors = [
    [1, 1, 1],           // 纯白
    [0.9, 0.95, 1],      // 冷白
    [0.7, 0.85, 1],      // 淡蓝
    [0.6, 0.8, 1],       // 蓝色
    [1, 0.95, 0.8],      // 暖白
    [1, 0.9, 0.6],       // 淡金
    [1, 0.85, 0.5],      // 金色
  ];
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.7 + 0.3 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const colorIdx = Math.floor(Math.random() * starColors.length);
    const c = starColors[colorIdx];
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

// ============ 创建浮动星星 ============
function createFloatingStars(count, minR, maxR, baseSize = 0.3) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  const starColors = [
    [1, 1, 1],
    [0.8, 0.9, 1],
    [1, 0.95, 0.7],
  ];
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = minR + Math.random() * (maxR - minR);
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = starColors[Math.floor(Math.random() * starColors.length)];
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
    
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

// ============ 创建亮星（使用用户提供的纹理）============
function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 2);
  
  const brightColors = [
    [1, 1, 1],       // 白
    [0.7, 0.85, 1],  // 蓝
    [1, 0.9, 0.5],   // 金
  ];
  
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
    phases[i * 2 + 1] = 0.2 + Math.random() * 0.8;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starSpriteTexture,
    size: 1.5,
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

// ============ 创建门外环境星星 ============
function createAmbientStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    // 分布在门附近区域
    const x = (Math.random() - 0.5) * 6;
    const y = 0.5 + Math.random() * 3;
    const z = -1 - Math.random() * 4;
    
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    
    const brightness = 0.6 + Math.random() * 0.4;
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness;
    colors[i * 3 + 2] = brightness;
    
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
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  
  return { points, positions: positions.slice(), colors: colors.slice(), phases };
}

// ============ 更新星星动画 ============
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
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.2 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.15 + p1) * drift * 0.5;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.sin(time * 0.18 + p3) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新浮动星星 ============
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
    col[i * 3] = colors[i * 3] * twinkle;
    col[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    col[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    const drift = 0.6;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.1 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.sin(time * 0.08 + p1) * drift * 0.5;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.cos(time * 0.12 + p3) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新亮星 ============
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

// ============ 电影级流星 ============
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
    .addScaledVector(camForward, 0.15)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(15))
    .add(new THREE.Vector3((Math.random() - 0.5) * 8, 3 + Math.random() * 6, (Math.random() - 0.5) * 8));
  
  const meteor = createCinematicMeteor(spawnPos, dir3D);
  scene.add(meteor);
  meteors.push(meteor);
}

function createCinematicMeteor(pos, dir) {
  const group = new THREE.Group();
  group.position.copy(pos);
  
  // 让整个流星朝向飞行方向
  const up = new THREE.Vector3(0, 1, 0);
  const quaternion = new THREE.Quaternion();
  const lookMatrix = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up);
  quaternion.setFromRotationMatrix(lookMatrix);
  group.quaternion.copy(quaternion);
  
  // 流星头部 - 使用拉伸的网格实现椭圆
  const headGeo = new THREE.SphereGeometry(0.1, 16, 16);
  headGeo.scale(0.6, 0.6, 1.5); // 沿Z轴（飞行方向）拉伸
  
  const headMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
  });
  const head = new THREE.Mesh(headGeo, headMat);
  group.add(head);
  
  // 头部光晕
  const glowGeo = new THREE.SphereGeometry(0.2, 16, 16);
  glowGeo.scale(0.8, 0.8, 1.8);
  
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffeedd,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  group.add(glow);
  
  // 外层柔和光晕
  const outerGlowGeo = new THREE.SphereGeometry(0.35, 16, 16);
  outerGlowGeo.scale(0.7, 0.7, 2.0);
  
  const outerGlowMat = new THREE.MeshBasicMaterial({
    color: 0xffddaa,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const outerGlow = new THREE.Mesh(outerGlowGeo, outerGlowMat);
  group.add(outerGlow);
  
  // 拖尾 - 细管道
  const tailLength = 2.5 + Math.random() * 1.5;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0.15),
    new THREE.Vector3(0, 0, -tailLength * 0.3),
    new THREE.Vector3(0, 0, -tailLength * 0.6),
    new THREE.Vector3(0, 0, -tailLength),
  ]);
  
  const tailGeo = new THREE.TubeGeometry(curve, 50, 0.025, 8, false);
  const tailMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float t = vUv.x;
        float fade = pow(1.0 - t, 2.0);
        
        vec3 col;
        if (t < 0.1) {
          col = vec3(1.0, 1.0, 1.0);
        } else if (t < 0.35) {
          float b = (t - 0.1) / 0.25;
          col = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.95, 0.75), b);
        } else if (t < 0.65) {
          float b = (t - 0.35) / 0.3;
          col = mix(vec3(1.0, 0.95, 0.75), vec3(0.85, 0.75, 0.6), b);
        } else {
          float b = (t - 0.65) / 0.35;
          col = mix(vec3(0.85, 0.75, 0.6), vec3(0.5, 0.6, 0.8), b);
        }
        
        float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
        edge = smoothstep(0.0, 0.6, edge);
        
        gl_FragColor = vec4(col, fade * edge * uOpacity);
      }
    `,
  });
  
  const tail = new THREE.Mesh(tailGeo, tailMat);
  group.add(tail);
  
  // 细碎火花（更少更小）
  const sparkCount = 12;
  const sparkPos = new Float32Array(sparkCount * 3);
  const sparkCol = new Float32Array(sparkCount * 3);
  
  for (let i = 0; i < sparkCount; i++) {
    const t = Math.random() * 0.4;
    const spread = t * 0.08;
    sparkPos[i * 3] = (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 1] = (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 2] = -t * tailLength;
    
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
    size: 0.04,
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  group.add(sparks);
  
  group.userData = {
    direction: dir.clone(),
    speed: 3 + Math.random() * 2,
    life: 0,
    maxLife: 6 + Math.random() * 3,
    headMat,
    glowMat,
    outerGlowMat,
    tailMat,
    sparkMat,
  };
  
  return group;
}

function updateMeteors(delta) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    const d = m.userData;
    
    d.life += delta;
    
    // 沿世界坐标方向移动
    m.position.addScaledVector(d.direction, d.speed * delta);
    
    const progress = d.life / d.maxLife;
    let fade;
    if (progress < 0.08) {
      fade = progress / 0.08;
    } else {
      fade = Math.pow(1 - (progress - 0.08) / 0.92, 0.5);
    }
    
    d.headMat.opacity = fade;
    d.glowMat.opacity = fade * 0.6;
    d.outerGlowMat.opacity = fade * 0.3;
    d.tailMat.uniforms.uOpacity.value = fade;
    d.sparkMat.opacity = fade * 0.7;
    
    if (d.life >= d.maxLife) {
      scene.remove(m);
      meteors.splice(i, 1);
    }
  }
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
  previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.9, 0.12, true);
  previewStars = previewStarData.points;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

  // 门外环境星星（不受stencil限制）
  ambientStarData = createAmbientStars(AMBIENT_STAR_COUNT);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

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

  // 门内球面星星
  starData = createStars(STAR_COUNT, SKY_RADIUS * 0.9, 0.25, false);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = -99;
  scene.add(skyStars);

  // 门内浮动星星
  floatingStarData = createFloatingStars(FLOATING_STAR_COUNT, SKY_RADIUS * 0.15, SKY_RADIUS * 0.5, 0.3);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = -98;
  scene.add(floatingStars);

  // 门内亮星
  brightStarData = createBrightStars(BRIGHT_STAR_COUNT, SKY_RADIUS * 0.85);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = -97;
  scene.add(brightStars);

  // 加载星云
  const nebulaTexture = texLoader.load(`${BASE}textures/nebula.png`);
  nebulaTexture.colorSpace = THREE.SRGBColorSpace;
  
  const nebulaMat = new THREE.MeshBasicMaterial({
    map: nebulaTexture,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  
  nebulaPlane = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), nebulaMat);
  nebulaPlane.position.set(15, 10, -35);
  nebulaPlane.lookAt(0, 0, 0);
  nebulaPlane.renderOrder = -96;
  scene.add(nebulaPlane);

  // 加载月球
  gltfLoader.load(`${BASE}models/moon.glb`, (gltf) => {
    moonModel = gltf.scene;
    moonModel.scale.setScalar(2);
    moonModel.position.set(-20, 15, -30);
    moonModel.visible = false;
    moonModel.traverse((child) => {
      if (child.isMesh) {
        child.material.transparent = true;
        child.material.opacity = 0;
      }
    });
    scene.add(moonModel);
  });

  // 加载地球
  gltfLoader.load(`${BASE}models/earth.glb`, (gltf) => {
    earthModel = gltf.scene;
    earthModel.scale.setScalar(4);
    earthModel.position.set(25, -5, -40);
    earthModel.visible = false;
    earthModel.traverse((child) => {
      if (child.isMesh) {
        child.material.transparent = true;
        child.material.opacity = 0;
      }
    });
    scene.add(earthModel);
  });
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
  transitionValue = 0;
  placed = true;
  reticle.visible = false;

  playAudio();
}

function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  return doorPlaneNormal.dot(_camPos.clone().sub(doorPlanePoint)) >= 0 ? 1 : -1;
}

// ============ 修复过渡 ============
function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  const signedDist = doorPlaneNormal.dot(toCamera);
  
  const currentSide = signedDist >= 0 ? 1 : -1;
  
  // 只在真正穿过时切换状态
  if (lastSide === 1 && currentSide === -1 && !isInside) {
    isInside = true;
  } else if (lastSide === -1 && currentSide === 1 && isInside) {
    isInside = false;
  }
  lastSide = currentSide;
  
  // 目标值
  const target = isInside ? 1 : 0;
  
  // 非常平滑的过渡
  const speed = 1.5;
  const diff = target - transitionValue;
  transitionValue += diff * delta * speed;
  
  // 钳制
  transitionValue = Math.max(0, Math.min(1, transitionValue));
  
  // 使用更平滑的 smootherstep
  const t = transitionValue;
  const smooth = t * t * t * (t * (t * 6 - 15) + 10);
  
  // 门内世界透明度
  const insideOpacity = smooth;
  if (skySphere) skySphere.material.opacity = insideOpacity;
  if (skyStars) skyStars.material.opacity = insideOpacity;
  if (floatingStars) floatingStars.material.opacity = insideOpacity;
  if (brightStars) brightStars.material.opacity = insideOpacity;
  if (nebulaPlane) nebulaPlane.material.opacity = insideOpacity * 0.4;
  
  // 天体
  if (moonModel) {
    moonModel.visible = insideOpacity > 0.01;
    moonModel.traverse((child) => {
      if (child.isMesh) child.material.opacity = insideOpacity;
    });
  }
  if (earthModel) {
    earthModel.visible = insideOpacity > 0.01;
    earthModel.traverse((child) => {
      if (child.isMesh) child.material.opacity = insideOpacity;
    });
  }
  
  // 预览透明度 - 交叉淡化
  const previewOpacity = 1 - smooth;
  if (previewSphere) previewSphere.material.opacity = previewOpacity;
  if (previewStars) previewStars.material.opacity = previewOpacity;
  
  // 环境星星在门外时显示
  if (ambientStars) ambientStars.material.opacity = previewOpacity * 0.7;
  
  // 遮罩可见性
  if (portalMask) portalMask.visible = smooth < 0.99;
}

// ============ 更新天体自转 ============
function updateCelestialBodies(delta) {
  if (moonModel) {
    moonModel.rotation.y += delta * 0.1;
  }
  if (earthModel) {
    earthModel.rotation.y += delta * 0.15;
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
    updateCelestialBodies(delta);

    xrCam.getWorldPosition(_camPos);
    if (skySphere) skySphere.position.copy(_camPos);
    if (skyStars) skyStars.position.copy(_camPos);
    if (floatingStars) floatingStars.position.copy(_camPos);
    if (brightStars) brightStars.position.copy(_camPos);
    
    // 星云跟随但保持相对位置
    if (nebulaPlane) {
      nebulaPlane.position.set(_camPos.x + 15, _camPos.y + 10, _camPos.z - 35);
      nebulaPlane.lookAt(_camPos);
    }
    
    // 天体跟随
    if (moonModel && moonModel.visible) {
      moonModel.position.set(_camPos.x - 20, _camPos.y + 15, _camPos.z - 30);
    }
    if (earthModel && earthModel.visible) {
      earthModel.position.set(_camPos.x + 25, _camPos.y - 5, _camPos.z - 40);
    }
    
    // 更新星星动画
    updateStars(starData, time);
    updateStars(previewStarData, time);
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
  if (skyStars) { scene.remove(skyStars); skyStars = null; }
  if (floatingStars) { scene.remove(floatingStars); floatingStars = null; }
  if (brightStars) { scene.remove(brightStars); brightStars = null; }
  if (nebulaPlane) { scene.remove(nebulaPlane); nebulaPlane = null; }
  if (moonModel) { scene.remove(moonModel); moonModel = null; }
  if (earthModel) { scene.remove(earthModel); earthModel = null; }
  
  previewSphere = null;
  previewStars = null;
  ambientStars = null;
  portalMask = null;
  starData = null;
  floatingStarData = null;
  brightStarData = null;
  previewStarData = null;
  ambientStarData = null;
  
  reticle.visible = false;
}
