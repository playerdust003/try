import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
    setupLightingAndEnvironment,
    createRangeEnvironment,
    createRangeDecorBuildings,
    makeTargetTexture,
    createTarget as createTargetScene,
    createSandbagWall,
    getRangeColliders,
    setupPostProcessing,
    resizeComposer,
    updateSceneAtmosphere
} from './scene.js';
// ===== 全局变量 =====
let scene, renderer;
let cameraFirst, cameraThird;
let playerBody;
let controls;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let isFirstPerson = true;
// 灵魂出窍自由相机
let cameraFree;
let isSoulMode = false;
let soulYaw = 0, soulPitch = 0;
let soulFlyUp = false, soulFlyDown = false;
let savedCameraQuat = null;
let soulHintEl;
const clock = new THREE.Clock();
let moveSpeed = 6;
const smoothFactor = 0.12;
let smoothYaw = 0;
// 靶场/射击相关
let targetTex;
let gunFP, heldGun;
let score = 0, recoil = 0, flashTimer = 0;
const targets = [];
const movers = [];
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
let crosshairEl, scoreEl;
let audioCtx;
// 跳跃（空格键）
let playerVelY = 0;
const JUMP_SPEED = 5.0;      // 起跳初速度（m/s），跳跃高度约 1.25m
const JUMP_GRAVITY = 10.0;   // 跳跃重力（m/s²）
// 靶子倒下/起立动画
const FALL_DURATION = 0.45;  // 倒下动画时长（秒）
const RISE_DURATION = 0.4;   // 起立动画时长（秒）
const RESPAWN_DELAY = 5.0;   // 倒下后自动刷新（恢复起立）的等待秒数
// 后处理
let composer, renderPass, bloomPass;

// 适配旧调用签名的包装：createTarget(x, z, opts)
function createTarget(x, z, opts = {}) {
    return createTargetScene(scene, targetTex, targets, movers, x, z, opts);
}

// 子弹系统
const BULLET_SPEED = 400;    // 初速（米/秒）
const GRAVITY = 6;          // 弹道下坠，设 0 = 直线
const TRAIL_LEN = 18;       // 增大拖尾采样点数，高速子弹也能看到轨迹
const bullets = [];         // 正在飞行的子弹
const bulletGeo = new THREE.SphereGeometry(0.08, 10, 10);
const glowGeo   = new THREE.SphereGeometry(0.16, 10, 10);
const bulletMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffcc33, emissiveIntensity: 2.2, roughness: 0.3
});
const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffdd66, transparent: true, opacity: 0.45,
    blending: THREE.AdditiveBlending, depthWrite: false
});
const trailMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false
});
const bulletRay = new THREE.Raycaster();
const bulletTmp = new THREE.Vector3();

// 硝烟粒子系统
const smokeParticles = [];
const smokeGeo = new THREE.SphereGeometry(0.12,8,8);
const smokeMat = new THREE.MeshBasicMaterial({
    color:0xaaaaaa, transparent:true, opacity:0.5, depthWrite:false
});
// 沙袋扬尘粒子（土黄色，复用 smokeParticles 更新循环）
const dustGeo = new THREE.SphereGeometry(0.1,8,8);
const dustMat = new THREE.MeshBasicMaterial({
    color:0xc4a872, transparent:true, opacity:0.6, depthWrite:false
});

// 靶子碎片系统
const targetFragments = [];
const fragmentGeo = new THREE.BoxGeometry(0.12,0.12,0.04);
const fragmentMat = new THREE.MeshStandardMaterial({color:0xeeeeee, roughness:0.8});

// 设置面板相关
let settingPanelEl;
let showSettings = false;
let sensMultiplier = 1.0;
const basePointerSpeed = 0.6;
let crosshairSize = 8;
let crosshairColor = '#ffffff';

init();
animate();

