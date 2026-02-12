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
const FLOATING_STAR_COUNT = 1500;
const BRIGHT_STAR_COUNT = 60;
const PREVIEW_STAR_COUNT = 6000;

// ============ 全局变量 ============
let renderer, scene, camera;
let reticle, hitTestSource = null;
let doorGroup = null;
let portalMask = null;
let previewSphere = null;
let previewStars = null;
let skySphere = null;
let skyStars = null;
let floatingStars = null;
let brightStars = null;
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

// 流星
let meteors = [];
let touchPoints = [];
let isTouching = false;

// 纹理
let starTexture = null;
let brightStarTexture = null;

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
  brightStarTexture = createBrightStarTexture();

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

// ============ 普通星星纹理 ============
function createStarTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  const gradient = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.15, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.3)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.05)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cx, cx, 0, Math.PI * 2);
  ctx.fill();
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 亮星纹理（十字星芒）============
function createBrightStarTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  
  const cx = size / 2;
  
  // 核心
  const core = ctx.createRadialGradient(cx, cx, 0, cx, cx, 15);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(0.5, "rgba(255,255,255,0.7)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cx, 15, 0, Math.PI * 2);
  ctx.fill();
  
  // 外层光晕
  const outer = ctx.createRadialGradient(cx, cx, 0, cx, cx, 40);
  outer.addColorStop(0, "rgba(255,255,255,0.5)");
  outer.addColorStop(0.5, "rgba(255,255,255,0.1)");
  outer.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(cx, cx, 40, 0, Math.PI * 2);
  ctx.fill();
  
  // 十字星芒
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.translate(cx, cx);
    ctx.rotate((i * Math.PI) / 2);
    
    const spike = ctx.createLinearGradient(0, 0, 50, 0);
    spike.addColorStop(0, "rgba(255,255,255,0.8)");
    spike.addColorStop(0.2, "rgba(255,255,255,0.3)");
    spike.addColorStop(0.5, "rgba(255,255,255,0.05)");
    spike.addColorStop(1, "rgba(255,255,255,0)");
    
    ctx.fillStyle = spike;
    ctx.beginPath();
    ctx.moveTo(0, -1.5);
    ctx.lineTo(50, 0);
    ctx.lineTo(0, 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 创建星星 ============
function createStars(count, radius, baseSize = 0.2, forPreview = false) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.7 + 0.3 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const type = Math.random();
    if (type < 0.6) {
      colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1;
    } else if (type < 0.8) {
      colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 1;
    } else {
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.85;
    }
    
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
  
  if (forPreview) {
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

// ============ 创建亮星 ============
function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 2);
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    colors[i * 3] = 1;
    colors[i * 3 + 1] = 1;
    colors[i * 3 + 2] = 1;
    
    phases[i * 2] = Math.random() * Math.PI * 2;
    phases[i * 2 + 1] = 0.2 + Math.random() * 0.8;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: brightStarTexture,
    size: 1.2,
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
    
    // 闪烁
    const twinkle = 0.7 + 0.3 * Math.sin(time * speed + p1);
    col[i * 3] = colors[i * 3] * twinkle;
    col[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    col[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    // 轻微浮动
    const drift = 0.15;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.2 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.15 + p1) * drift * 0.5;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.sin(time * 0.18 + p3) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 更新浮动星星（大幅位移）============
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
    
    const twinkle = 0.6 + 0.4 * Math.sin(time * speed + p1);
    col[i * 3] = twinkle;
    col[i * 3 + 1] = twinkle;
    col[i * 3 + 2] = twinkle;
    
    // 更大的浮动
    const drift = 0.8;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.1 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.sin(time * 0.08 + p1) * drift * 0.6;
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
    const pulse = 0.7 + 0.3 * Math.sin(time * speed + phase);
    col[i * 3] = pulse;
    col[i * 3 + 1] = pulse;
    col[i * 3 + 2] = pulse;
  }
  
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
    .addScaledVector(camForward, 0.2)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(12))
    .add(new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 5, (Math.random() - 0.5) * 6));
  
  const meteor = createMeteor(spawnPos, dir3D, xrCam);
  scene.add(meteor);
  meteors.push(meteor);
}

