// main.js - Avatar + FaceMesh

// Import Three.js modules via ESM CDN
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs';

const ui = {
  container: document.getElementById('three-container'),
  startBtn: document.getElementById('startBtn'),
  status: document.getElementById('status'),
  inputVideo: document.getElementById('inputVideo'),
};

let renderer, scene, camera, controls;
let avatar, headBone = null;
let hipsBone = null;
let trackingActive = false;
let size = { w: 0, h: 0 };
let refitFrames = 0; // not used now; keeping for future
const TARGET_HEIGHT = 1.6;
const FRAME_PAD = 1.6; // how much extra space around height
const rig = {}; // resolved skeleton parts for retargeting
// Simple bind caches for aiming bones along their original child direction
const bindRotations = new Map(); // bone.uuid -> initial local quaternion
const restDirs = new Map();      // bone.uuid -> rest direction in parent space (normalized)
const restPerp = new Map();      // bone.uuid -> a perpendicular axis in parent space (from bind)

// Basic Three.js bootstrap
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0b10);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.5, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  ui.container.appendChild(renderer.domElement);

  const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
  dirLight.position.set(1, 2, 2);
  scene.add(dirLight);

  const fillLight = new THREE.HemisphereLight(0xffffff, 0x222233, 0.6);
  scene.add(fillLight);
  const ambient = new THREE.AmbientLight(0xffffff, 0.2);
  scene.add(ambient);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.5, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableRotate = false;

  onResize();
  window.addEventListener('resize', onResize);
}

function onResize() {
  const rect = ui.container.getBoundingClientRect();
  size.w = Math.max(1, Math.floor(rect.width));
  size.h = Math.max(1, Math.floor(rect.height));
  camera.aspect = size.w / size.h;
  camera.updateProjectionMatrix();
  renderer.setSize(size.w, size.h, true);
  // Reframe on resize to keep model in view (no root recenter)
  if (avatar) frameCameraToAvatar(camera, controls, avatar, TARGET_HEIGHT, FRAME_PAD);
}

// Load GLB avatar
async function loadAvatar() {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      './avatar.glb',
      (gltf) => {
        avatar = gltf.scene;
        avatar.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true; obj.receiveShadow = true;
            if (obj.material) {
              obj.material.depthWrite = true;
            }
          }
        });
        // Center, scale, place, add to scene, and frame
        centerAndPlaceAvatar(avatar, TARGET_HEIGHT);
        scene.add(avatar);
        headBone = findHeadBone(avatar) || null;
        hipsBone = findHipsBone(avatar) || null;
        findEyeBones(avatar);
        findFaceMeshWithMorphs(avatar);

        frameCameraToAvatar(camera, controls, avatar, TARGET_HEIGHT, FRAME_PAD);
        resolve();
      },
      undefined,
      (err) => reject(err)
    );
  });
}

function findHeadBone(root) {
  let headBoneFound = null;
  let neckBoneFound = null;
  root.traverse((obj) => {
    if (obj.isBone || obj.type === 'Bone') {
      const name = (obj.name || '').toLowerCase();
      if (!headBoneFound && (name.includes('head') || name.includes('skull'))) {
        headBoneFound = obj;
      }
      if (!neckBoneFound && name.includes('neck')) {
        neckBoneFound = obj;
      }
    }
  });
  return headBoneFound || neckBoneFound; // Prefer head, fallback to neck
}

function findHipsBone(root) {
  let found = null;
  root.traverse((obj) => {
    if (found) return;
    if (obj.isBone || obj.type === 'Bone') {
      const name = (obj.name || '').toLowerCase();
      if (name.includes('hips') || name.includes('pelvis') || name === 'root') {
        found = obj;
      }
    }
  });
  return found;
}

function centerAndPlaceAvatar(object, targetHeight = 1.6) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const scale = targetHeight / Math.max(size.y, 1e-3);
  object.scale.setScalar(scale);

  // Recompute after scaling and position so that bottom sits on y=0
  const box2 = new THREE.Box3().setFromObject(object);
  const center2 = box2.getCenter(new THREE.Vector3());

  object.position.x += -center2.x;
  object.position.z += -center2.z;
  object.position.y += -box2.min.y;

  // Snap XZ using hips bone for accuracy if available
  if (hipsBone && hipsBone.isBone) {
    object.updateWorldMatrix(true, true);
    const hips = hipsBone.getWorldPosition(new THREE.Vector3());
    object.position.x += -hips.x;
    object.position.z += -hips.z;
  }
}

