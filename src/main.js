const BASE = import.meta.env.BASE_URL;
import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import {
  BatchedRenderer,
  ParticleSystem,
  ConstantValue,
  IntervalValue,
  PiecewiseBezier,
  SphereEmitter,
  ColorOverLife,
  SizeOverLife,
  ApplyForce,
  Noise,
  ParticleEmitter,
  RenderMode
} from "three.quarks";

/**
 * 最终版包含：
 * 1) Stencil Portal：门洞遮罩，只能透过门洞看到内部世界
 * 2) 进出门切换：穿过门洞 -> 进入门内模式（360 包裹）；离开 -> 回到门外模式
 * 3) 星空/星云飘动 + 闪烁
 * 4) 划屏路径 -> 门内生成流星（电影感：亮核+拖尾+Bloom）
 */

let camera, scene, renderer, composer;
let controller;
let reticle, hitTestSource = null, hitTestSourceRequested = false;

const clock = new THREE.Clock();

// ======== Portal 相关状态 ========
let portal = null;
let portalPlaced = false;

// 门内/门外状态机
let insidePortal = false;          // 当前是否处于门内模式
let insideBlend = 0;               // 0..1 平滑过渡
const INSIDE_BLEND_SPEED = 3.5;    // 过渡速度，越大越快

// 触摸划线输入
let isPointerDown = false;
let pointerPath = [];

// Quarks 粒子渲染器
const batchedRenderer = new BatchedRenderer();
const activeSystems = []; // 我们自己管理创建的粒子系统

// ============ 基础场景 ============
scene = new THREE.Scene();
camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 80);

renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  stencil: true,     // 关键：需要 stencil buffer
  depth: true
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// 后期 Bloom：电影感的“发光氛围”
composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.25, // strength（更电影可调到 1.5~2.0）
    0.65, // radius
    0.10  // threshold（更亮可调到 0.05）
  )
);

// 光源（AR 场景里不需要很复杂）
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.8));

// 粒子批渲染器加入场景
scene.add(batchedRenderer);

// ============ WebXR ARButton ============
document.body.appendChild(
  ARButton.createButton(renderer, {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["dom-overlay"],
    domOverlay: { root: document.body }
  })
);

// ============ Reticle（放置指示器） ============
reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.095, 36).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// ============ 控制器：点击放置 Portal ============
controller = renderer.xr.getController(0);
controller.addEventListener("select", () => {
  if (reticle.visible && !portalPlaced) {
    portal = buildStencilPortalWorld();
    portal.matrix.fromArray(reticle.matrix.elements);
    portal.matrix.decompose(portal.position, portal.quaternion, portal.scale);
    scene.add(portal);
    portalPlaced = true;
  }
});
scene.add(controller);

// ============ 触摸划线：生成流星 ============
window.addEventListener("pointerdown", (e) => {
  isPointerDown = true;
  pointerPath = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
});

window.addEventListener("pointermove", (e) => {
  if (!isPointerDown) return;
  pointerPath.push({ x: e.clientX, y: e.clientY, t: performance.now() });
});

window.addEventListener("pointerup", () => {
  if (!isPointerDown) return;
  isPointerDown = false;

  // 只有放置了 portal 并且“门内模式”才触发更合理（符合你的第2点）
  if (!portalPlaced || !portal) return;
  if (!insidePortal) return;

  if (pointerPath.length < 6) return;
  spawnMeteorFromSwipe(pointerPath);
});