function init() {
    scene = new THREE.Scene();
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(renderer.domElement);
    // 光照 + IBL 环境（HDR、半球光、PCFSoftShadowMap、ACESFilmicToneMapping）
    setupLightingAndEnvironment(scene, renderer);
    // ===== 玩家模型（stickman GLB + 手持枪） =====
    playerBody = new THREE.Group();
    const charLoader = new GLTFLoader();
    charLoader.load('models/stickman.glb', (gltf) => {
        const stickman = gltf.scene;
        // 归一化：模型高约 5.46 单位 → 缩放到 1.8m
        const box = new THREE.Box3().setFromObject(stickman);
        const size = new THREE.Vector3();
        box.getSize(size);
        const s = 1.8 / size.y;
        stickman.scale.setScalar(s);
        // 脚贴地面
        stickman.position.y = -box.min.y * s;
        // 脸朝靶场方向（-Z）：模型原正面为 +Z，旋转 180°
        stickman.rotation.y = Math.PI;
        stickman.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        playerBody.add(stickman);
        // 把枪挂到前伸的左手（HandAim）上
        const hand = stickman.getObjectByName('HandAim');
        if (hand) {
            heldGun = makeGun();
            heldGun.rotation.y = Math.PI;        // makeGun 枪管原朝 -Z，翻转后沿手的 +Z（世界 -Z）
            heldGun.position.set(0, 0, 0.12);    // 握把对齐手心
            hand.add(heldGun);
        }
    });
    // 玩家出生在射击线后，面朝 -Z 方向
    playerBody.position.set(0, 0, 6);
    scene.add(playerBody);
    // 第一人称相机
    cameraFirst = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    cameraFirst.position.set(playerBody.position.x, playerBody.position.y + 1.62, playerBody.position.z);
    // 第三人称相机
    cameraThird = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    // 灵魂出窍自由相机
    cameraFree = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
    controls = new PointerLockControls(cameraFirst, document.body);
    controls.pointerSpeed = basePointerSpeed;
    renderer.domElement.addEventListener('click', () => {
        controls.lock(true);
    });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('resize', onWindowResize);
    // 灵魂出窍模式：鼠标转头
    document.addEventListener('mousemove', (e) => {
        if (isSoulMode && controls.isLocked) {
            const sens = controls.pointerSpeed;
            soulYaw -= e.movementX * 0.002 * sens;
            soulPitch -= e.movementY * 0.002 * sens;
            soulPitch = THREE.MathUtils.clamp(soulPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        }
    });
    // ===== 靶场 + 靶子 + 枪 + UI =====
    createRangeEnvironment(scene);
    createRangeDecorBuildings(scene);
    createAllTargets();
    setupGun();
    setupUI();
    setupSettingPanel();
    // 后处理：EffectComposer + UnrealBloomPass + ACES Output
    const pp = setupPostProcessing(renderer, scene, cameraFirst);
    composer = pp.composer;
    renderPass = pp.renderPass;
    bloomPass = pp.bloomPass;
}
// ===== 键盘控制 =====
function onKeyDown(e) {
    switch (e.code) {
        case 'KeyW': moveForward = true; break;
        case 'KeyS': moveBackward = true; break;
        case 'KeyA': moveLeft = true; break;
        case 'KeyD': moveRight = true; break;
        case 'KeyY': isFirstPerson = !isFirstPerson; break;
        case 'KeyV': toggleSoulMode(); break;
        case 'Space':
            if (isSoulMode) {
                soulFlyUp = true;
            } else if (!e.repeat && playerBody.position.y <= 0.001) {
                // 跳跃：仅在地面且非长按重复触发时起跳
                playerVelY = JUMP_SPEED;
            }
            e.preventDefault(); break;
        case 'ShiftLeft': soulFlyDown = true; break;
        case 'Tab':
            e.preventDefault();
            showSettings = !showSettings;
            settingPanelEl.style.display = showSettings ? 'block' : 'none';
            break;
    }
}
function onKeyUp(e) {
    switch (e.code) {
        case 'KeyW': moveForward = false; break;
        case 'KeyS': moveBackward = false; break;
        case 'KeyA': moveLeft = false; break;
        case 'KeyD': moveRight = false; break;
        case 'Space': soulFlyUp = false; break;
        case 'ShiftLeft': soulFlyDown = false; break;
    }
}
function onWindowResize() {
    const w = window.innerWidth, h = window.innerHeight;
    cameraFirst.aspect = w / h;
    cameraFirst.updateProjectionMatrix();
    cameraThird.aspect = w / h;
    cameraThird.updateProjectionMatrix();
    renderer.setSize(w, h);
    resizeComposer(composer, w, h);
    cameraFree.aspect = w / h;
    cameraFree.updateProjectionMatrix();
}
// ===== 灵魂出窍自由相机 =====
function toggleSoulMode() {
    isSoulMode = !isSoulMode;
    if (isSoulMode) {
        // 保存当前朝向，退出时恢复（防跳变）
        savedCameraQuat = cameraFirst.quaternion.clone();
        // 从当前视角出发
        cameraFree.position.copy(cameraFirst.position);
        cameraFree.rotation.order = 'YXZ';
        const e = new THREE.Euler(0, 0, 0, 'YXZ');
        e.setFromQuaternion(cameraFirst.quaternion);
        soulYaw = e.y;
        soulPitch = e.x;
        // 若未锁定指针，请求锁定
        if (!controls.isLocked) controls.lock(true);
        // 显示提示条
        if (!soulHintEl) {
            soulHintEl = document.createElement('div');
            soulHintEl.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);color:#ffd070;font:600 15px/1.4 system-ui;text-shadow:0 1px 3px rgba(0,0,0,.8);z-index:9;pointer-events:none;white-space:nowrap;';
            document.body.appendChild(soulHintEl);
        }
        soulHintEl.textContent = '灵魂出窍 — V退出 | WASD飞行 | 空格升 | Shift降';
        soulHintEl.style.display = 'block';
    } else {
        // 恢复 cameraFirst 朝向
        if (savedCameraQuat) {
            cameraFirst.quaternion.copy(savedCameraQuat);
            savedCameraQuat = null;
        }
        if (soulHintEl) soulHintEl.style.display = 'none';
    }
}
function updateSoulCamera(delta) {
    cameraFree.rotation.set(soulPitch, soulYaw, 0);
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(cameraFree.rotation);
    const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, soulYaw, 0, 'YXZ'));
    const moveVec = new THREE.Vector3();
    if (moveForward) moveVec.add(forward);
    if (moveBackward) moveVec.sub(forward);
    if (moveRight) moveVec.add(right);
    if (moveLeft) moveVec.sub(right);
    if (soulFlyUp) moveVec.y += 1;
    if (soulFlyDown) moveVec.y -= 1;
    if (moveVec.length() > 0) {
        moveVec.normalize().multiplyScalar(25 * delta);
        cameraFree.position.add(moveVec);
    }
}
// ===== 射击 =====
function onMouseDown(e) {
    if (e.button === 0 && controls.isLocked && !isSoulMode) shoot();
}
function shoot() {
    spawnBullet();
}
function spawnBullet() {
    const gun = isFirstPerson ? gunFP : heldGun;
    const muzzle = gun.userData.flash.getWorldPosition(new THREE.Vector3());
    spawnMuzzleSmoke(muzzle);
    let aimPoint;
    if (isFirstPerson) {
        aimPoint = new THREE.Vector3(0, 0, -1)
            .applyQuaternion(cameraFirst.quaternion)
            .multiplyScalar(60)
            .add(cameraFirst.position);
    } else {
        aimPoint = playerBody.position.clone().add(new THREE.Vector3(0, 1.4, 0));
        aimPoint.add(new THREE.Vector3(0, 0, -1)
            .applyQuaternion(playerBody.quaternion)
            .multiplyScalar(60));
    }
    const dir = aimPoint.sub(muzzle).normalize();
    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    mesh.position.copy(muzzle);
    mesh.add(new THREE.Mesh(glowGeo, glowMat));
    scene.add(mesh);
    const positions = new Float32Array(TRAIL_LEN * 3);
    const colors = new Float32Array(TRAIL_LEN * 4);
    for (let i = 0; i < TRAIL_LEN; i++) {
        positions[i * 3]     = muzzle.x;
        positions[i * 3 + 1] = muzzle.y;
        positions[i * 3 + 2] = muzzle.z;
        colors[i * 4]     = 1.0;
        colors[i * 4 + 1] = 0.85;
        colors[i * 4 + 2] = 0.35;
        colors[i * 4 + 3] = (i / (TRAIL_LEN - 1)) * 0.9;
    }
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    trailGeo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const trail = new THREE.Line(trailGeo, trailMat);
    trail.frustumCulled = false;
    scene.add(trail);
    bullets.push({
        mesh, trail,
        vel: dir.multiplyScalar(BULLET_SPEED),
        prev: muzzle.clone()
    });
    recoil = 1;
    flashTimer = 0.06;
    beep(160, 0.05);
}

