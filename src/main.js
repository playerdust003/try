import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ===== 全局变量 =====
let scene, renderer;
let cameraFirst, cameraThird;
let playerBody;
let controls;

let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let isFirstPerson = true;
const clock = new THREE.Clock();
const moveSpeed = 6;

let smoothYaw = 0;
const smoothFactor = 0.12;

// 靶场/射击相关
let targetTex;
let gunFP, gunTP;
let score = 0, recoil = 0, flashTimer = 0;
const targets = [];
const movers = [];
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
let crosshairEl, scoreEl;
let audioCtx;

init();
animate();

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 30, 130);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // 环境光
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);

    // 平行光（主光源）
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(30, 50, 20);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -45;
    dirLight.shadow.camera.right = 45;
    dirLight.shadow.camera.top = 45;
    dirLight.shadow.camera.bottom = -45;
    dirLight.shadow.camera.far = 150;
    dirLight.shadow.camera.updateProjectionMatrix();
    scene.add(dirLight);

    // 原始瓷砖地面（保留作为远景）
    const tileSize = 8;
    const groundSize = 120;
    const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
    const groundMat = new THREE.MeshStandardMaterial({
        color: 0xf8f8f8,
        roughness: 0.22,
        metalness: 0.12,
        envMapIntensity: 1.0
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#d8d8d8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
    const tileTexture = new THREE.CanvasTexture(canvas);
    tileTexture.wrapS = THREE.RepeatWrapping;
    tileTexture.wrapT = THREE.RepeatWrapping;
    tileTexture.repeat.set(groundSize / tileSize, groundSize / tileSize);
    groundMat.map = tileTexture;
    groundMat.needsUpdate = true;

    // ===== 玩家模型（胶囊人体，保留基础特征） =====
    playerBody = new THREE.Group();
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffd2b4, roughness: 0.6 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x2d1b0e, roughness: 0.9 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0 });
    const shirtMat = new THREE.MeshStandardMaterial({ color: 0x2176ff, roughness: 0.65 });
    const pantMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });
    const shoeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });

    // 头部（球）
    const headGeo = new THREE.SphereGeometry(0.35, 24, 24);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.75;
    head.castShadow = true;
    playerBody.add(head);

    // 头发
    const hairTop = new THREE.Mesh(new THREE.SphereGeometry(0.37, 24, 24), hairMat);
    hairTop.scale.set(1, 0.5, 1);
    hairTop.position.y = 1.97;
    playerBody.add(hairTop);

    // 眼睛
    const eyeGeo = new THREE.SphereGeometry(0.05, 12, 12);
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.13, 1.78, 0.31);
    playerBody.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.13, 1.78, 0.31);
    playerBody.add(rightEye);

    // 躯干（胶囊/圆柱）
    const torsoGeo = new THREE.CylinderGeometry(0.28, 0.25, 0.6, 20);
    const torso = new THREE.Mesh(torsoGeo, shirtMat);
    torso.position.y = 1.15;
    torso.castShadow = true;
    playerBody.add(torso);

    // 手臂
    const upperArmGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.35, 12);
    const forearmGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.3, 12);

    // 左手臂
    const leftUpperArm = new THREE.Mesh(upperArmGeo, shirtMat);
    leftUpperArm.position.set(-0.42, 1.25, 0);
    leftUpperArm.rotation.z = 0.25;
    playerBody.add(leftUpperArm);
    const leftForearm = new THREE.Mesh(forearmGeo, skinMat);
    leftForearm.position.set(-0.65, 1.0, 0.04);
    leftForearm.rotation.z = 0.3;
    playerBody.add(leftForearm);
    // 左手（球）
    const leftHand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), skinMat);
    leftHand.position.set(-0.78, 0.88, 0.05);
    playerBody.add(leftHand);

    // 右手臂
    const rightUpperArm = new THREE.Mesh(upperArmGeo, shirtMat);
    rightUpperArm.position.set(0.42, 1.25, 0);
    rightUpperArm.rotation.z = -0.25;
    playerBody.add(rightUpperArm);
    const rightForearm = new THREE.Mesh(forearmGeo, skinMat);
    rightForearm.position.set(0.65, 1.0, 0.04);
    rightForearm.rotation.z = -0.3;
    playerBody.add(rightForearm);
    // 右手（球）
    const rightHand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), skinMat);
    rightHand.position.set(0.78, 0.88, 0.05);
    playerBody.add(rightHand);

    // 腿
    const thighGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.4, 12);
    const calfGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.35, 12);

    // 左腿
    const leftThigh = new THREE.Mesh(thighGeo, pantMat);
    leftThigh.position.set(-0.15, 0.55, 0);
    playerBody.add(leftThigh);
    const leftCalf = new THREE.Mesh(calfGeo, pantMat);
    leftCalf.position.set(-0.15, 0.18, 0);
    playerBody.add(leftCalf);
    // 左脚
    const leftShoe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.3), shoeMat);
    leftShoe.position.set(-0.15, 0.05, 0.1);
    playerBody.add(leftShoe);

    // 右腿
    const rightThigh = new THREE.Mesh(thighGeo, pantMat);
    rightThigh.position.set(0.15, 0.55, 0);
    playerBody.add(rightThigh);
    const rightCalf = new THREE.Mesh(calfGeo, pantMat);
    rightCalf.position.set(0.15, 0.18, 0);
    playerBody.add(rightCalf);
    // 右脚
    const rightShoe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.3), shoeMat);
    rightShoe.position.set(0.15, 0.05, 0.1);
    playerBody.add(rightShoe);

    // 玩家出生在射击线后，面朝 -Z 方向
    playerBody.position.set(0, 0, 6);
    scene.add(playerBody);

    // 第一人称相机
    cameraFirst = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    cameraFirst.position.set(playerBody.position.x, playerBody.position.y + 1.9, playerBody.position.z);

    // 第三人称相机
    cameraThird = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

    controls = new PointerLockControls(cameraFirst, document.body);
    controls.pointerSpeed = 0.6;

    renderer.domElement.addEventListener('click', () => {
        controls.lock(true);
    });

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('resize', onWindowResize);

    // ===== 靶场 + 靶子 + 枪 + UI =====
    createRangeEnvironment();
    createAllTargets();
    setupGun();
    setupUI();
}