// ============ Portal：Stencil 遮罩 + 内部世界 ============
function buildStencilPortalWorld() {
  const root = new THREE.Group();

  // 门的位置：我们以门中心作为局部原点，门朝向为 +Z（你站在 -Z 侧看门）
  // root 放到命中平面后，再在内部搭建门框等

  // ---- 门框发光圆环（可见）----
  const frame = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.035, 18, 140),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x9ad5ff,
      emissiveIntensity: 2.5,
      roughness: 0.22,
      metalness: 0.08
    })
  );
  frame.position.set(0, 0.9, 0);
  frame.renderOrder = 30;
  root.add(frame);

  // ---- Stencil 写入面：一个圆形门洞（不可见，但写 stencil）----
  const portalMask = new THREE.Mesh(
    new THREE.CircleGeometry(0.50, 96),
    new THREE.MeshBasicMaterial({
      colorWrite: false,     // 不写颜色
      depthWrite: false,
      depthTest: true,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp
    })
  );
  portalMask.position.set(0, 0.9, 0.001); // 略微前移避免 Z-fight
  portalMask.renderOrder = 10;
  root.add(portalMask);

  // ---- 门内世界：默认只在 stencil==1 的区域渲染（门外模式）----
  const inner = new THREE.Group();
  inner.position.set(0, 0.9, 0.03); // 放在门后面一点点
  inner.renderOrder = 20;
  root.add(inner);

  // 全景球（门内世界背景）
  const panoTex = new THREE.TextureLoader().load(`${BASE}pano.jpg`);
  panoTex.colorSpace = THREE.SRGBColorSpace;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(10, 72, 72),
    new THREE.MeshBasicMaterial({
      map: panoTex,
      side: THREE.BackSide,
      // stencil：门外模式下只透过门洞看得到
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.EqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp
    })
  );
  sphere.renderOrder = 20;
  inner.add(sphere);

  // 星云层（叠加，漂浮）
  const nebTex  = new THREE.TextureLoader().load(`${BASE}nebula.png`);
  nebTex.colorSpace = THREE.SRGBColorSpace;
  const nebula = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 7),
    new THREE.MeshBasicMaterial({
      map: nebTex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // 同样受 stencil 限制（门外模式）
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.EqualStencilFunc
    })
  );
  nebula.position.set(0, 0, -2.4);
  nebula.renderOrder = 21;
  inner.add(nebula);

  // 星空点（闪烁）
  const stars = buildTwinkleStars();
  // ShaderMaterial 也可以受 stencil 限制：我们在材质层面开启 stencil
  stars.material.stencilWrite = true;
  stars.material.stencilRef = 1;
  stars.material.stencilFunc = THREE.EqualStencilFunc;
  stars.renderOrder = 22;
  inner.add(stars);

  // 门前“轻薄雾面”可选：增强穿越感（也受 stencil）
  const veil = new THREE.Mesh(
    new THREE.CircleGeometry(0.50, 96),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.10,
      color: 0x9ad5ff,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.EqualStencilFunc
    })
  );
  veil.position.set(0, 0.9, 0.002);
  veil.renderOrder = 25;
  root.add(veil);

  // 存到 userData 方便更新/状态切换
  root.userData = {
    frame,
    portalMask,
    inner,
    sphere,
    nebula,
    stars,
    veil,
    // 门平面朝向（局部 +Z），用于判断你是否穿过门
    portalNormalLocal: new THREE.Vector3(0, 0, 1),
    portalCenterLocal: new THREE.Vector3(0, 0.9, 0),
    portalRadius: 0.50
  };

  return root;
}

function buildTwinkleStars() {
  const count = 1700;
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const tw = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // 半径 7~9 的球壳
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 7.0 + Math.random() * 2.0;

    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    scales[i] = 0.6 + Math.random() * 1.9;
    tw[i] = Math.random() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
  geo.setAttribute("aTw", new THREE.BufferAttribute(tw, 1));

  const sprite  = new THREE.TextureLoader().load(`${BASE}star.png`);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSprite: { value: sprite }
    },
    vertexShader: `
      attribute float aScale;
      attribute float aTw;
      uniform float uTime;
      varying float vTw;
      void main() {
        vTw = aTw;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float twinkle = 0.55 + 0.45 * sin(uTime * 2.3 + aTw);
        gl_PointSize = aScale * twinkle * (240.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D uSprite;
      varying float vTw;
      void main() {
        vec4 c = texture2D(uSprite, gl_PointCoord);
        c.rgb *= vec3(1.0, 0.95 + 0.06*sin(vTw), 1.0);
        gl_FragColor = c;
      }
    `
  });

  return new THREE.Points(geo, mat);
}

// ============ 进出门判定 + 切换渲染逻辑 ============