// ---- Eye Animation Globals ----
let leftEyeBone = null;
let rightEyeBone = null;
let faceMeshMesh = null; // The mesh that has blendshapes
let eyeBlinkIndices = []; // Indices for blink morphs

// Saccade State
const eyeTarget = new THREE.Vector2(0, 0); // yaw, pitch
const eyeCurrent = new THREE.Vector2(0, 0);
let nextSaccadeTime = 0;

// Blink State
let nextBlinkTime = 0;
let isBlinking = false;
let blinkStartTime = 0;
const BLINK_DURATION = 0.15; // seconds

function findEyeBones(root) {
  root.traverse((obj) => {
    if (obj.isBone || obj.type === 'Bone') {
      const n = (obj.name || '').toLowerCase();
      if (n.includes('lefteye') || n === 'eye.l' || n === 'def_c_eye_l') leftEyeBone = obj;
      if (n.includes('righteye') || n === 'eye.r' || n === 'def_c_eye_r') rightEyeBone = obj;
    }
  });
}

function findFaceMeshWithMorphs(root) {
  root.traverse((obj) => {
    if (obj.isMesh && obj.morphTargetDictionary) {
      const keys = Object.keys(obj.morphTargetDictionary);
      console.log('Mesh with morphs:', obj.name, keys); // DEBUG LOG

      if (faceMeshMesh) return; // Already found one? Keep searching or just pick first?

      // Look for blink-related keys
      const blinkKeys = keys.filter(k => {
        const kn = k.toLowerCase();
        return kn.includes('blink') || kn.includes('eyesclosed') || kn.includes('eyeclose') || kn.includes('closure');
      });
      if (blinkKeys.length > 0) {
        faceMeshMesh = obj;
        eyeBlinkIndices = blinkKeys.map(k => obj.morphTargetDictionary[k]);
        console.log('SELECTED Face Mesh for blinking:', obj.name, blinkKeys);
      }
    }
  });
}

const HEAD_FRAME_HEIGHT = 0.5; // Estimated height of head+neck area to frame
const HEAD_FRAME_PAD = 1.3;

function frameCameraToAvatar(cam, ctrl, object, personHeight = TARGET_HEIGHT, pad = FRAME_PAD) {
  object.updateWorldMatrix(true, true);

  let center;
  let heightToFrame;
  let padding;

  if (headBone && headBone.isBone) {
    // Frame the head with some offset for headroom
    const headPos = headBone.getWorldPosition(new THREE.Vector3());
    center = headPos.clone().add(new THREE.Vector3(0, 0.08, 0)); // Move target up ~8cm to leave space above head
    heightToFrame = HEAD_FRAME_HEIGHT;
    padding = HEAD_FRAME_PAD;
  } else {
    // Fallback to full body if no head found
    const box = new THREE.Box3().setFromObject(object);
    const c = box.getCenter(new THREE.Vector3());
    // Aim a bit up from center for full body
    center = new THREE.Vector3(c.x, personHeight * 0.55, c.z);
    heightToFrame = personHeight;
    padding = pad;
  }

  const vFov = THREE.MathUtils.degToRad(cam.fov);
  const wantHalf = (heightToFrame * 0.5) * padding;
  const dist = wantHalf / Math.max(1e-4, Math.tan(vFov / 2));

  // Slightly offset camera Y to be level with eyes/face
  const dir = new THREE.Vector3(0, 0, 1).normalize();

  // Update camera
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.near = 0.01;
  cam.far = 100;
  cam.updateProjectionMatrix();

  if (ctrl) {
    ctrl.target.copy(center);
    ctrl.update();
  }
  cam.lookAt(center);
}