// 沙袋墙命中扬尘（3~5 个土黄色小尘粒，复用 smokeParticles 更新循环）
function spawnSandbagDust(pos){
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
        const p = new THREE.Mesh(dustGeo, dustMat.clone());
        p.position.copy(pos);
        const spd = new THREE.Vector3(
            (Math.random()-0.5)*1.5,
            Math.random()*1.2 + 0.3,
            (Math.random()-0.5)*1.5
        );
        scene.add(p);
        smokeParticles.push({
            mesh: p,
            vel: spd,
            life: 0.6 + Math.random()*0.4,
            maxLife: 0.6 + Math.random()*0.4
        });
    }
}

// 枪口硝烟（粒子数量为原版一半，烟雾更收敛）
function spawnMuzzleSmoke(pos){
    const count = 6;
    for(let i=0;i<count;i++){
        const p = new THREE.Mesh(smokeGeo, smokeMat.clone());
        p.position.copy(pos);
        p.position.x += (Math.random()-0.5)*0.15;
        p.position.y += (Math.random()-0.5)*0.15;
        p.position.z += (Math.random()-0.5)*0.15;
        const spd = new THREE.Vector3(
            (Math.random()-0.5)*1.2,
            Math.random()*1.8 + 0.6,
            (Math.random()-0.5)*1.2
        );
        scene.add(p);
        smokeParticles.push({
            mesh:p,
            vel:spd,
            life: 1.0 + Math.random()*0.6,
            maxLife:1.0 + Math.random()*0.6
        })
    }
}
function updateSmoke(delta){
    for(let i = smokeParticles.length-1; i>=0;i--){
        const s = smokeParticles[i];
        s.life -= delta;
        if(s.life <=0){
            scene.remove(s.mesh);
            s.mesh.geometry.dispose();
            s.mesh.material.dispose();
            smokeParticles.splice(i,1);
            continue;
        }
        s.mesh.position.addScaledVector(s.vel, delta);
        s.vel.y -= 0.4 * delta;
        const scale = 1.0 + (1 - s.life/s.maxLife)*2.2;
        s.mesh.scale.setScalar(scale);
        s.mesh.material.opacity = 0.45 * (s.life / s.maxLife);
    }
}

