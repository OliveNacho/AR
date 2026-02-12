import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BASE = import.meta.env.BASE_URL;

// ============ 配置 ============
const DOOR_HEIGHT = 2.1;
const DOOR_DISTANCE = 1.5;
const SKY_RADIUS = 50;
const PREVIEW_RADIUS = 12;

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
let moonModel = null;
let earthModel = null;
let nebulaPlane = null;
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

  const texLoader = new THREE.TextureLoader();
  starSpriteTexture = texLoader.load(`${BASE}textures/stars.png`);
  starSpriteTexture.colorSpace = THREE.SRGBColorSpace;
  
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
    if (touchPoints.length > 15) touchPoints.shift();
  }, { passive: true });
  
  canvas.addEventListener("touchend", () => {
    if (!isTouching) return;
    isTouching = false;
    if (touchPoints.length >= 2) spawnMeteor();
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

// ============ 星星纹理 ============
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
  gradient.addColorStop(0.4, "rgba(255,255,255,0.25)");
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

// ============ 创建星星 ============
function createStars(count, radius, baseSize, useStencil = false) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  const starColors = [
    [1, 1, 1], [0.95, 0.97, 1], [0.85, 0.92, 1],
    [0.75, 0.85, 1], [1, 0.97, 0.9], [1, 0.93, 0.7],
  ];
  
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.75 + 0.25 * Math.random());
    
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    
    const c = starColors[Math.floor(Math.random() * starColors.length)];
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

function createFloatingStars(count, minR, maxR, baseSize) {
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

function createBrightStars(count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 2);
  
  const brightColors = [[1,1,1], [0.8,0.9,1], [1,0.95,0.7]];
  
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
    phases[i * 2 + 1] = 0.2 + Math.random() * 0.6;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  
  const mat = new THREE.PointsMaterial({
    map: starSpriteTexture,
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

function createAmbientStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 5;
    positions[i * 3 + 1] = 0.3 + Math.random() * 2.5;
    positions[i * 3 + 2] = -0.5 - Math.random() * 3;
    
    const b = 0.7 + Math.random() * 0.3;
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
    
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
    size: 0.06,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
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
    
    const twinkle = 0.65 + 0.35 * Math.sin(time * speed + p1);
    col[i * 3] = colors[i * 3] * twinkle;
    col[i * 3 + 1] = colors[i * 3 + 1] * twinkle;
    col[i * 3 + 2] = colors[i * 3 + 2] * twinkle;
    
    const drift = 0.12;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.2 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.cos(time * 0.15 + p1) * drift * 0.4;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.sin(time * 0.18 + p3) * drift;
  }
  
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
}

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
    col[i * 3] = twinkle;
    col[i * 3 + 1] = twinkle;
    col[i * 3 + 2] = twinkle;
    
    const drift = 0.5;
    pos[i * 3] = positions[i * 3] + Math.sin(time * 0.1 + p2) * drift;
    pos[i * 3 + 1] = positions[i * 3 + 1] + Math.sin(time * 0.08 + p1) * drift * 0.4;
    pos[i * 3 + 2] = positions[i * 3 + 2] + Math.cos(time * 0.12 + p3) * drift;
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
    const phase = phases[i * 2];
    const speed = phases[i * 2 + 1];
    const pulse = 0.6 + 0.4 * Math.sin(time * speed + phase);
    col[i * 3] = colors[i * 3] * pulse;
    col[i * 3 + 1] = colors[i * 3 + 1] * pulse;
    col[i * 3 + 2] = colors[i * 3 + 2] * pulse;
  }
  
  points.geometry.attributes.color.needsUpdate = true;
}

// ============ 精致流星（纯粒子拖尾，无Sprite）============
function spawnMeteor() {
  if (touchPoints.length < 2) return;
  
  const start = touchPoints[0];
  const end = touchPoints[touchPoints.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 30) return;
  
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCam.quaternion);
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
  
  const dir3D = new THREE.Vector3()
    .addScaledVector(camRight, dx / len)
    .addScaledVector(camUp, -dy / len)
    .addScaledVector(camForward, 0.1)
    .normalize();
  
  const spawnPos = _camPos.clone()
    .add(camForward.clone().multiplyScalar(12 + Math.random() * 6))
    .add(camUp.clone().multiplyScalar(3 + Math.random() * 5))
    .add(camRight.clone().multiplyScalar((Math.random() - 0.5) * 8));
  
  const meteor = createPureMeteor(spawnPos, dir3D);
  scene.add(meteor);
  meteors.push(meteor);
}