// Basic Three.js bootstrap
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const time = clock.getElapsedTime();

  // Procedural Breathing
  if (rig && rig.spine) {
    // A simple sine wave for breathing: ~0.3Hz (3.3s period)
    const breath = Math.sin(time * 2.0);
    // Rotate spine slightly on X axis (pitch)
    rig.spine.rotation.x = breath * 0.005; // Reduced from 0.03 for subtlety

    // Optional: slight counteract with neck
    if (rig.neck) rig.neck.rotation.x = -breath * 0.002;
  }

  // --- Eye Saccades ---
  if (leftEyeBone && rightEyeBone) {
    if (time > nextSaccadeTime) {
      // Pick new target: +/- 5 degrees roughly
      eyeTarget.x = (Math.random() - 0.5) * 0.15;
      eyeTarget.y = (Math.random() - 0.5) * 0.1;
      nextSaccadeTime = time + 0.2 + Math.random() * 2.0; // Wait 0.2 - 2.2s
    }
    // Smoothly move current to target
    eyeCurrent.x += (eyeTarget.x - eyeCurrent.x) * 0.1;
    eyeCurrent.y += (eyeTarget.y - eyeCurrent.y) * 0.1;

    // Apply (local rotation)
    // We assume eyes are roughly looking +Z or +Y. We add to their base.
    // Simplifying: just overwrite rotation since binding is usually 0,0,0,1 or close.
    // Better: setFromEuler additive.
    // For simplicity in this constrained task, we'll set rotation directly assuming standard rig (Y-up, Z-fwd).
    leftEyeBone.rotation.y = eyeCurrent.x;
    leftEyeBone.rotation.x = eyeCurrent.y;
    rightEyeBone.rotation.y = eyeCurrent.x; // Parallel
    rightEyeBone.rotation.x = eyeCurrent.y;
  }

  // --- Auto Blinking ---
  if (isBlinking) {
    const elapsed = time - blinkStartTime;
    if (elapsed >= BLINK_DURATION) {
      isBlinking = false;
      nextBlinkTime = time + 2.0 + Math.random() * 4.0;

      // Reset
      if (faceMeshMesh && eyeBlinkIndices.length > 0) {
        eyeBlinkIndices.forEach(idx => faceMeshMesh.morphTargetInfluences[idx] = 0);
      } else if (leftEyeBone && rightEyeBone) {
        leftEyeBone.scale.y = 1.0;
        rightEyeBone.scale.y = 1.0;
      }
    } else {
      // Bell curve 0 -> 1 -> 0
      const t = elapsed / BLINK_DURATION;
      const val = Math.sin(t * Math.PI);

      if (faceMeshMesh && eyeBlinkIndices.length > 0) {
        eyeBlinkIndices.forEach(idx => faceMeshMesh.morphTargetInfluences[idx] = val);
      } else if (leftEyeBone && rightEyeBone) {
        // Scale Y from 1.0 down to 0.1 and back
        const s = 1.0 - (val * 0.99); // min scale 0.01
        leftEyeBone.scale.y = s;
        rightEyeBone.scale.y = s;
      }
    }
  } else {
    if (time > nextBlinkTime) {
      isBlinking = true;
      blinkStartTime = time;
    }
  }

  controls.update();
  renderer.render(scene, camera);
}

// ---- MediaPipe FaceMesh wiring ----
let mpInitialized = false;
let mpCamera = null;
let faceMesh = null; // created by MP UMD build
let poseLandmarker = null; // MediaPipe Tasks Pose Landmarker
let lastPoseVideoTime = -1;

function setStatus(msg) {
  ui.status.textContent = msg;
}

function createFaceMesh() {
  return new Promise((resolve) => {
    // global FaceMesh from UMD exposes constructor `FaceMesh`
    // eslint-disable-next-line no-undef
    faceMesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      selfieMode: true,
    });
    faceMesh.onResults(onFaceResults);
    mpInitialized = true;
    resolve();
  });
}

async function createPoseLandmarker() {
  // Load WASM and create a PoseLandmarker instance in VIDEO mode
  const wasmBase = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
  const vision = await FilesetResolver.forVisionTasks(wasmBase);
  const primaryModel = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  const fallbackModel = 'https://storage.googleapis.com/mediapipe-assets/pose_landmarker_lite.task';
  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: primaryModel, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      outputSegmentationMasks: false,
    });
  } catch (e) {
    // Fallback URL (older bucket) if primary fails
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: fallbackModel, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      outputSegmentationMasks: false,
    });
  }
}


function startCamera() {
  return new Promise((resolve, reject) => {
    const video = ui.inputVideo;
    setStatus('Requesting camera…');
    const cam = new Camera(video, {
      onFrame: async () => {
        if (faceMesh) {
          await faceMesh.send({ image: video });
        }
        if (poseLandmarker) {
          const ts = performance.now();
          if (video.currentTime !== lastPoseVideoTime) {
            const res = poseLandmarker.detectForVideo(video, ts);
            onPoseResultsTasks(res);
            lastPoseVideoTime = video.currentTime;
          }
        }
      },
      width: 480,
      height: 640,
    });
    cam.start().then(() => {
      mpCamera = cam;
      setStatus('Tracking active');
      trackingActive = true;
      resolve();
    }).catch(reject);
  });
}

// A lightweight head pose estimation from landmarks
// Uses eye line for roll, nose offset for yaw/pitch. Not perfect but performant and robust on mobile.