// ===== 键盘控制 =====
function onKeyDown(e) {
    switch (e.code) {
        case 'KeyW': moveForward = true; break;
        case 'KeyS': moveBackward = true; break;
        case 'KeyA': moveLeft = true; break;
        case 'KeyD': moveRight = true; break;
        case 'KeyY': isFirstPerson = !isFirstPerson; break;
    }
}

function onKeyUp(e) {
    switch (e.code) {
        case 'KeyW': moveForward = false; break;
        case 'KeyS': moveBackward = false; break;
        case 'KeyA': moveLeft = false; break;
        case 'KeyD': moveRight = false; break;
    }
}

function onWindowResize() {
    const w = window.innerWidth, h = window.innerHeight;
    cameraFirst.aspect = w / h;
    cameraFirst.updateProjectionMatrix();
    cameraThird.aspect = w / h;
    cameraThird.updateProjectionMatrix();
    renderer.setSize(w, h);
}

// ===== 射击 =====
function onMouseDown(e) {
    if (e.button === 0 && controls.isLocked) shoot();
}

function shoot() {
    recoil = 1;
    flashTimer = 0.06;
    if (isFirstPerson) {
        raycaster.setFromCamera(screenCenter, cameraFirst);
    } else {
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(playerBody.quaternion);
        raycaster.set(playerBody.position.clone().add(new THREE.Vector3(0, 1.4, 0)), dir);
    }
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => h.object.userData.state === 'idle');
    if (hit) {
        const board = hit.object;
        board.userData.state = 'falling';
        board.userData.t = 0;
        score += 10;
        scoreEl.textContent = '得分：' + score;
        beep(880, 0.08);
    }
}