function createPureMeteor(pos, dir) {
  const group = new THREE.Group();
  group.position.copy(pos);
  
  // 流星完全由渐变粒子组成，没有Sprite
  const tailLength = 1.8 + Math.random() * 1.0;
  const particleCount = 50;
  
  const positions = new Float32Array(particleCount * 3);
  const colors = new Float32Array(particleCount * 3);
  const sizes = new Float32Array(particleCount);
  
  for (let i = 0; i < particleCount; i++) {
    const t = i / (particleCount - 1);
    const tCurve = Math.pow(t, 0.7);
    
    // 沿飞行方向分布，越往后越散
    const spread = t * t * 0.02;
    positions[i * 3] = -dir.x * tCurve * tailLength + (Math.random() - 0.5) * spread;
    positions[i * 3 + 1] = -dir.y * tCurve * tailLength + (Math.random() - 0.5) * spread;
    positions[i * 3 + 2] = -dir.z * tCurve * tailLength + (Math.random() - 0.5) * spread;
    
    // 渐变颜色：白 → 淡黄 → 橙 → 淡蓝
    const fade = Math.pow(1 - t, 1.5);
    let r, g, b;
    if (t < 0.1) {
      r = 1; g = 1; b = 1;
    } else if (t < 0.3) {
      const blend = (t - 0.1) / 0.2;
      r = 1; g = 1 - blend * 0.08; b = 1 - blend * 0.25;
    } else if (t < 0.6) {
      const blend = (t - 0.3) / 0.3;
      r = 1 - blend * 0.1; g = 0.92 - blend * 0.15; b = 0.75 - blend * 0.1;
    } else {
      const blend = (t - 0.6) / 0.4;
      r = 0.9 - blend * 0.35; g = 0.77 - blend * 0.07; b = 0.65 + blend * 0.25;
    }
    
    colors[i * 3] = r * fade;
    colors[i * 3 + 1] = g * fade;
    colors[i * 3 + 2] = b * fade;
    
    // 大小：头部大，尾部小
    sizes[i] = (1 - t * 0.85) * 0.06;
  }
  
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  
  // 使用自定义shader实现圆形粒子
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying vec3 vColor;
      void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;
        float alpha = smoothstep(0.5, 0.1, dist);
        gl_FragColor = vec4(vColor, alpha * uOpacity);
      }
    `,
    vertexColors: true,
  });
  
  const particles = new THREE.Points(geo, mat);
  group.add(particles);
  
  // 额外的细线拖尾
  const linePoints = [];
  for (let i = 0; i < 25; i++) {
    const t = i / 24;
    linePoints.push(new THREE.Vector3(
      -dir.x * t * tailLength,
      -dir.y * t * tailLength,
      -dir.z * t * tailLength
    ));
  }
  
  const lineCurve = new THREE.CatmullRomCurve3(linePoints);
  const lineGeo = new THREE.TubeGeometry(lineCurve, 20, 0.008, 4, false);
  const lineMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
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
        vec3 col = mix(vec3(1.0, 1.0, 1.0), vec3(0.6, 0.7, 0.9), t);
        float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
        gl_FragColor = vec4(col, fade * edge * uOpacity * 0.6);
      }
    `,
  });
  
  const line = new THREE.Mesh(lineGeo, lineMat);
  group.add(line);
  
  group.userData = {
    direction: dir.clone(),
    speed: 2 + Math.random() * 1.5,
    life: 0,
    maxLife: 5 + Math.random() * 3,
    particleMat: mat,
    lineMat: lineMat,
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
    let fade;
    if (progress < 0.1) {
      fade = progress / 0.1;
    } else {
      fade = Math.pow(1 - (progress - 0.1) / 0.9, 0.5);
    }
    
    d.particleMat.uniforms.uOpacity.value = fade;
    d.lineMat.uniforms.uOpacity.value = fade;
    
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
  previewStarData = createStars(5000, PREVIEW_RADIUS * 0.9, 0.1, true);
  previewStars = previewStarData.points;
  previewStars.renderOrder = 2;
  doorGroup.add(previewStars);

  // 门外环境星星
  ambientStarData = createAmbientStars(200);
  ambientStars = ambientStarData.points;
  doorGroup.add(ambientStars);

  // ===== 门内世界 =====
  // 天球
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
  skySphere.renderOrder = 1;
  scene.add(skySphere);

  // 球面星星
  starData = createStars(4000, SKY_RADIUS * 0.95, 0.22, false);
  skyStars = starData.points;
  skyStars.material.opacity = 0;
  skyStars.renderOrder = 2;
  scene.add(skyStars);

  // 浮动星星
  floatingStarData = createFloatingStars(1000, SKY_RADIUS * 0.1, SKY_RADIUS * 0.4, 0.25);
  floatingStars = floatingStarData.points;
  floatingStars.material.opacity = 0;
  floatingStars.renderOrder = 3;
  scene.add(floatingStars);

  // 亮星
  brightStarData = createBrightStars(40, SKY_RADIUS * 0.9);
  brightStars = brightStarData.points;
  brightStars.material.opacity = 0;
  brightStars.renderOrder = 4;
  scene.add(brightStars);

  // ===== 加载星云 =====
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
  
  nebulaPlane = new THREE.Mesh(new THREE.PlaneGeometry(25, 25), nebulaMat);
  nebulaPlane.renderOrder = 5;
  scene.add(nebulaPlane);

  // ===== 加载月球 =====
  gltfLoader.load(`${BASE}models/moon.glb`, (gltf) => {
    moonModel = gltf.scene;
    moonModel.scale.setScalar(1.5);
    moonModel.renderOrder = 6;
    
    // 设置材质为透明
    moonModel.traverse((child) => {
      if (child.isMesh) {
        const oldMat = child.material;
        child.material = new THREE.MeshBasicMaterial({
          map: oldMat.map || null,
          color: oldMat.color || 0xcccccc,
          transparent: true,
          opacity: 0,
        });
      }
    });
    
    scene.add(moonModel);
  }, undefined, (err) => {
    console.log("Moon load failed:", err);
  });

  // ===== 加载地球 =====
  gltfLoader.load(`${BASE}models/earth.glb`, (gltf) => {
    earthModel = gltf.scene;
    earthModel.scale.setScalar(3);
    earthModel.renderOrder = 6;
    
    earthModel.traverse((child) => {
      if (child.isMesh) {
        const oldMat = child.material;
        child.material = new THREE.MeshBasicMaterial({
          map: oldMat.map || null,
          color: oldMat.color || 0x4488ff,
          transparent: true,
          opacity: 0,
        });
      }
    });
    
    scene.add(earthModel);
  }, undefined, (err) => {
    console.log("Earth load failed:", err);
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

// ============ 过渡 ============
function updateTransition(xrCam, delta) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  const signedDist = doorPlaneNormal.dot(toCamera);
  
  const currentSide = signedDist >= 0 ? 1 : -1;
  
  if (lastSide === 1 && currentSide === -1 && !isInside) {
    isInside = true;
  } else if (lastSide === -1 && currentSide === 1 && isInside) {
    isInside = false;
  }
  lastSide = currentSide;
  
  const target = isInside ? 1 : 0;
  const speed = 1.8;
  transitionValue += (target - transitionValue) * delta * speed;
  transitionValue = Math.max(0, Math.min(1, transitionValue));
  
  // smootherstep
  const t = transitionValue;
  const smooth = t * t * t * (t * (t * 6 - 15) + 10);
  
  // 门内世界
  if (skySphere) skySphere.material.opacity = smooth;
  if (skyStars) skyStars.material.opacity = smooth;
  if (floatingStars) floatingStars.material.opacity = smooth;
  if (brightStars) brightStars.material.opacity = smooth;
  if (nebulaPlane) nebulaPlane.material.opacity = smooth * 0.35;
  
  // 天体透明度
  if (moonModel) {
    moonModel.traverse((child) => {
      if (child.isMesh) child.material.opacity = smooth;
    });
  }
  if (earthModel) {
    earthModel.traverse((child) => {
      if (child.isMesh) child.material.opacity = smooth;
    });
  }
  
  // 预览
  const previewOp = 1 - smooth;
  if (previewSphere) previewSphere.material.opacity = previewOp;
  if (previewStars) previewStars.material.opacity = previewOp;
  if (ambientStars) ambientStars.material.opacity = previewOp * 0.8;
  
  if (portalMask) portalMask.visible = smooth < 0.99;
}

// ============ 更新天体 ============
function updateCelestialBodies(time, delta) {
  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);
  
  // 星云位置
  if (nebulaPlane) {
    nebulaPlane.position.set(_camPos.x + 18, _camPos.y + 12, _camPos.z - 35);
    nebulaPlane.lookAt(_camPos);
  }
  
  // 月球位置和自转
  if (moonModel) {
    moonModel.position.set(_camPos.x - 15, _camPos.y + 10, _camPos.z - 25);
    moonModel.rotation.y += delta * 0.1;
  }
  
  // 地球位置和自转
  if (earthModel) {
    earthModel.position.set(_camPos.x + 20, _camPos.y - 3, _camPos.z - 35);
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
    updateCelestialBodies(time, delta);

    xrCam.getWorldPosition(_camPos);
    if (skySphere) skySphere.position.copy(_camPos);
    if (skyStars) skyStars.position.copy(_camPos);
    if (floatingStars) floatingStars.position.copy(_camPos);
    if (brightStars) brightStars.position.copy(_camPos);
    
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