function updatePortalState(dt, timeSec) {
  if (!portalPlaced || !portal) return;

  const ud = portal.userData;

  // 门中心和门法线（世界坐标）
  const portalCenterW = ud.portalCenterLocal.clone().applyMatrix4(portal.matrixWorld);
  const portalNormalW = ud.portalNormalLocal.clone().transformDirection(portal.matrixWorld).normalize();

  // 相机位置（世界坐标）
  const camPosW = new THREE.Vector3();
  camPosW.setFromMatrixPosition(camera.matrixWorld);

  // 计算相机相对门平面的“前后”距离（沿门法线）
  const toCam = camPosW.clone().sub(portalCenterW);
  const signedDist = toCam.dot(portalNormalW); // >0 表示相机在门的“背面”（门内侧）

  // 还要判断相机是否穿过门洞范围（投影到门平面内的半径）
  const planar = toCam.clone().sub(portalNormalW.clone().multiplyScalar(signedDist));
  const withinRadius = planar.length() < (ud.portalRadius * 0.95);

  // 进入/退出条件（你可以按体验调整阈值）
  const ENTER_D = 0.18;
  const EXIT_D = 0.05;

  let wantInside = insidePortal;
  if (!insidePortal) {
    // 门外 -> 想进入：必须穿过到背面，并且在洞范围内
    if (signedDist > ENTER_D && withinRadius) wantInside = true;
  } else {
    // 门内 -> 想退出：回到门前侧 或者离开洞范围
    if (signedDist < EXIT_D || !withinRadius) wantInside = false;
  }

  insidePortal = wantInside;

  // 平滑过渡 0..1
  const target = insidePortal ? 1 : 0;
  insideBlend = THREE.MathUtils.damp(insideBlend, target, INSIDE_BLEND_SPEED, dt);

  // 根据 insideBlend 动态切换 stencil 限制：
  // - 门外：sphere/nebula/stars/veil 只在 stencil==1 区域渲染
  // - 门内：取消 stencil 限制（让球体包裹整个视野）
  const loosen = insideBlend > 0.65;

  setInnerStencilEnabled(!loosen);

  // 门框发光随进入加一点强度（增强“穿越感”）
  ud.frame.material.emissiveIntensity = 2.5 + insideBlend * 1.2;

  // 轻微呼吸
  ud.frame.scale.setScalar(1.0 + 0.012 * Math.sin(timeSec * 2.0));

  // 门雾面在门内弱化一些
  ud.veil.material.opacity = 0.10 * (1.0 - insideBlend * 0.75);

  // 星云漂移
  ud.nebula.rotation.z += dt * (0.05 + insideBlend * 0.03);
  ud.nebula.position.x = Math.sin(timeSec * 0.8) * 0.10;
  ud.nebula.position.y = Math.cos(timeSec * 0.7) * 0.07;

  // 星星闪烁时间
  if (ud.stars.material.uniforms?.uTime) {
    ud.stars.material.uniforms.uTime.value = timeSec;
  }
}

function setInnerStencilEnabled(enabled) {
  if (!portal) return;
  const { sphere, nebula, stars, veil } = portal.userData;

  const mats = [sphere.material, nebula.material, stars.material, veil.material];

  if (enabled) {
    for (const m of mats) {
      m.stencilWrite = true;
      m.stencilRef = 1;
      m.stencilFunc = THREE.EqualStencilFunc;
    }
  } else {
    // 取消 stencil 限制（门内模式）
    for (const m of mats) {
      m.stencilWrite = false;
    }
  }
}

// ============ 流星：划线 -> 在门内世界生成 VFX ============

function spawnMeteorFromSwipe(path) {
  // 取首尾点
  const a = path[0];
  const b = path[path.length - 1];

  const p0 = screenToInnerPoint(a.x, a.y);
  const p1 = screenToInnerPoint(b.x, b.y);
  if (!p0 || !p1) return;

  createMeteorEmitter(p0, p1);
}

function screenToInnerPoint(x, y) {
  if (!portal) return null;

  // 门内模式：把射线与“相机周围的球”求交，保证你在任何方向划都能画出流星
  // 这样你会感觉“在 360 空间里划出轨迹”
  const ndc = new THREE.Vector2(
    (x / window.innerWidth) * 2 - 1,
    -(y / window.innerHeight) * 2 + 1
  );

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);

  const camPosW = new THREE.Vector3();
  camPosW.setFromMatrixPosition(camera.matrixWorld);

  // 以相机为球心的“门内绘制半径”
  const R = 2.8;

  const t = intersectRaySphereWorld(raycaster.ray.origin, raycaster.ray.direction, camPosW, R);
  if (t == null) return null;

  return raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(t));
}

function intersectRaySphereWorld(ro, rd, c, r) {
  const oc = ro.clone().sub(c);
  const b = oc.dot(rd);
  const c2 = oc.dot(oc) - r * r;
  const h = b * b - c2;
  if (h < 0) return null;
  const t = -b + Math.sqrt(h); // 取远交点更自然（看起来在空间里）
  return t > 0 ? t : null;
}

