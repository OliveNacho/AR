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
let skySphere = null;
let placed = false;
let isInside = false;

// 门平面参数（用于判断穿越）
let doorPlaneNormal = new THREE.Vector3();
let doorPlanePoint = new THREE.Vector3();
let lastSide = 1; // 1=门前, -1=门后

const _camPos = new THREE.Vector3();

// ============ 初始化 ============
init();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  // 灯光
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));

  // Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // 控制器
  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  // AR按钮
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hit-test"],
    })
  );

  // Reset按钮
  const btn = document.createElement("button");
  btn.textContent = "Reset";
  btn.style.cssText = "position:fixed;top:10px;left:10px;z-index:9999;padding:8px 12px;";
  btn.onclick = reset;
  document.body.appendChild(btn);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  renderer.setAnimationLoop(render);
}

// ============ 创建门和天球 ============
function build() {
  // 门框组
  doorGroup = new THREE.Group();
  scene.add(doorGroup);

  // 加载门模型（或用简易门框）
  new GLTFLoader().load(
    `${BASE}models/doorframe.glb`,
    (gltf) => {
      const model = gltf.scene;
      // 标准化尺寸
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale = DOOR_HEIGHT / size.y;
      model.scale.setScalar(scale * 0.9);
      model.rotation.y = Math.PI / 2;
      
      box.setFromObject(model);
      model.position.y = -box.min.y;
      
      doorGroup.add(model);
    },
    undefined,
    () => {
      // 备用简易门框
      const mat = new THREE.MeshBasicMaterial({ color: 0x333333 });
      const left = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
      left.position.set(-0.6, DOOR_HEIGHT / 2, 0);
      const right = new THREE.Mesh(new THREE.BoxGeometry(0.1, DOOR_HEIGHT, 0.1), mat);
      right.position.set(0.6, DOOR_HEIGHT / 2, 0);
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 0.1), mat);
      top.position.set(0, DOOR_HEIGHT, 0);
      doorGroup.add(left, right, top);
    }
  );

  // 天球（你的6000x3000全景图）
  const texture = new THREE.TextureLoader().load(`${BASE}textures/pano.jpg`);
  texture.colorSpace = THREE.SRGBColorSpace;

  skySphere = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 64, 32),
    new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
    })
  );
  skySphere.visible = false; // 初始隐藏
  scene.add(skySphere);
}

// ============ 放置门 ============
function onSelect() {
  if (placed || !reticle.visible) return;
  if (!doorGroup) build();

  const xrCam = renderer.xr.getCamera(camera);
  xrCam.getWorldPosition(_camPos);

  // 门位置：reticle处
  const hitPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  
  // 放在用户前方
  const dir = new THREE.Vector3(_camPos.x - hitPos.x, 0, _camPos.z - hitPos.z).normalize();
  doorGroup.position.copy(hitPos).addScaledVector(dir, -DOOR_DISTANCE);
  doorGroup.position.y = hitPos.y;

  // 门朝向用户
  doorGroup.lookAt(_camPos.x, doorGroup.position.y, _camPos.z);

  // 记录门平面（用于判断穿越）
  doorPlanePoint.copy(doorGroup.position);
  doorPlaneNormal.set(0, 0, 1).applyQuaternion(doorGroup.quaternion);

  // 初始化状态
  lastSide = getSide(xrCam);
  isInside = false;
  placed = true;
  reticle.visible = false;
}

// ============ 判断相机在门的哪一侧 ============
function getSide(xrCam) {
  xrCam.getWorldPosition(_camPos);
  const toCamera = _camPos.clone().sub(doorPlanePoint);
  return doorPlaneNormal.dot(toCamera) >= 0 ? 1 : -1;
}

// ============ 检测穿越 ============
function checkCrossing(xrCam) {
  const currentSide = getSide(xrCam);
  
  // 从门前(1)穿到门后(-1) = 进入
  if (lastSide === 1 && currentSide === -1) {
    isInside = true;
  }
  // 从门后(-1)穿到门前(1) = 退出
  else if (lastSide === -1 && currentSide === 1) {
    isInside = false;
  }
  
  lastSide = currentSide;
}

// ============ 渲染 ============
function render(_, frame) {
  const session = renderer.xr.getSession();
  const xrCam = renderer.xr.getCamera(camera);

  // Hit test（未放置时）
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

  // 检测穿门
  if (placed) {
    checkCrossing(xrCam);

    // 🔑 关键：天球始终包裹用户
    xrCam.getWorldPosition(_camPos);
    skySphere.position.copy(_camPos);
    
    // 控制可见性
    skySphere.visible = isInside;
  }

  renderer.render(scene, xrCam);
}

// ============ 重置 ============
function reset() {
  placed = false;
  isInside = false;
  if (doorGroup) {
    scene.remove(doorGroup);
    doorGroup = null;
  }
  if (skySphere) {
    skySphere.visible = false;
  }
  reticle.visible = false;
}