// ===== 动画循环 =====
function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(0.1, clock.getDelta());

    cameraFirst.position.copy(playerBody.position);
    cameraFirst.position.y += 1.9;

    const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    camEuler.setFromQuaternion(cameraFirst.quaternion);

    const targetYaw = camEuler.y;
    smoothYaw += (targetYaw - smoothYaw) * smoothFactor;
    playerBody.rotation.y = smoothYaw;

    const forward = new THREE.Vector3(0, 0, -1);
    const right = new THREE.Vector3(1, 0, 0);
    forward.applyQuaternion(playerBody.quaternion);
    right.applyQuaternion(playerBody.quaternion);

    const moveVec = new THREE.Vector3();
    if (moveForward) moveVec.add(forward);
    if (moveBackward) moveVec.sub(forward);
    if (moveRight) moveVec.add(right);
    if (moveLeft) moveVec.sub(right);

    if (moveVec.length() > 0) {
        moveVec.normalize();
        moveVec.multiplyScalar(moveSpeed * delta);
        playerBody.position.add(moveVec);
    }

    // 玩家活动范围限制
    playerBody.position.x = THREE.MathUtils.clamp(playerBody.position.x, -10, 10);
    playerBody.position.z = THREE.MathUtils.clamp(playerBody.position.z, -1, 9);

    // 第三人称相机跟随
    const offset = new THREE.Vector3(0, 3, 6);
    offset.applyQuaternion(playerBody.quaternion);
    cameraThird.position.copy(playerBody.position).add(offset);
    cameraThird.lookAt(playerBody.position.x, playerBody.position.y + 1.1, playerBody.position.z);

    // 更新靶子和枪
    updateTargets(delta);
    updateGun(delta);

    if (isFirstPerson) {
        renderer.render(scene, cameraFirst);
    } else {
        renderer.render(scene, cameraThird);
    }
}

// ========== 第 1 步：靶场环境 ==========
function createRangeEnvironment() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.95 });
    const sandMat = new THREE.MeshStandardMaterial({ color: 0xd9c48a, roughness: 1.0 });
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2c744 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a6642, roughness: 0.9 });

    const addBox = (w, h, d, x, y, z, mat) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        m.receiveShadow = true;
        scene.add(m);
        return m;
    };

    // 射击区水泥地面（铺在原瓷砖上，抬高 2cm 避免闪烁）
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(23, 46),
        new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.02, -8);
    floor.receiveShadow = true;
    scene.add(floor);

    // 左右侧墙 + 后挡弹墙
    addBox(0.4, 3.5, 46, -11, 1.75, -8, wallMat);
    addBox(0.4, 3.5, 46, 11, 1.75, -8, wallMat);
    addBox(23, 6, 0.8, 0, 3, -30.4, wallMat);

    // 挡弹沙坡（斜放的长盒子，靠墙一侧抬高）
    const berm = addBox(21, 0.6, 7, 0, 1.0, -26.5, sandMat);
    berm.rotation.x = 0.3;

    // 射击线（黄）+ 距离标线
    addBox(22, 0.04, 0.25, 0, 0.06, 4, lineMat);
    for (const z of [-10, -18]) addBox(22, 0.04, 0.12, 0, 0.06, z, lineMat);

    // 装饰木箱
    addBox(0.9, 0.9, 0.9, -9.2, 0.45, -2, woodMat);
    const crate2 = addBox(0.9, 0.9, 0.9, -9.0, 1.35, -2.2, woodMat);
    crate2.rotation.y = 0.5;
    addBox(0.9, 0.9, 0.9, 9.2, 0.45, -16, woodMat);
}

// ========== 第 2 步：靶子系统 ==========
function makeTargetTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const rings = [[128, '#f2f2f2'], [104, '#d62839'], [80, '#f2f2f2'],
                   [56, '#d62839'], [32, '#f2f2f2'], [12, '#d62839']];
    for (const [r, color] of rings) {
        ctx.beginPath();
        ctx.arc(128, 128, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function createTarget(x, z, opts = {}) {
    const g = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a6642, roughness: 0.9 });
    const board = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 1.2),
        new THREE.MeshStandardMaterial({ map: targetTex, side: THREE.DoubleSide, roughness: 0.85 })
    );
    board.position.y = 1.55;
    board.castShadow = true;
    board.userData = { state: 'idle', t: 0, timer: 0, root: g };
    g.add(board);
    for (const sx of [-0.5, 0.5]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.7, 0.08), woodMat);
        post.position.set(sx, 0.85, -0.06);
        post.castShadow = true;
        g.add(post);
    }
    g.position.set(x, 0, z);
    scene.add(g);
    targets.push(board);
    if (opts.moving) {
        movers.push({ root: g, board, baseX: x, amp: opts.amp ?? 4,
                      speed: opts.speed ?? 1.2, phase: opts.phase ?? 0, t: 0 });
    }
    return g;
}