// 靶子碎片生成
function spawnTargetFragments(pos){
    const fragCount = 14;
    for(let i=0;i<fragCount;i++){
        const m = new THREE.Mesh(fragmentGeo, fragmentMat.clone());
        m.position.copy(pos);
        m.castShadow = true;
        const vx = (Math.random()-0.5)*7;
        const vy = Math.random()*5 + 2;
        const vz = (Math.random()-0.5)*7;
        const rotVel = new THREE.Vector3(
            (Math.random()-0.5)*12,
            (Math.random()-0.5)*12,
            (Math.random()-0.5)*12
        );
        scene.add(m);
        targetFragments.push({
            mesh:m,
            vel:new THREE.Vector3(vx,vy,vz),
            rotVel:rotVel,
            life:2.8,
            grounded:false
        })
    }
}
function updateTargetFragments(delta){
    for(let i=targetFragments.length-1;i>=0;i--){
        const f = targetFragments[i];
        f.life -= delta;
        if(f.life <=0){
            scene.remove(f.mesh);
            f.mesh.geometry.dispose();
            f.mesh.material.dispose();
            targetFragments.splice(i,1);
            continue;
        }
        if(!f.grounded){
            f.vel.y -= 9.8 * delta;
            f.mesh.position.addScaledVector(f.vel, delta);
            f.mesh.rotation.x += f.rotVel.x * delta;
            f.mesh.rotation.y += f.rotVel.y * delta;
            f.mesh.rotation.z += f.rotVel.z * delta;
            if(f.mesh.position.y <= 0.1){
                f.mesh.position.y = 0.1;
                f.grounded = true;
                f.vel.set(0,0,0);
            }
        }
        const alpha = Math.min(1.0, f.life / 1.2);
        f.mesh.material.opacity = alpha;
        f.mesh.material.transparent = true;
    }
}