function createMeteorEmitter(startW, endW) {
  const dir = new THREE.Vector3().subVectors(endW, startW);
  const len = dir.length();
  if (len < 0.05) return;

  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

  const texture = new THREE.TextureLoader().load(`${BASE}meteor.png`);

  // 电影感：高发射率 + additive + bloom + 噪声扰动 + 颜色/尺寸曲线
  const ps = new ParticleSystem({
    duration: 0.55,
    looping: false,
    prewarm: false,
    instancingGeometry: new THREE.PlaneGeometry(1, 1),
    startLife: new IntervalValue(0.16, 0.30),
    startSpeed: new IntervalValue(len * 9.0, len * 13.0),
    startSize: new IntervalValue(0.12, 0.22),
    startColor: new ConstantValue(new THREE.Color(1, 1, 1)),
    renderMode: RenderMode.BillBoard,
    blending: THREE.AdditiveBlending,
    texture
  });

  const emitter = new ParticleEmitter();
  emitter.setShape(new SphereEmitter({ radius: 0.01 }));
  emitter.emitRate = new ConstantValue(4200);
  emitter.name = "meteor";

  ps.addBehavior(new ApplyForce(new ConstantValue(0.0), new ConstantValue(-0.25), new ConstantValue(0.0)));
  ps.addBehavior(new Noise(new ConstantValue(0.35), new ConstantValue(1.05)));

  // 尺寸随生命变化：先膨胀一点再衰减到 0
  ps.addBehavior(
    new SizeOverLife(
      new PiecewiseBezier([
        [new THREE.Vector2(0, 0.9), new THREE.Vector2(0.15, 1.35), new THREE.Vector2(0.32, 1.05)],
        [new THREE.Vector2(0.32, 1.05), new THREE.Vector2(0.70, 0.55), new THREE.Vector2(1, 0.0)]
      ])
    )
  );

  // 亮度（用颜色曲线近似）：末尾衰减
  ps.addBehavior(
    new ColorOverLife(
      new PiecewiseBezier([
        [new THREE.Vector2(0, 1.0), new THREE.Vector2(0.25, 1.0), new THREE.Vector2(0.55, 0.95)],
        [new THREE.Vector2(0.55, 0.95), new THREE.Vector2(0.78, 0.78), new THREE.Vector2(1, 0.45)]
      ])
    )
  );

  ps.addEmitter(emitter);

  // 放到世界坐标：让流星出现在划过的真实方向
  ps.emitterTransform.position.copy(startW);
  ps.emitterTransform.quaternion.copy(q);

  batchedRenderer.addSystem(ps);

  // 自动回收
  ps.userData = { bornAt: performance.now(), ttl: 1200 };
  activeSystems.push(ps);
}

// ============ WebXR Hit Test ============
function updateHitTest(frame) {
  const session = renderer.xr.getSession();
  const referenceSpace = renderer.xr.getReferenceSpace();

  if (!hitTestSourceRequested) {
    session.requestReferenceSpace("viewer").then((viewerSpace) => {
      session.requestHitTestSource({ space: viewerSpace }).then((source) => {
        hitTestSource = source;
      });
    });

    session.addEventListener("end", () => {
      hitTestSourceRequested = false;
      hitTestSource = null;
    });

    hitTestSourceRequested = true;
  }

  if (hitTestSource && !portalPlaced) {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    if (hitTestResults.length) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(referenceSpace);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      reticle.visible = false;
    }
  } else {
    reticle.visible = false;
  }
}

// ============ 主循环 ============
renderer.setAnimationLoop((timestamp, frame) => {
  const dt = clock.getDelta();
  const t = timestamp / 1000;

  // hit test
  if (frame) updateHitTest(frame);

  // 门状态更新（进出门 + 动画 + stencil 切换）
  updatePortalState(dt, t);

  // 回收过期粒子系统（不要遍历 batchedRenderer.systems，不同版本不保证可用）
const now = performance.now();
for (let i = activeSystems.length - 1; i >= 0; i--) {
  const sys = activeSystems[i];
  const ud = sys.userData;
  if (ud && now - ud.bornAt > ud.ttl) {
    batchedRenderer.removeSystem(sys);
    activeSystems.splice(i, 1);
  }
}


  composer.render();
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