// Calibration state
let initialPitch = null;

function estimateHeadEuler(landmarks) {
  // landmark indices (MediaPipe canonical mesh)
  const LEFT_EYE_OUTER = 33;
  const RIGHT_EYE_OUTER = 263;
  const NOSE_TIP = 1;
  const FOREHEAD = 10;  // Top of forehead
  const CHIN = 152;     // Bottom of chin

  const pL = landmarks[LEFT_EYE_OUTER];
  const pR = landmarks[RIGHT_EYE_OUTER];
  const pN = landmarks[NOSE_TIP];
  const pForehead = landmarks[FOREHEAD];
  const pChin = landmarks[CHIN];

  const vx = pR.x - pL.x;
  const vy = pR.y - pL.y;
  const eyeDist = Math.max(1e-6, Math.hypot(vx, vy));
  const midX = (pL.x + pR.x) * 0.5;

  // Roll: tilt of eye line
  let roll = Math.atan2(vy, vx);

  // Yaw: nose horizontal offset vs eyes midpoint
  let yaw = Math.atan2((pN.x - midX), eyeDist);

  // Pitch: use 3D depth difference between forehead and chin
  // When tilting forward, chin.z < forehead.z (chin closer to camera)
  // When tilting backward, chin.z > forehead.z (forehead closer)
  let rawPitch = (pForehead.z - pChin.z) * 5.0;  // Scale up since z-diffs are small

  // Calibration: store initial pitch and subtract it
  if (initialPitch === null) {
    initialPitch = rawPitch;
  }
  let pitch = rawPitch - initialPitch;

  // Assume selfie view: flip yaw and roll to feel natural
  // yaw = -yaw; // Removed: was inverting left/right
  roll = -roll;

  // Convert to approximate head Euler in radians
  // Apply dampening; tuned empirically for stability
  const S = 1.0;
  return {
    x: THREE.MathUtils.clamp(-pitch * 2.0 * S, -0.8, 0.8),  // pitch -> X (inverted)
    y: THREE.MathUtils.clamp(yaw * 2.4 * S, -1.0, 1.0),    // yaw   -> Y
    z: THREE.MathUtils.clamp(-roll * 1.2 * S, -0.7, 0.7),  // roll  -> Z
  };
}

function onFaceResults(results) {
  if (!results || !results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) return;
  const landmarks = results.multiFaceLandmarks[0];
  const euler = estimateHeadEuler(landmarks);

  if (headBone && headBone.isBone) {
    // Smoothing: blend via quaternion slerp to reduce jitter
    const targetQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(euler.x, euler.y, euler.z, 'YXZ'));
    headBone.quaternion.slerp(targetQ, 0.15);
  } else if (avatar) {
    const targetQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(euler.x, euler.y, euler.z, 'YXZ'));
    avatar.quaternion.slerp(targetQ, 0.15);
  }
}

ui.startBtn.addEventListener('click', async () => {
  ui.startBtn.disabled = true;

  try {
    if (!mpInitialized) await createFaceMesh();
    // Body tracking disabled
    // if (!poseLandmarker) await createPoseLandmarker();
    await startCamera();
  } catch (err) {
    console.error(err);
    setStatus('Camera failed: ' + (err && err.message ? err.message : 'unknown error'));
    ui.startBtn.disabled = false;
  }
});

// Close instructions
document.getElementById('closeInst').addEventListener('click', () => {
  document.getElementById('instructions').style.display = 'none';
});

// Boot
(async function boot() {
  initThree();
  try {
    await loadAvatar();
    if (headBone) {
      setStatus('Avatar loaded (Head found). Click Start Camera');
    } else {
      setStatus('Avatar loaded (NO HEAD BONE). Check console.');
    }
    resolveRigBonesOnce(); // Needed for breathing animation
  } catch (e) {
    console.error('Failed to load avatar.glb', e);
    setStatus('Failed to load avatar.glb');
  }
  animate();
})();

// Body tracking removed
function onPoseResultsTasks(results) {
  // Disabled
}