// ===== 动画循环 =====
function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(0.1, clock.getDelta());
    if (!isSoulMode) {
        cameraFirst.position.copy(playerBody.position);
        cameraFirst.position.y += 1.62;
        const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
        camEuler.setFromQuaternion(cameraFirst.quaternion);
        const targetYaw = camEuler.y;
        smoothYaw += (targetYaw - smoothYaw) * smoothFactor;
        playerBody.rotation.y = smoothYaw;

        // CS2急停移动逻辑
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
        playerBody.position.z = THREE.MathUtils.clamp(playerBody.position.z, -1, 13.5);
        // 跳跃物理：重力 + 落地检测（第一/三人称相机均跟随 playerBody.position.y）
        playerVelY -= JUMP_GRAVITY * delta;
        playerBody.position.y += playerVelY * delta;
        if (playerBody.position.y <= 0) {
            playerBody.position.y = 0;
            playerVelY = 0;
        }
        // 第三人称相机跟随
        const offset = new THREE.Vector3(0, 3, 6);
        offset.applyQuaternion(playerBody.quaternion);
        cameraThird.position.copy(playerBody.position).add(offset);
        cameraThird.position.z = Math.min(cameraThird.position.z, 14.55); // 防穿墙（后墙内侧 z=15，留 0.45m 安全距离）
        cameraThird.lookAt(playerBody.position.x, playerBody.position.y + 1.1, playerBody.position.z);
    } else {
        updateSoulCamera(delta);
    }

    updateTargets(delta);
    updateGun(delta);
    updateBullets(delta);
    updateSmoke(delta);
    updateTargetFragments(delta);
    updateSceneAtmosphere(delta);

    if (isSoulMode) {
        renderPass.camera = cameraFree;
    } else if (isFirstPerson) {
        renderPass.camera = cameraFirst;
    } else {
        renderPass.camera = cameraThird;
    }
    composer.render();
}

// ========== 靶场环境、靶子、外围装饰建筑 ==========
// （已迁移至 scene.js，本文件通过 import 调用）

function createAllTargets() {
    targetTex = makeTargetTexture();
    createTarget(-6, -10);
    createTarget(2, -10);
    createTarget(-2, -18);
    createTarget(6, -18);
    createTarget(0, -14, { moving: true, amp: 5, speed: 1.3 });
    createTarget(-3, -22, { moving: true, amp: 3.5, speed: 0.9, phase: Math.PI / 2 });
    // 新增 5 个靶子
    createTarget(-8, -14);
    createTarget(8, -14);
    createTarget(-9, -20);
    createTarget(3, -21);
    createTarget(3.5, -15, { moving: true, amp: 2.0, speed: 0.75, phase: 1.6 });
    // 6 个靶前低掩体（rows=2，顶高约 0.53m，不遮靶面）
    createSandbagWall(scene, -6, -8.6, 2.4, 2);
    createSandbagWall(scene,  2, -8.6, 2.4, 2);
    createSandbagWall(scene, -2, -16.8, 2.4, 2);
    createSandbagWall(scene,  6, -16.8, 2.4, 2);
    createSandbagWall(scene, -9, -18.6, 2.2, 2);
    createSandbagWall(scene,  3, -19.6, 2.2, 2);
}