function createAllTargets() {
    targetTex = makeTargetTexture();
    // 固定靶
    createTarget(-6, -10);
    createTarget(2, -10);
    createTarget(-2, -18);
    createTarget(6, -18);
    // 移动靶
    createTarget(0, -14, { moving: true, amp: 5, speed: 1.3 });
    createTarget(-3, -22, { moving: true, amp: 3.5, speed: 0.9, phase: Math.PI / 2 });
}

function updateTargets(delta) {
    for (const m of movers) {
        if (m.board.userData.state === 'idle') m.t += delta;
        m.root.position.x = m.baseX + Math.sin(m.t * m.speed + m.phase) * m.amp;
    }
    for (const board of targets) {
        const u = board.userData;
        if (u.state === 'falling') {
            u.t = Math.min(1, u.t + delta * 3.5);
            u.root.rotation.x = -u.t * Math.PI / 2 * 0.92;
            if (u.t >= 1) { u.state = 'down'; u.timer = 1.2; }
        } else if (u.state === 'down') {
            u.timer -= delta;
            if (u.timer <= 0) u.state = 'rising';
        } else if (u.state === 'rising') {
            u.t = Math.max(0, u.t - delta * 3.5);
            u.root.rotation.x = -u.t * Math.PI / 2 * 0.92;
            if (u.t <= 0) u.state = 'idle';
        }
    }
}

// ========== 第 3 步：枪模型 ==========
function makeGun() {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.45, metalness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.55), metal);
    body.position.set(0, 0.02, -0.05);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.42, 12), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.05, -0.5);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.22, 0.14), dark);
    grip.position.set(0, -0.16, 0.12);
    grip.rotation.x = 0.25;
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 0.1), dark);
    mag.position.set(0, -0.17, -0.12);
    mag.rotation.x = -0.15;
    const sightF = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.02), dark);
    sightF.position.set(0, 0.13, -0.3);
    const sightB = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.02), dark);
    sightB.position.set(0, 0.12, 0.15);
    // 枪口火焰
    const flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95 })
    );
    flash.position.set(0, 0.05, -0.74);
    flash.visible = false;
    g.add(body, barrel, grip, mag, sightF, sightB, flash);
    g.userData.flash = flash;
    return g;
}

function setupGun() {
    scene.add(cameraFirst);
    // 第一人称：挂在相机下
    gunFP = makeGun();
    gunFP.position.set(0.24, -0.2, -0.42);
    gunFP.rotation.y = -0.06;
    gunFP.userData.baseZ = -0.42;
    cameraFirst.add(gunFP);
    // 第三人称：挂在角色右胸前
    gunTP = makeGun();
    gunTP.position.set(0.45, 1.2, -0.3);
    gunTP.userData.baseZ = -0.3;
    gunTP.visible = false;
    playerBody.add(gunTP);
}

function updateGun(delta) {
    flashTimer = Math.max(0, flashTimer - delta);
    recoil = Math.max(0, recoil - delta * 6);
    gunFP.visible = isFirstPerson;
    gunTP.visible = !isFirstPerson;
    crosshairEl.style.display = isFirstPerson ? 'block' : 'none';
    const gun = isFirstPerson ? gunFP : gunTP;
    gun.position.z = gun.userData.baseZ + recoil * 0.07;
    gun.userData.flash.visible = flashTimer > 0;
}

// ========== 第 4 步：UI 和音效 ==========
function setupUI() {
    crosshairEl = document.createElement('div');
    crosshairEl.style.cssText = 'position:fixed;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 3px rgba(0,0,0,.6);pointer-events:none;z-index:9';
    document.body.appendChild(crosshairEl);
    scoreEl = document.createElement('div');
    scoreEl.style.cssText = 'position:fixed;left:14px;top:14px;color:#fff;font:600 18px/1.4 system-ui;text-shadow:0 1px 3px rgba(0,0,0,.7);z-index:9';
    scoreEl.textContent = '得分：0';
    document.body.appendChild(scoreEl);
}

function beep(freq = 880, dur = 0.08) {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.connect(gain).connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
}