// Resolve common torso bones once
function resolveRigBonesOnce() {
  if (!avatar) return;
  if (rig._resolved) return;
  const find = (pred) => {
    let out = null;
    avatar.traverse((o) => {
      if (out || !o.isBone) return;
      const n = (o.name || '').toLowerCase();
      if (pred(n)) out = o;
    });
    return out;
  };
  rig.spine = find((s) => s.includes('spine1') || (s.includes('spine') && !s.includes('spine2')));
  rig.chest = find((s) => s.includes('chest') || s.includes('spine2'));
  rig.neck = find((s) => s.includes('neck'));
  // Arms
  const L = (n) => (s) => s.includes(n) && (s.includes('left') || s.endsWith('.l') || s.includes(' l') || s.includes('_l'));
  const R = (n) => (s) => s.includes(n) && (s.includes('right') || s.endsWith('.r') || s.includes(' r') || s.includes('_r'));
  rig.upperArmL = find(L('upperarm')) || find(L('arm')) || find(L('shoulder'));
  rig.lowerArmL = find(L('lowerarm')) || find(L('forearm'));
  rig.upperArmR = find(R('upperarm')) || find(R('arm')) || find(R('shoulder'));
  rig.lowerArmR = find(R('lowerarm')) || find(R('forearm'));

  // Cache bind orientation and rest direction for the arm bones
  const cacheRest = (bone) => {
    if (!bone || !bone.parent) return;
    if (!bindRotations.has(bone.uuid)) bindRotations.set(bone.uuid, bone.quaternion.clone());
    if (!restDirs.has(bone.uuid)) {
      let childBone = null;
      for (const c of bone.children) { if (c.isBone) { childBone = c; break; } }
      if (childBone) {
        const parent = bone.parent;
        const A = parent.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
        const B = parent.worldToLocal(childBone.getWorldPosition(new THREE.Vector3()));
        const dir = B.sub(A).normalize();
        if (dir.lengthSq() > 1e-6) restDirs.set(bone.uuid, dir);
        // derive a perpendicular axis from the bind orientation (parent space)
        const xBind = new THREE.Vector3(1, 0, 0).applyQuaternion(bone.quaternion); // local X in parent space
        const perp = xBind.clone().sub(dir.clone().multiplyScalar(xBind.dot(dir))).normalize();
        if (perp.lengthSq() > 1e-6) restPerp.set(bone.uuid, perp);
      }
    }
  };
  cacheRest(rig.upperArmL); cacheRest(rig.lowerArmL);
  cacheRest(rig.upperArmR); cacheRest(rig.lowerArmR);
  rig._resolved = true;
}

// Two-bone arm aim: parent space vectors from shoulder->elbow and elbow->wrist
function aimTwoBoneArm(upper, lower, shoulderW, elbowW, wristW, poleWorld) {
  if (!upper || !lower || !upper.parent || !lower.parent) return;
  const parent = upper.parent;
  const S = parent.worldToLocal(shoulderW.clone());
  const E = parent.worldToLocal(elbowW.clone());
  const W = parent.worldToLocal(wristW.clone());
  const dirUpper = E.clone().sub(S).normalize();
  const dirLower = W.clone().sub(E).normalize();

  const restU = restDirs.get(upper.uuid) || new THREE.Vector3(0, 1, 0);
  const restL = restDirs.get(lower.uuid) || new THREE.Vector3(0, 1, 0);
  // Base swing (rest -> direction)
  const qBaseU = new THREE.Quaternion().setFromUnitVectors(restU, dirUpper);
  // Twist around dir to align with pole
  let poleLocal = poleWorld ? poleWorld.clone().applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize() : null;
  const restT = restPerp.get(upper.uuid) || new THREE.Vector3(1, 0, 0);
  const tNow = restT.clone().applyQuaternion(qBaseU);
  const proj = (v) => v.clone().sub(dirUpper.clone().multiplyScalar(v.dot(dirUpper))).normalize();
  const a = proj(tNow);
  const b = poleLocal ? proj(poleLocal) : a;
  let angle = Math.atan2(dirUpper.clone().dot(a.clone().cross(b)), a.dot(b));
  const MAX_TWIST = Math.PI * 0.8; // clamp
  angle = THREE.MathUtils.clamp(angle, -MAX_TWIST, MAX_TWIST);
  const qTwistU = new THREE.Quaternion().setFromAxisAngle(dirUpper, angle);
  const qU = qTwistU.multiply(qBaseU);

  const qL = new THREE.Quaternion().setFromUnitVectors(restL, dirLower);
  const bindU = bindRotations.get(upper.uuid) || new THREE.Quaternion();
  const bindL = bindRotations.get(lower.uuid) || new THREE.Quaternion();

  // Apply with smoothing and small limits to avoid extremes
  const qTargetU = qU.multiply(bindU);
  const qTargetL = qL.multiply(bindL);
  upper.quaternion.slerp(qTargetU, 0.35);
  lower.quaternion.slerp(qTargetL, 0.4);
}

// Pose/retargeting removed to return to head-only tracking