function updateTargets(delta) {
    // 更新移动靶
    for (const m of movers) {
        if(m.board.userData.state !== 'alive') continue;
        m.t += delta;
        m.root.position.x = m.baseX + Math.sin(m.t * m.speed + m.phase) * m.amp;
    }

    // 靶子倒下 → 等待 5 秒 → 自动起立刷新（可反复击打）
    for (const b of targets) {
        const ud = b.userData;
        if (ud.state === 'falling') {
            // 倒下动画（先慢后快）
            ud.fallProgress += delta / FALL_DURATION;
            if (ud.fallProgress >= 1) {
                ud.fallProgress = 1;
                ud.state = 'dead';
                ud.respawnTimer = RESPAWN_DELAY; // 开始 5 秒刷新倒计时
            }
            const t = ud.fallProgress * ud.fallProgress;
            ud.root.rotation.x = -Math.PI / 2 * t;
        } else if (ud.state === 'dead') {
            // 倒下保持，倒计时结束自动刷新（起立）
            ud.respawnTimer -= delta;
            if (ud.respawnTimer <= 0) {
                ud.state = 'rising';
                ud.riseProgress = 0;
            }
        } else if (ud.state === 'rising') {
            // 起立动画（先快后慢，回到站立姿态）
            ud.riseProgress += delta / RISE_DURATION;
            if (ud.riseProgress >= 1) {
                ud.riseProgress = 1;
                ud.state = 'alive';           // 恢复可击打状态
                ud.root.rotation.x = 0;
            }
            const t = 1 - (1 - ud.riseProgress) * (1 - ud.riseProgress);
            ud.root.rotation.x = -Math.PI / 2 * (1 - t);
        }
    }
}

// ========== 枪模型 ==========
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
    const flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 8),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 2.2, 1.2), transparent: true, opacity: 0.95 })
    );
    flash.position.set(0, 0.05, -0.74);
    flash.visible = false;
    g.add(body, barrel, grip, mag, sightF, sightB, flash);
    g.userData.flash = flash;
    return g;
}
function setupGun() {
    scene.add(cameraFirst);
    gunFP = makeGun();
    gunFP.position.set(0.24, -0.2, -0.42);
    gunFP.rotation.y = -0.06;
    gunFP.userData.baseZ = -0.42;
    cameraFirst.add(gunFP);
}
function updateGun(delta) {
    flashTimer = Math.max(0, flashTimer - delta);
    recoil = Math.max(0, recoil - delta * 6);
    // 视角可见性：第一人称隐藏身体（防头挡视野），第三人称/灵魂模式显示
    playerBody.visible = isSoulMode || !isFirstPerson;
    gunFP.visible = isFirstPerson && !isSoulMode;
    crosshairEl.style.display = (isFirstPerson && !isSoulMode) ? 'block' : 'none';
    // 后坐力 + 枪口火光（视角枪）
    gunFP.position.z = gunFP.userData.baseZ + recoil * 0.07;
    gunFP.userData.flash.visible = flashTimer > 0;
    // 手持枪火光（第三人称/灵魂模式）
    if (heldGun) heldGun.userData.flash.visible = flashTimer > 0;
}

// ========== UI 设置面板 ==========
function setupUI() {
    crosshairEl = document.createElement('div');
    crosshairEl.style.cssText = 'position:fixed;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 3px rgba(0,0,0,.6);pointer-events:none;z-index:9';
    document.body.appendChild(crosshairEl);
    scoreEl = document.createElement('div');
    scoreEl.style.cssText = 'position:fixed;left:14px;top:14px;color:#fff;font:600 18px/1.4 system-ui;text-shadow:0 1px 3px rgba(0,0,0,.7);z-index:9';
    scoreEl.textContent = '得分：0';
    document.body.appendChild(scoreEl);
}