function createMeteor(pos, dir, xrCam) {
  const group = new THREE.Group();
  group.position.copy(pos);
  
  // 计算2D屏幕角度（用于旋转sprite）
  const screenDir = dir.clone().project(xrCam);
  const angle2D = Math.atan2(screenDir.y, screenDir.x) - Math.PI / 2;
  
  // 流星头部 - 椭圆精灵，沿飞行方向
  const headCanvas = document.createElement("canvas");
  headCanvas.width = 64;
  headCanvas.height = 128;
  const hctx = headCanvas.getContext("2d");
  hctx.clearRect(0, 0, 64, 128);
  
  // 椭圆渐变
  const hGrad = hctx.createRadialGradient(32, 40, 0, 32, 50, 50);
  hGrad.addColorStop(0, "rgba(255,255,255,1)");
  hGrad.addColorStop(0.2, "rgba(255,250,240,0.9)");
  hGrad.addColorStop(0.5, "rgba(255,220,180,0.5)");
  hGrad.addColorStop(0.8, "rgba(255,180,120,0.15)");
  hGrad.addColorStop(1, "rgba(255,150,100,0)");
  
  hctx.fillStyle = hGrad;
  hctx.beginPath();
  hctx.ellipse(32, 50, 25, 45, 0, 0, Math.PI * 2);
  hctx.fill();
  
  const headTex = new THREE.CanvasTexture(headCanvas);
  headTex.colorSpace = THREE.SRGBColorSpace;
  
  const headMat = new THREE.SpriteMaterial({
    map: headTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const head = new THREE.Sprite(headMat);
  head.scale.set(0.6, 1.2, 1);
  head.material.rotation = angle2D;
  group.add(head);
  
  // 核心亮点
  const coreMat = new THREE.SpriteMaterial({
    map: starTexture,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Sprite(coreMat);
  core.scale.set(0.25, 0.25, 1);
  group.add(core);
  
  // 拖尾 - 使用渐变线条
  const tailLength = 3 + Math.random() * 1.5;
  const tailSegments = 40;
  
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-dir.x * tailLength * 0.3, -dir.y * tailLength * 0.3, -dir.z * tailLength * 0.3),
    new THREE.Vector3(-dir.x * tailLength * 0.7, -dir.y * tailLength * 0.7, -dir.z * tailLength * 0.7),
    new THREE.Vector3(-dir.x * tailLength, -dir.y * tailLength, -dir.z * tailLength),
  ]);
  
  const tailGeo = new THREE.TubeGeometry(curve, tailSegments, 0.08, 8, false);
  const tailMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      opacity: { value: 1.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float opacity;
      varying vec2 vUv;
      void main() {
        float t = vUv.x;
        float fade = pow(1.0 - t, 1.5);
        
        // 颜色渐变：白→黄→橙→淡蓝
        vec3 col;
        if (t < 0.15) {
          col = vec3(1.0, 1.0, 1.0);
        } else if (t < 0.4) {
          float b = (t - 0.15) / 0.25;
          col = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.9, 0.6), b);
        } else if (t < 0.7) {
          float b = (t - 0.4) / 0.3;
          col = mix(vec3(1.0, 0.9, 0.6), vec3(0.9, 0.7, 0.5), b);
        } else {
          float b = (t - 0.7) / 0.3;
          col = mix(vec3(0.9, 0.7, 0.5), vec3(0.6, 0.7, 0.9), b);
        }
        
        // 边缘柔和
        float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
        edge = smoothstep(0.0, 0.5, edge);
        
        gl_FragColor = vec4(col * fade, fade * edge * opacity);
      }
    `,
  });
  
  const tail = new THREE.Mesh(tailGeo, tailMat);
  group.add(tail);
  
  // 少量火花
  const sparkCount = 15;
  const sparkPos = new Float32Array(sparkCount * 3);
  const sparkCol = new Float32Array(sparkCount * 3);
  
  for (let i = 0; i < sparkCount; i++) {
    const t = Math.random() * 0.5;
    const spread = t * 0.2;
    sparkPos[i * 3] = -dir.x * t * tailLength + (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 1] = -dir.y * t * tailLength + (Math.random() - 0.5) * spread;
    sparkPos[i * 3 + 2] = -dir.z * t * tailLength + (Math.random() - 0.5) * spread;
    
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
    size: 0.08,
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
    speed: 4 + Math.random() * 2,
    life: 0,
    maxLife: 5 + Math.random() * 2,
    headMat,
    coreMat,
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
    m.position.addScaledVector(d.direction, d.speed * delta);
    
    const progress = d.life / d.maxLife;
    // 淡入淡出
    let fade;
    if (progress < 0.1) {
      fade = progress / 0.1;
    } else {
      fade = Math.pow(1 - (progress - 0.1) / 0.9, 0.6);
    }
    
    d.headMat.opacity = fade;
    d.coreMat.opacity = fade;
    d.tailMat.uniforms.opacity.value = fade;
    d.sparkMat.opacity = fade * 0.8;
    
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
  previewStarData = createStars(PREVIEW_STAR_COUNT, PREVIEW_RADIUS * 0.9, 0.15, true);
  previewStars = previewStarData.points;
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

  // 门内球面星星
  starData = createStars(STAR_COUNT, SKY_RADIUS * 0.9, 0.3, false);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = -99;
  scene.add(skyStars);

  // 门内浮动星星
  floatingStarData = createFloatingStars(FLOATING_STAR_COUNT, SKY_RADIUS * 0.2, SKY_RADIUS * 0.6, 0.35);
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

// ============ 更丝滑的过渡 ============
function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  const signedDist = doorPlaneNormal.dot(toCamera);
  
  const currentSide = signedDist >= 0 ? 1 : -1;
  if (lastSide === 1 && currentSide === -1) isInside = true;
  else if (lastSide === -1 && currentSide === 1) isInside = false;
  lastSide = currentSide;
  
  let target = isInside ? 1 : 0;
  
  // 更慢更平滑的过渡
  const speed = 2.0;
  transitionValue += (target - transitionValue) * delta * speed;
  
  // 使用更平滑的曲线
  const t = transitionValue;
  const smooth = t < 0.5 
    ? 4 * t * t * t 
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
  
  // 门内世界
  if (skySphere) skySphere.material.opacity = smooth;
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  
  // 预览（交叉淡出）
  const previewOp = 1 - smooth;
  if (previewSphere) previewSphere.material.opacity = previewOp;
  if (previewStars) previewStars.material.opacity = previewOp;
  
  if (portalMask) portalMask.visible = smooth < 0.98;
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
    if (skySphere) skySphere.position.copy(_camPos);
    if (skyStars) skyStars.position.copy(_camPos);
    if (floatingStars) floatingStars.position.copy(_camPos);
    if (brightStars) brightStars.position.copy(_camPos);
    
    // 更新所有星星动画
    updateStars(starData, time);
    updateStars(previewStarData, time);
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
  
  previewSphere = null;
  previewStars = null;
  portalMask = null;
  starData = null;
  floatingStarData = null;
  brightStarData = null;
  previewStarData = null;
  
  reticle.visible = false;
}