function setupSettingPanel(){
    settingPanelEl = document.createElement('div');
    settingPanelEl.style.cssText = `
        position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
        width:340px; padding:20px; background:rgba(20,20,20,0.85);
        color:#fff; border:1px solid #555; border-radius:8px; z-index:100;
        display:none; font-family:system-ui;
    `;
    const html = `
    <h3 style="margin:0 0 16px 0;text-align:center;">设置 (Tab关闭)</h3>
    <div style="margin-bottom:12px;">
        <label>鼠标灵敏度倍数：<span id="sensVal">1.00</span></label>
        <br>
        <input type="range" id="sensSlider" min="0.2" max="3.0" step="0.05" value="1.0" style="width:100%;">
        <div style="font-size:12px;color:#aaa;">实际游戏灵敏度 = 硬件DPI × 倍数 × ${basePointerSpeed}</div>
    </div>
    <div style="margin-bottom:12px;">
        <label>准星大小：<span id="crossSizeVal">8</span> px</label>
        <br>
        <input type="range" id="crossSizeSlider" min="2" max="24" step="1" value="8" style="width:100%;">
    </div>
    <div style="margin-bottom:8px;">
        <label>准星颜色：</label>
        <input type="color" id="crossColorInput" value="#ffffff">
    </div>
    <div style="margin-top:14px;font-size:12px;color:#aaa;text-align:center;">
        按 Tab 打开/关闭设置
    </div>
    `;
    settingPanelEl.innerHTML = html;
    document.body.appendChild(settingPanelEl);
    const sensSlider = settingPanelEl.querySelector('#sensSlider');
    const sensVal = settingPanelEl.querySelector('#sensVal');
    const crossSizeSlider = settingPanelEl.querySelector('#crossSizeSlider');
    const crossSizeVal = settingPanelEl.querySelector('#crossSizeVal');
    const crossColorInput = settingPanelEl.querySelector('#crossColorInput');

    sensSlider.addEventListener('input',()=>{
        sensMultiplier = parseFloat(sensSlider.value);
        sensVal.textContent = sensMultiplier.toFixed(2);
        controls.pointerSpeed = basePointerSpeed * sensMultiplier;
    });
    crossSizeSlider.addEventListener('input',()=>{
        crosshairSize = parseInt(crossSizeSlider.value,10);
        crossSizeVal.textContent = crosshairSize;
        crosshairEl.style.width = crosshairSize + 'px';
        crosshairEl.style.height = crosshairSize + 'px';
        crosshairEl.style.marginLeft = -(crosshairSize/2)+'px';
        crosshairEl.style.marginTop = -(crosshairSize/2)+'px';
    });
    crossColorInput.addEventListener('input',()=>{
        crosshairColor = crossColorInput.value;
        crosshairEl.style.borderColor = crosshairColor;
    });
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

// ========== 子弹碰撞、靶子击碎逻辑 ==========
function hitTarget(board) {
    const ud = board.userData;
    if(ud.state !== 'alive') return;
    ud.state = 'falling';      // 进入倒下状态，动画由 updateTargets 推进
    ud.fallProgress = 0;
    score += 10;
    scoreEl.textContent = '得分：' + score;
    beep(880, 0.08);
    // 生成碎片（保留命中反馈）
    const hitWorldPos = new THREE.Vector3();
    board.getWorldPosition(hitWorldPos);
    spawnTargetFragments(hitWorldPos);
    // 不再隐藏靶板：命中后向后倒下并保持，重新刷新（重载页面）后恢复起立
}

function removeBullet(index) {
    const b = bullets[index];
    scene.remove(b.mesh);
    scene.remove(b.trail);
    b.trail.geometry.dispose();
    bullets.splice(index, 1);
}

function updateBullets(delta) {
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.prev.copy(b.mesh.position);
        b.vel.y -= GRAVITY * delta;
        b.mesh.position.addScaledVector(b.vel, delta);
        const arr = b.trail.geometry.attributes.position.array;
        arr.copyWithin(0, 3);
        const n = (TRAIL_LEN - 1) * 3;
        arr[n]     = b.mesh.position.x;
        arr[n + 1] = b.mesh.position.y;
        arr[n + 2] = b.mesh.position.z;
        b.trail.geometry.attributes.position.needsUpdate = true;

        bulletTmp.subVectors(b.mesh.position, b.prev);
        const segLen = bulletTmp.length();
        if (segLen > 1e-5) {
            bulletRay.set(b.prev, bulletTmp);
            bulletRay.far = segLen;
            // 只检测活着的靶子 + 沙袋墙碰撞代理（取最近命中点）
            const aliveTargets = targets.filter(t=>t.userData.state==='alive');
            const colliders = getRangeColliders();
            const hits = bulletRay.intersectObjects(aliveTargets.concat(colliders), false);
            if (hits.length > 0) {
                const obj = hits[0].object;
                if (obj.userData.isSandbagWall) {
                    // 被沙袋拦截：子弹消失，命中点生成土黄色小尘粒
                    spawnSandbagDust(hits[0].point);
                } else {
                    hitTarget(obj);
                }
                removeBullet(i);
                continue;
            }
        }
        const p = b.mesh.position;
        if (p.y <= 0.08 || p.z <= -29.5 || Math.abs(p.x) >= 10.9 || p.z >= 14.5) {
            removeBullet(i);
        }
    }
}
