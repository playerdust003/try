// ============================================================
// scene.js — 战场写实氛围场景模块（CC0 PBR 贴图 + IBL + 接触阴影）
// 规格要点：
//   - 全部 MeshStandardMaterial，仅沙袋用 MeshPhysicalMaterial(sheen)
//   - 禁止 transmission/thickness/clearcoat；中大表面必带 normal+roughness
//   - HDR 天空 + FogExp2 + ACES + Bloom(threshold 1.05)
//   - 接触阴影 + 污渍贴花替代 SSAO
//   - 导出 updateSceneAtmosphere(delta) 供 main.js animate 调用
// ============================================================
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- 模块级状态 ----------
let _maxAnisotropy = 1;
const _texLoader = new THREE.TextureLoader();
const _atmos = { smoke: [], fire: null };
let _paperNormal = null; // 靶纸法线（懒生成）
const _rangeColliders = []; // 沙袋墙碰撞代理（供子弹射线检测）
let _sandbagVariants = null; // 3 个沙袋材质变体缓存（沙袋堆与墙共用）

// ---------- 噪声工具（顶点扰动 / 贴花） ----------
function hash2(x, y, s) {
    const v = Math.sin(x * 127.1 + y * 311.3 + s * 74.7) * 43758.5453;
    return v - Math.floor(v);
}
function vnoise(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const n00 = hash2(ix, iy, s), n10 = hash2(ix + 1, iy, s);
    const n01 = hash2(ix, iy + 1, s), n11 = hash2(ix + 1, iy + 1, s);
    return n00 * (1 - sx) * (1 - sy) + n10 * sx * (1 - sy) + n01 * (1 - sx) * sy + n11 * sx * sy;
}
function fbm(x, y, oct, s) {
    let v = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { v += vnoise(x * f, y * f, s) * a; a *= 0.5; f *= 2; }
    return v;
}

// ---------- 贴图加载 ----------
// 返回一个正在加载的 Texture；加载期间材质会显示 color（兜底），加载完成自动贴上。
// 缺失时 console.warn 并保持无图（材质回退纯色）。
function loadTex(path, srgb) {
    const t = _texLoader.load(path, undefined, undefined,
        () => console.warn('[scene] 贴图缺失，回退纯色：', path));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = _maxAnisotropy;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
}
// 加载一套贴图：{ albedo, normal, roughness, ao, metalness }（按需，缓存原件，消费者各自 clone）
const _setCache = {};
function loadSet(dir, maps) {
    if (_setCache[dir]) return _setCache[dir];
    const out = {};
    if (maps.includes('albedo'))    out.albedo    = loadTex(`textures/${dir}/albedo.jpg`, true);
    if (maps.includes('normal'))    out.normal    = loadTex(`textures/${dir}/normal.jpg`, false);
    if (maps.includes('roughness')) out.roughness = loadTex(`textures/${dir}/roughness.jpg`, false);
    if (maps.includes('ao'))        out.ao        = loadTex(`textures/${dir}/ao.jpg`, false);
    if (maps.includes('metalness')) out.metalness = loadTex(`textures/${dir}/metalness.jpg`, false);
    _setCache[dir] = out;
    return out;
}
// 克隆贴图以设置独立 repeat（共享底层 source，加载同步生效）
function cloneTex(tex, rx, ry) {
    const c = tex.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.anisotropy = _maxAnisotropy;
    c.repeat.set(rx, ry);
    c.needsUpdate = true;
    return c;
}

// 构造标准 PBR 材质
function stdMat({ set, repeat, tint, rough, metal = 0, normalScale, ao = false, env = 1.0, repeatY }) {
    const m = new THREE.MeshStandardMaterial({
        color: tint ?? 0xffffff,
        roughness: rough,
        metalness: metal,
        envMapIntensity: env
    });
    if (set) {
        if (set.albedo)    { m.map = cloneTex(set.albedo, repeat, repeatY ?? repeat); m.map.colorSpace = THREE.SRGBColorSpace; }
        if (set.normal)    { m.normalMap = cloneTex(set.normal, repeat, repeatY ?? repeat); m.normalScale = new THREE.Vector2(normalScale ?? 1, normalScale ?? 1); }
        if (set.roughness) { m.roughnessMap = cloneTex(set.roughness, repeat, repeatY ?? repeat); }
        if (ao && set.ao)  {
            m.aoMap = cloneTex(set.ao, repeat, repeatY ?? repeat);
            m.aoMapIntensity = 0.9;
            try { m.aoMap.channel = 0; } catch (e) { /* r185 默认即 0 */ }
        }
    }
    return m;
}

// ---------- 靶纸纹理（Canvas） ----------
export function makeTargetTexture() {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    // 纸张底色 + 噪声
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n = fbm(x * 0.03, y * 0.03, 4, 7);
            const base = 215 + (n - 0.5) * 40;
            const i = (y * size + x) * 4;
            img.data[i] = base; img.data[i + 1] = base * 0.97; img.data[i + 2] = base * 0.9; img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    // 同心圆靶环
    const cx = size / 2, cy = size / 2;
    const rings = [
        { r: size * 0.46, c: '#1a1a1a' },
        { r: size * 0.36, c: '#2a2a2a' },
        { r: size * 0.27, c: '#3a6db0' },
        { r: size * 0.18, c: '#c0392b' },
        { r: size * 0.09, c: '#e74c3c' }
    ];
    rings.forEach(r => {
        ctx.fillStyle = r.c;
        ctx.beginPath(); ctx.arc(cx, cy, r.r, 0, Math.PI * 2); ctx.fill();
    });
    // 中心点
    ctx.fillStyle = '#7a0c0c';
    ctx.beginPath(); ctx.arc(cx, cy, size * 0.022, 0, Math.PI * 2); ctx.fill();
    // 印刷磨损污渍
    for (let i = 0; i < 60; i++) {
        const x = Math.random() * size, y = Math.random() * size;
        const r = 2 + Math.random() * 8;
        ctx.fillStyle = `rgba(60,50,40,${0.05 + Math.random() * 0.12})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // 轻微暗角
    const grd = ctx.createRadialGradient(cx, cy, size * 0.3, cx, cy, size * 0.55);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = _maxAnisotropy;
    return tex;
}

// 靶纸法线（256 Canvas，Sobel）
function makePaperNormalMap() {
    const size = 256;
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
            h[y * size + x] = fbm(x * 0.08, y * 0.08, 4, 13) * 0.5 + fbm(x * 0.4, y * 0.4, 2, 21) * 0.2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const xl = h[y * size + Math.max(0, x - 1)];
            const xr = h[y * size + Math.min(size - 1, x + 1)];
            const yu = h[Math.max(0, y - 1) * size + x];
            const yd = h[Math.min(size - 1, y + 1) * size + x];
            const dx = (xr - xl) * 2.0, dy = (yd - yu) * 2.0;
            const nx = -dx, ny = -dy, nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            const i = (y * size + x) * 4;
            img.data[i] = (nx / len * 0.5 + 0.5) * 255;
            img.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
            img.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = _maxAnisotropy;
    return t;
}

// ---------- 接触阴影 / 污渍贴花 ----------
let _contactTex = null;
function contactShadowTex() {
    if (_contactTex) return _contactTex;
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    _contactTex = new THREE.CanvasTexture(cv);
    _contactTex.colorSpace = THREE.NoColorSpace;
    return _contactTex;
}
function addContactShadow(scene, x, z, size) {
    const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
            map: contactShadowTex(), transparent: true, depthWrite: false,
            opacity: 0.85, color: 0x000000
        })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.021, z);
    m.renderOrder = 1;
    scene.add(m);
}
let _stainTex = null;
function stainTex() {
    if (_stainTex) return _stainTex;
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    for (let i = 0; i < 14; i++) {
        const x = Math.random() * s, y = Math.random() * s;
        const r = 20 + Math.random() * 60;
        const a = 0.2 + Math.random() * 0.25;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(46,42,38,${a})`);
        g.addColorStop(1, 'rgba(46,42,38,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    _stainTex = new THREE.CanvasTexture(cv);
    _stainTex.colorSpace = THREE.NoColorSpace;
    return _stainTex;
}
function addStains(scene) {
    const spots = [
        [-3, 2, 3.2, 0.35], [4, -3, 2.4, 0.28], [-6, -8, 3.0, 0.32],
        [7, -12, 2.6, 0.25], [-2, -16, 3.4, 0.4], [5, -21, 2.2, 0.3],
        [-8, -25, 2.8, 0.33], [2, -27, 3.6, 0.42], [0, 6, 2.5, 0.24]
    ];
    spots.forEach(([x, z, sz, op]) => {
        const m = new THREE.Mesh(
            new THREE.PlaneGeometry(sz, sz),
            new THREE.MeshBasicMaterial({
                map: stainTex(), transparent: true, depthWrite: false,
                opacity: op, color: 0x2e2a26
            })
        );
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0.022, z);
        m.rotation.z = Math.random() * Math.PI;
        m.renderOrder = 1;
        scene.add(m);
    });
}

// ---------- 灰黄渐变天空（无建筑，替代带房屋的 HDR 背景） ----------
let _skyTex = null;
function makeSkyGradient() {
    if (_skyTex) return _skyTex;
    const w = 2048, h = 1024;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    // 垂直渐变：顶部灰蓝 → 中部灰 → 地平线灰黄（与雾色 0x9a9186 同调）
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.00, '#7d8690');   // 天顶 灰蓝
    g.addColorStop(0.45, '#9a938a');   // 中部 灰
    g.addColorStop(0.72, '#a89b88');   // 下部 灰黄
    g.addColorStop(1.00, '#b8a98e');   // 地平线 暖灰黄
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // 柔和云絮噪声（低对比，无建筑轮廓）
    for (let i = 0; i < 60; i++) {
        const x = Math.random() * w, y = h * 0.2 + Math.random() * h * 0.5;
        const r = 40 + Math.random() * 160;
        const a = 0.03 + Math.random() * 0.06;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, `rgba(200,195,180,${a})`);
        grd.addColorStop(1, 'rgba(200,195,180,0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    _skyTex = new THREE.CanvasTexture(cv);
    _skyTex.mapping = THREE.EquirectangularReflectionMapping;
    _skyTex.colorSpace = THREE.SRGBColorSpace;
    return _skyTex;
}

// ============================================================
// 光照 + IBL + 雾 + 渲染器配置
// ============================================================
export function setupLightingAndEnvironment(scene, renderer) {
    _maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    _sceneRef = scene;

    // 雾（灰黄尘霾）
    const fogColor = 0x9a9186;
    scene.fog = new THREE.FogExp2(fogColor, 0.012);
    // 背景用灰黄渐变天空（无建筑）
    scene.background = makeSkyGradient();
    scene.backgroundIntensity = 0.9;

    // HDR 仅作环境反射（IBL），不再作背景
    const rgbe = new RGBELoader();
    rgbe.load('hdr/sky_1k.hdr', (hdr) => {
        const pmrem = new THREE.PMREMGenerator(renderer);
        const envRT = pmrem.fromEquirectangular(hdr);
        const env = envRT.texture;
        scene.environment = env;
        scene.environmentIntensity = 0.75;
        hdr.dispose();
        pmrem.dispose();
    }, undefined, () => console.warn('[scene] HDR 缺失，仅用渐变天空'));

    // 主光（暖白）
    const key = new THREE.DirectionalLight(0xffe9cf, 1.9);
    key.position.set(-30, 40, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -40; sc.right = 40; sc.top = 35; sc.bottom = -35;
    sc.near = 1; sc.far = 180;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    sc.updateProjectionMatrix();   // §6.1 必须调用
    scene.add(key);

    // 半球光
    scene.add(new THREE.HemisphereLight(0x93a2b4, 0x776a58, 0.65));
    // 暗部补光（防死黑）
    scene.add(new THREE.AmbientLight(0x3a4148, 0.12));
    // 暖色 rim
    const rim = new THREE.DirectionalLight(0xff8646, 0.55);
    rim.position.set(22, 12, -48);
    scene.add(rim);

    // 渲染器
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
}

// ============================================================
// 靶场环境（地面/墙/沙坡/沙袋/木箱/桶/标线 + 阴影贴花）
// ============================================================
export function createRangeEnvironment(scene) {
    _sceneRef = scene;
    // 加载 6 套贴图
    const concrete     = loadSet('concrete',     ['albedo', 'normal', 'roughness', 'ao']);
    const concreteWall = loadSet('concrete_wall',['albedo', 'normal', 'roughness', 'ao']);
    const sand         = loadSet('sand',         ['albedo', 'normal', 'roughness', 'ao']);
    const wood         = loadSet('wood',         ['albedo', 'normal', 'roughness', 'ao']);
    const burlap       = loadSet('burlap',       ['albedo', 'normal', 'roughness']);
    const rust         = loadSet('rust',         ['albedo', 'normal', 'roughness', 'ao', 'metalness']);
    const paintedMetal = loadSet('painted_metal_red', ['albedo', 'normal', 'roughness', 'metalness']);

    // ---------- 5.1(a) 远景地面 ----------
    {
        const geo = new THREE.PlaneGeometry(240, 240);
        const mat = stdMat({ set: concrete, repeat: 60, tint: 0x9a9a9a, rough: 0.9, normalScale: 0.5, ao: true });
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0;
        m.receiveShadow = true;
        scene.add(m);
    }

    // ---------- 5.1(b) 射击区地面（顶点扰动 + 顶点色） ----------
    {
        const geo = new THREE.PlaneGeometry(23, 46, 24, 60);
        const pos = geo.attributes.position;
        const cols = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i);
            // 边缘一圈位移为 0
            const edge = Math.abs(x) > 11.3 || Math.abs(y) > 22.8;
            if (!edge) {
                const n = (vnoise(x * 0.4, y * 0.4, 3) - 0.5) * 0.04; // ±2cm
                pos.setZ(i, n);
            }
            // 顶点色宏观灰度斑块
            const g = 0.82 + fbm(x * 0.12, y * 0.12, 3, 5) * 0.23;
            cols[i * 3] = g; cols[i * 3 + 1] = g; cols[i * 3 + 2] = g;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
        geo.computeVertexNormals();
        const mat = stdMat({ set: concrete, repeat: 9, repeatY: 18, tint: 0xb0b0b0, rough: 0.9, normalScale: 0.7, ao: true });
        mat.vertexColors = true;
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(0, 0.02, -8);
        m.receiveShadow = true;
        scene.add(m);
    }

    // ---------- 5.2 侧墙 / 挡弹墙 ----------
    // 侧墙 x=±11 高3.5 长46 厚0.4；后挡弹墙 z=-30.4 宽23 高6
    {
        // 左侧墙可见长面（朝 +X）
        const sideMat = stdMat({ set: concreteWall, repeat: 23, repeatY: 2, tint: 0x8f8a82, rough: 0.92, normalScale: 0.8, ao: true });
        const sideGeoL = new THREE.PlaneGeometry(46, 3.5);
        const wallL = new THREE.Mesh(sideGeoL, sideMat);
        wallL.position.set(-11, 1.75, -8);
        wallL.rotation.y = Math.PI / 2;
        wallL.receiveShadow = true; wallL.castShadow = true;
        scene.add(wallL);
        // 右侧墙（朝 -X）
        const wallR = new THREE.Mesh(new THREE.PlaneGeometry(46, 3.5), stdMat({ set: concreteWall, repeat: 23, repeatY: 2, tint: 0x8f8a82, rough: 0.92, normalScale: 0.8, ao: true }));
        wallR.position.set(11, 1.75, -8);
        wallR.rotation.y = -Math.PI / 2;
        wallR.receiveShadow = true; wallR.castShadow = true;
        scene.add(wallR);
        // 侧墙顶部薄盖板（深灰）
        const capMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.9, metalness: 0.1 });
        for (const sx of [-11, 11]) {
            const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 46), capMat);
            cap.position.set(sx, 3.56, -8);
            cap.castShadow = true; cap.receiveShadow = true;
            scene.add(cap);
        }
        // 后挡弹墙（朝 +Z）
        const backMat = stdMat({ set: concreteWall, repeat: 12, repeatY: 3, tint: 0x8a857d, rough: 0.92, normalScale: 0.8, ao: true });
        const back = new THREE.Mesh(new THREE.PlaneGeometry(23, 6), backMat);
        back.position.set(0, 3, -30.4);
        back.receiveShadow = true; back.castShadow = true;
        scene.add(back);
        // 后墙顶盖板
        const bcap = new THREE.Mesh(new THREE.BoxGeometry(23.4, 0.14, 0.4), capMat);
        bcap.position.set(0, 6.06, -30.4);
        scene.add(bcap);
    }

    // ---------- 5.3 挡弹沙坡（ExtrudeGeometry 三角楔） ----------
    {
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);        // 坡脚（靠射击区）
        shape.lineTo(0, 2.2);      // 靠墙顶
        shape.lineTo(6.9, 0);      // 靠墙底
        shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 21, bevelEnabled: false });
        geo.rotateY(Math.PI / 2);     // 长度沿 X
        geo.translate(-10.5, 0, -23.5); // x∈[-10.5,10.5]，z∈[-30.4,-23.5]
        // 顶点 ±4cm 噪声
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const y = pos.getY(i);
            if (y > 0.02 && y < 2.1) {
                pos.setY(i, y + (vnoise(pos.getX(i) * 0.5, pos.getZ(i) * 0.5, 9) - 0.5) * 0.08);
            }
        }
        geo.computeVertexNormals();
        const mat = stdMat({ set: sand, repeat: 5, repeatY: 5, tint: 0x9a8f72, rough: 0.95, normalScale: 1.2, ao: true });
        const m = new THREE.Mesh(geo, mat);
        m.receiveShadow = true; m.castShadow = true;
        scene.add(m);
    }

    // ---------- 5.5 沙袋堆 ----------
    buildSandbagPile(scene, burlap, -8.5, -3, 14, 3, 0);
    buildSandbagPile(scene, burlap, 8.5, -20, 18, 4, 0);
    buildSandbagPile(scene, burlap, -9, -24, 12, 3, 0.15);
    buildSandbagPile(scene, burlap, 0, -29, 24, 5, 0.25);

    // ---------- 玩家正前方沙袋工事墙 ----------
    createSandbagWall(scene, 0, -4.5, 12, 4);        // 主墙（顶高约 1.05m）
    createSandbagWall(scene, -7.6, -5.6, 2.6, 3);    // 左翼墙
    createSandbagWall(scene, 7.6, -5.6, 2.6, 3);     // 右翼墙

    // ---------- 5.6 木箱 ----------
    buildCrate(scene, wood, -9.2, 0.45, -2, 0);
    buildCrate(scene, wood, -9.0, 1.35, -2.2, 0.5);
    buildCrate(scene, wood, 9.2, 0.45, -16, 0);

    // ---------- 5.6 铁桶（6 个） ----------
    const barrelData = [
        [-8.2, -1.5], [8.6, -19],
        [9.1, -18.2], [7.5, -22] 
    ];
    barrelData.forEach(([x, z], i) => buildBarrel(scene, paintedMetal, x, z, i));

    // ---------- 5.7 标线 ----------
    {
        const markMat = new THREE.MeshStandardMaterial({ color: 0xc9a83f, roughness: 0.75, metalness: 0 });
        const shoot = new THREE.Mesh(new THREE.BoxGeometry(22, 0.04, 0.25), markMat);
        shoot.position.set(0, 0.06, 4); shoot.receiveShadow = true; scene.add(shoot);
        for (const z of [-10, -18]) {
            const dm = new THREE.Mesh(new THREE.BoxGeometry(22, 0.04, 0.12), markMat);
            dm.position.set(0, 0.06, z); scene.add(dm);
        }
    }

    // ---------- 封口后墙（z=+15，与两侧墙前端齐平） ----------
    {
        const backMat = stdMat({ set: concreteWall, repeat: 11, repeatY: 2, tint: 0x8f8a82, rough: 0.92, normalScale: 0.8, ao: true });
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(22, 3.5), backMat);
        wall.position.set(0, 1.75, 15);
        wall.rotation.y = Math.PI;     // 法线朝 -Z / 玩家方向
        wall.receiveShadow = true; wall.castShadow = true;
        scene.add(wall);
        // 顶部盖板（与侧墙盖板同材质同高）
        const capMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.9, metalness: 0.1 });
        const cap = new THREE.Mesh(new THREE.BoxGeometry(22.4, 0.12, 0.4), capMat);
        cap.position.set(0, 3.56, 15);
        cap.castShadow = true; cap.receiveShadow = true;
        scene.add(cap);
        // 墙脚 2 片暗色污渍
        for (const sx of [-5, 6]) {
            const s = new THREE.Mesh(
                new THREE.PlaneGeometry(2.6, 1.6),
                new THREE.MeshBasicMaterial({ map: stainTex(), transparent: true, depthWrite: false, opacity: 0.32, color: 0x2e2a26 })
            );
            s.rotation.x = -Math.PI / 2;
            s.position.set(sx, 0.022, 14.6);
            s.renderOrder = 1;
            scene.add(s);
        }
    }

    // ---------- 墙面武器架（挂在后墙内侧） ----------
    buildWeaponRack(scene, wood);

    // ---------- 5.9 接触阴影 + 污渍 ----------
    addStains(scene);
    // 桶、沙袋堆底、木箱、集装箱、灯柱底 的接触阴影在各自 builder / decor 内补
}

// ---------- 沙袋材质变体（缓存，沙袋堆与墙共用） ----------
function getSandbagVariants(burlap) {
    if (_sandbagVariants) return _sandbagVariants;
    _sandbagVariants = [0xe0d6c2, 0xcfc3ad, 0xb8ad96].map((c) => {
        const m = new THREE.MeshPhysicalMaterial({
            color: c, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.5,
            sheen: 0.5, sheenRoughness: 0.9, sheenColor: 0xd9cfc0
        });
        if (burlap) {
            m.map = cloneTex(burlap.albedo, 1, 1); m.map.colorSpace = THREE.SRGBColorSpace;
            m.map.repeat.set(1.1, 0.7);
            m.normalMap = cloneTex(burlap.normal, 1.1, 0.7); m.normalScale = new THREE.Vector2(0.6, 0.6);
            m.roughnessMap = cloneTex(burlap.roughness, 1.1, 0.7); m.roughness = 1.0;
        }
        return m;
    });
    return _sandbagVariants;
}

// ---------- 沙袋堆 builder ----------
function buildSandbagPile(scene, burlap, cx, cz, count, rows, scatter) {
    const variants = getSandbagVariants(burlap);
    const geo = new RoundedBoxGeometry(0.55, 0.28, 0.35, 3, 0.09);
    let idx = 0;
    for (let r = 0; r < rows; r++) {
        const perRow = Math.ceil(count * (1 - r / (rows + 1)));
        const y = 0.14 + r * 0.26;
        for (let c = 0; c < perRow && idx < count; c++, idx++) {
            const off = (r % 2) * 0.27;
            const sc = scatter;
            const x = cx + (c - perRow / 2) * 0.55 + off + (Math.random() - 0.5) * sc;
            const z = cz + (Math.random() - 0.5) * sc * 2;
            const bag = new THREE.Mesh(geo, variants[idx % 3]);
            bag.position.set(x, y, z);
            const s = 0.92 + Math.random() * 0.16;
            bag.scale.set(s, s * 0.94, s);
            bag.rotation.set((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.12);
            bag.castShadow = true; bag.receiveShadow = true;
            scene.add(bag);
        }
    }
    // 堆底接触阴影
    addContactShadow(scene, cx, cz, 2.2);
}

// ---------- 带状接触阴影（长轴两端 + 短轴两侧淡出，缓存复用） ----------
let _stripTex = null;
function contactShadowStripTex() {
    if (_stripTex) return _stripTex;
    const w = 256, h = 64;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    // 主体暗带（上下短轴两侧淡出）
    const gV = ctx.createLinearGradient(0, 0, 0, h);
    gV.addColorStop(0, 'rgba(0,0,0,0)');
    gV.addColorStop(0.2, 'rgba(0,0,0,0.5)');
    gV.addColorStop(0.8, 'rgba(0,0,0,0.5)');
    gV.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gV; ctx.fillRect(0, 0, w, h);
    // 长轴两端淡出（用 destination-out 擦除）
    ctx.globalCompositeOperation = 'destination-out';
    const gL = ctx.createLinearGradient(0, 0, w, 0);
    gL.addColorStop(0, 'rgba(0,0,0,1)');
    gL.addColorStop(0.12, 'rgba(0,0,0,0)');
    gL.addColorStop(0.88, 'rgba(0,0,0,0)');
    gL.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = gL; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    _stripTex = new THREE.CanvasTexture(cv);
    _stripTex.colorSpace = THREE.NoColorSpace;
    return _stripTex;
}
function addContactShadowStrip(scene, x, z, w) {
    const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, 1.6),
        new THREE.MeshBasicMaterial({
            map: contactShadowStripTex(), transparent: true, depthWrite: false,
            opacity: 0.85, color: 0x000000
        })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.021, z);
    m.renderOrder = 1;
    scene.add(m);
}

// ---------- 沙袋工事墙（错缝码放，3 变体各合并为 1 个 Mesh） ----------
export function createSandbagWall(scene, x, z, length, rows) {
    const burlap = loadSet('burlap', ['albedo', 'normal', 'roughness']);
    const variants = getSandbagVariants(burlap);
    const baseGeo = new RoundedBoxGeometry(0.55, 0.28, 0.35, 3, 0.09);
    const buckets = [[], [], []];
    const perRow = Math.max(2, Math.round(length / 0.56));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eul = new THREE.Euler(),
          pv = new THREE.Vector3(), sv = new THREE.Vector3();
    let bagIndex = 0;
    for (let r = 0; r < rows; r++) {
        const y = 0.14 + r * 0.26;
        const off = (r % 2) * 0.28;                    // 奇数行错缝半袋
        const startX = -length / 2 + 0.28;
        for (let i = 0; i < perRow; i++) {
            const px = startX + i * 0.56 + off;
            if (px > length / 2 - 0.2) continue;       // 两端自然收口
            const g = baseGeo.clone();
            eul.set((Math.random()-0.5)*0.10, (Math.random()-0.5)*0.20, (Math.random()-0.5)*0.10);
            q.setFromEuler(eul);
            pv.set(x + px + (Math.random()-0.5)*0.05, y + (Math.random()-0.5)*0.02, z + (Math.random()-0.5)*0.05);
            const sc = 0.94 + Math.random()*0.10;
            sv.set(sc, sc*0.94, sc);
            m4.compose(pv, q, sv);
            g.applyMatrix4(m4);
            buckets[bagIndex++ % 3].push(g);
        }
    }
    for (let v = 0; v < 3; v++) {
        if (!buckets[v].length) continue;
        const merged = mergeGeometries(buckets[v], false);   // 必须先变换再合并
        const mesh = new THREE.Mesh(merged, variants[v]);
        mesh.castShadow = true; mesh.receiveShadow = true;
        scene.add(mesh);
    }
    // 碰撞代理（子弹用）：保持 visible=true（全透明材质），确保 Raycaster 能命中
    const h = rows * 0.26 + 0.16;
    const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(length + 0.2, h, 0.45),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    proxy.position.set(x, h / 2, z);
    proxy.userData.isSandbagWall = true;
    scene.add(proxy);
    _rangeColliders.push(proxy);
    // 底部接触阴影条
    addContactShadowStrip(scene, x, z, length + 1);
}

// ---------- 暴露碰撞代理给 main.js ----------
export function getRangeColliders() { return _rangeColliders; }

// ---------- 木箱 builder ----------
function buildCrate(scene, wood, x, y, z, rotY) {
    const mat = stdMat({ set: wood, repeat: 2, tint: 0x9a7a52, rough: 0.85, normalScale: 0.8, ao: true });
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), mat);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    if (y < 0.6) addContactShadow(scene, x, z, 1.2);
}

// ---------- 燃油桶 builder（暗红/灰白/暗红 三段分层 + 金属卷边环） ----------
const _barrelVariants = [];
let _barrelDecalTex = null;
// 桶身分层贴图：顶环暗红 + 中段灰白 + 底环暗红 + 卷边金属环 + 锈斑划痕
function barrelDecalTex() {
    if (_barrelDecalTex) return _barrelDecalTex;
    const w = 256, h = 512;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const topEnd = h * 0.26;
    const botStart = h * 0.74;
    // 暗红铁皮色（比之前更深，但不发黑）
    const redBase = '#3a1812';
    const redDark = '#22100b';
    // 灰白色中段（偏暗，不刺眼）
    const whiteBase = '#b0a895';
    const whiteDark = '#7a7060';
    // 暗红色顶/底环 + 锈斑 + 划痕
    function drawRedBand(y0, y1) {
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0, redDark);
        g.addColorStop(0.5, redBase);
        g.addColorStop(1, redDark);
        ctx.fillStyle = g;
        ctx.fillRect(0, y0, w, y1 - y0);
        // 锈斑
        for (let i = 0; i < 90; i++) {
            const x = Math.random() * w;
            const y = y0 + Math.random() * (y1 - y0);
            const r = 2 + Math.random() * 7;
            ctx.fillStyle = `rgba(20,8,4,${0.25 + Math.random() * 0.45})`;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
        // 横向细划痕
        ctx.strokeStyle = 'rgba(60,30,20,0.35)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 36; i++) {
            const y = y0 + Math.random() * (y1 - y0);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y + (Math.random() - 0.5) * 2);
            ctx.stroke();
        }
    }
    drawRedBand(0, topEnd);
    drawRedBand(botStart, h);
    // 灰白色中段
    const gw = ctx.createLinearGradient(0, topEnd, 0, botStart);
    gw.addColorStop(0, whiteDark);
    gw.addColorStop(0.5, whiteBase);
    gw.addColorStop(1, whiteDark);
    ctx.fillStyle = gw;
    ctx.fillRect(0, topEnd, w, botStart - topEnd);
    // 中段污渍、划痕
    for (let i = 0; i < 70; i++) {
        const x = Math.random() * w;
        const y = topEnd + Math.random() * (botStart - topEnd);
        const r = 3 + Math.random() * 9;
        ctx.fillStyle = `rgba(70,60,45,${0.1 + Math.random() * 0.25})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(50,40,30,0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 44; i++) {
        const y = topEnd + Math.random() * (botStart - topEnd);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y + (Math.random() - 0.5) * 2);
        ctx.stroke();
    }
    // 顶/底卷边金属环（深色细带 + 高光 + 阴影，模拟燃油桶的卷边接缝）
    function drawCrimpedSeam(y) {
        ctx.fillStyle = '#180b06';
        ctx.fillRect(0, y - 4, w, 8);
        ctx.fillStyle = 'rgba(180,160,130,0.35)';
        ctx.fillRect(0, y - 4, w, 1.5);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, y + 2.5, w, 1.5);
        // 卷边凹凸点
        for (let x = 0; x < w; x += 6) {
            ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '180,160,130'},${0.15 + Math.random() * 0.2})`;
            ctx.fillRect(x, y - 4, 4, 8);
        }
    }
    drawCrimpedSeam(topEnd);
    drawCrimpedSeam(botStart);
    // 桶顶/桶底额外加一圈深色边缘
    ctx.fillStyle = '#0e0604';
    ctx.fillRect(0, 0, w, 3);
    ctx.fillRect(0, h - 3, w, 3);
    // 全局颗粒噪点（避免塑料感）
    for (let i = 0; i < 900; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,240,220'},${Math.random() * 0.07})`;
        ctx.fillRect(x, y, 1, 1);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    _barrelDecalTex = tex;
    return tex;
}
function buildBarrel(scene, paintedMetal, x, z, i) {
    if (_barrelVariants.length === 0 && paintedMetal) {
        for (const v of [0, 1]) {
            // 红白红分层贴图作 albedo；保留 paintedMetal 的法线/粗糙度/金属度提供金属质感
            const m = new THREE.MeshStandardMaterial({
                color: 0xb5a898, roughness: 1.0, metalness: 1.0, envMapIntensity: 0.85
            });
            m.map = cloneTex(barrelDecalTex(), 3, 1); m.map.colorSpace = THREE.SRGBColorSpace;
            m.map.offset.set(v * 0.33, 0);
            m.normalMap = cloneTex(paintedMetal.normal, 1, 1.4); m.normalScale = new THREE.Vector2(0.9, 0.9);
            m.roughnessMap = cloneTex(paintedMetal.roughness, 1, 1.4);
            m.metalnessMap = cloneTex(paintedMetal.metalness, 1, 1.4);
            _barrelVariants.push(m);
        }
    }
    const mat = _barrelVariants[i % 2] || new THREE.MeshStandardMaterial({ color: 0x4a2820, roughness: 0.85, metalness: 0.9 });
    const geo = new THREE.CylinderGeometry(0.32, 0.32, 0.95, 20);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, 0.475, z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    addContactShadow(scene, x, z, 0.9);
}

// ============================================================
// 墙面武器架 + 武器模型（纯装饰）
// ============================================================
// 局部坐标：枪管沿 +X，中轴 y=0，上方 +Y（瞄具），下方 -Y（弹匣/握把），origin = 机匣中心
function makeWeapon(type) {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.35, metalness: 0.75 });
    const dark  = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.8 });
    const wood  = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.7 });

    // castShadow 仅给机匣/护木/枪托/枪管，其余 false（性能）
    const add = (mesh, pos, rot, cast) => {
        if (pos) mesh.position.copy(pos);
        if (rot) mesh.rotation.copy(rot);
        if (cast) mesh.castShadow = true;
        g.add(mesh);
        return mesh;
    };
    const P = (x, y, z) => new THREE.Vector3(x, y, z);
    const R = (x, y, z) => new THREE.Euler(x, y, z);

    if (type === 'rifle') {
        add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.08), metal), P(0, 0, 0), null, true);                          // 机匣
        add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.10, 0.075), wood), P(0.31, -0.01, 0), null, true);                    // 护木
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.36, 12), dark), P(0.63, 0.005, 0), R(0, 0, Math.PI / 2), true); // 枪管
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 12), dark), P(0.85, 0.005, 0), R(0, 0, Math.PI / 2), false);   // 消焰器
        add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.11, 0.08), wood), P(-0.31, -0.01, 0), null, true);                    // 枪托
        add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.15, 0.09), dark), P(-0.46, -0.015, 0), null, false);                  // 枪托底板
        add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.20, 0.07), dark), P(0.03, -0.16, 0), R(0, 0, 0.12), false);           // 弹匣
        add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.065), wood), P(-0.14, -0.13, 0), R(0, 0, -0.30), false);        // 握把
        add(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.018), dark), P(0.80, 0.045, 0), null, false);                   // 准星
        add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.05), dark), P(-0.10, 0.08, 0), null, false);                    // 照门
    } else if (type === 'sniper') {
        add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.08), metal), P(0, 0, 0), null, true);                          // 机匣
        add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.10, 0.075), wood), P(0.31, -0.01, 0), null, true);                    // 护木
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 12), dark), P(0.75, 0.005, 0), R(0, 0, Math.PI / 2), true); // 枪管
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 12), dark), P(1.04, 0.005, 0), R(0, 0, Math.PI / 2), false);   // 消焰器
        add(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.11, 0.08), wood), P(-0.32, -0.01, 0), null, true);                    // 枪托
        add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.15, 0.09), dark), P(-0.48, -0.015, 0), null, false);                  // 枪托底板
        add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.06), dark), P(0.02, -0.14, 0), R(0, 0, 0.12), false);           // 弹匣
        add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.065), wood), P(-0.14, -0.13, 0), R(0, 0, -0.30), false);        // 握把
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 12), dark), P(0.05, 0.11, 0), R(0, 0, Math.PI / 2), false); // 瞄准镜管
        add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.03), dark), P(0.15, 0.06, 0), null, false);                     // 镜座前
        add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.03), dark), P(-0.05, 0.06, 0), null, false);                    // 镜座后
    } else if (type === 'shotgun') {
        add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 0.08), metal), P(0, 0, 0), null, true);                          // 机匣
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.5, 12), dark), P(0.50, 0.02, 0), R(0, 0, Math.PI / 2), true);   // 枪管
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.4, 12), dark), P(0.45, -0.03, 0), R(0, 0, Math.PI / 2), false); // 管仓
        add(new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.08, 0.07), wood), P(0.35, -0.02, 0), null, true);                     // 泵动护木
        add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.11, 0.075), wood), P(-0.29, -0.01, 0), null, true);                   // 枪托
        add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.085), dark), P(-0.43, -0.015, 0), null, false);                 // 枪托底板
        add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.06), wood), P(-0.13, -0.12, 0), R(0, 0, -0.25), false);         // 握把
        add(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), dark), P(0.72, 0.055, 0), null, false);                    // 前端准星
    } else if (type === 'smg') {
        add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.075), metal), P(0, 0, 0), null, true);                         // 机匣
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 12), dark), P(0.20, 0.005, 0), R(0, 0, Math.PI / 2), true); // 枪管
        add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.04), dark), P(0.30, 0.005, 0), null, false);                    // 前端帽
        add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.06), wood), P(-0.18, -0.01, 0), null, true);                    // 枪托
        add(new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.22, 0.065), dark), P(0.02, -0.17, 0), R(0, 0, 0.05), false);         // 弹匣
        add(new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.13, 0.06), wood), P(-0.10, -0.12, 0), R(0, 0, -0.28), false);        // 握把
        add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.10, 0.05), wood), P(0.14, -0.10, 0), null, false);                    // 前握把
        add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.04), dark), P(0, 0.075, 0), null, false);                       // 机械瞄具带
    }
    // 统一姿态：仅 ±1.5° z 旋转 + 位置 ±0.02m 微扰，消除复制粘贴感
    g.rotation.z = (Math.random() - 0.5) * 0.05;
    g.position.x += (Math.random() - 0.5) * 0.02;
    g.position.y += (Math.random() - 0.5) * 0.02;
    return g;
}

function buildWeaponRack(scene, wood) {
    const rackMat = stdMat({ set: wood, repeat: 2, tint: 0x6a5238, rough: 0.85, normalScale: 0.7, ao: true });
    const pegMat  = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.8 });
    // 背板
    const back = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.2, 0.08), rackMat);
    back.position.set(0, 1.55, 14.78);
    back.castShadow = true; back.receiveShadow = true;
    scene.add(back);
    // 三排挂枪：每排 2 把，x = ±1.6
    const layout = [
        { y: 0.85, weapons: ['rifle', 'rifle'] },
        { y: 1.55, weapons: ['sniper', 'shotgun'] },
        { y: 2.25, weapons: ['rifle', 'smg'] }
    ];
    const gunZ = 14.62;        // 枪身 z 中心
    const pegZ = 14.70;        // 托块 z 中心（前表面 14.66 接枪背面，后表面 14.74 贴背板）
    const pegGeo = new THREE.BoxGeometry(0.05, 0.05, 0.08);
    const pegGeos = [];        // 收集所有托块几何，最后合并为 1 个 mesh（省 draw call）
    for (const row of layout) {
        [-1.6, 1.6].forEach((gx, i) => {
            const w = makeWeapon(row.weapons[i]);
            w.position.set(gx, row.y, gunZ);
            scene.add(w);
            // 2 个挂抢托块：机匣处(gx-0.20) + 护木处(gx+0.22)
            for (const dx of [-0.20, 0.22]) {
                const pg = pegGeo.clone();
                pg.translate(gx + dx, row.y, pegZ);
                pegGeos.push(pg);
            }
        });
    }
    const mergedPegs = mergeGeometries(pegGeos, false);
    const pegMesh = new THREE.Mesh(mergedPegs, pegMat);
    pegMesh.castShadow = true;
    scene.add(pegMesh);
    // 架下两侧木箱（复用 buildCrate）
    buildCrate(scene, wood, -4.5, 0.45, 14, 0.3);
    buildCrate(scene, wood,  4.5, 0.45, 14, -0.3);
    // 暖色补光（让武器不被暗部吞掉）
    const pl = new THREE.PointLight(0xffb060, 1.0, 8, 2.0);
    pl.position.set(0, 2.6, 13.8);
    scene.add(pl);
}

// ============================================================
// 外围装饰（仅保留远处灯柱提供暖光氛围，移除围墙/集装箱/塔）
// ============================================================
export function createRangeDecorBuildings(scene) {
    // 灯柱 + 灯泡（emissive + 点光）
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6, metalness: 0.8 });
    const bulbMat = new THREE.MeshStandardMaterial({
        color: 0xffb060, emissive: 0xffb060, emissiveIntensity: 1.4, roughness: 0.4
    });
    for (const lp of [{ x: 14, z: -41 }, { x: -14, z: -38 }]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.5, 12), lampMat);
        post.position.set(lp.x, 1.75, lp.z);
        post.castShadow = true;
        scene.add(post);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), bulbMat);
        bulb.position.set(lp.x, 3.6, lp.z);
        scene.add(bulb);
        const pl = new THREE.PointLight(0xffb060, 2.0, 20, 2.0);
        pl.position.set(lp.x, 3.6, lp.z);
        scene.add(pl);
        addContactShadow(scene, lp.x, lp.z, 0.7);
    }
}

// ============================================================
// 靶子（接口冻结：targets/movers/userData 契约不变）
// ============================================================
export function createTarget(scene, targetTex, targets, movers, x, z, opts = {}) {
    const root = new THREE.Group();
    root.position.set(x, 0, z);

    // 靶板（1.2×1.2，y=1.55）
    const boardMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.9, metalness: 0, map: targetTex, envMapIntensity: 0.4
    });
    if (!_paperNormal) _paperNormal = makePaperNormalMap();
    boardMat.normalMap = _paperNormal;
    boardMat.normalScale = new THREE.Vector2(0.35, 0.35);
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.04), boardMat);
    board.position.set(0, 1.55, 0);
    board.castShadow = true; board.receiveShadow = true;
    board.userData = { state: 'alive', root, x, z, opts, respawnTimer: 0 };
    root.add(board);
    targets.push(board);

    // 纸板背衬
    const back = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 0.02),
        new THREE.MeshStandardMaterial({ color: 0xb9a98e, roughness: 1.0, metalness: 0 })
    );
    back.position.set(0, 1.55, -0.03);
    root.add(back);

    // 木柱
    const wood = loadSet('wood', ['albedo', 'normal', 'roughness', 'ao']);
    const postMat = stdMat({ set: wood, repeat: 1, tint: 0x8a6a42, rough: 0.85, normalScale: 0.6, ao: true });
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.55, 0.1), postMat);
    post.position.set(0, 0.775, -0.08);
    post.castShadow = true;
    root.add(post);

    scene.add(root);

    if (opts.moving) {
        movers.push({
            root, board, baseX: x,
            amp: opts.amp ?? 5, speed: opts.speed ?? 1, phase: opts.phase ?? 0, t: 0
        });
    }
    return board;
}

// ============================================================
// 后处理：EffectComposer + Bloom
// ============================================================
export function setupPostProcessing(renderer, scene, camera) {
    _camRef = camera;
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    const bloom = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.35,  // strength
        0.5,   // radius
        1.05   // threshold（直视天空不泛光）
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    return { composer, renderPass, bloomPass: bloom };
}
export function resizeComposer(composer, w, h) {
    composer.setSize(w, h);
}

// ============================================================
// 大气道具（烟板 + 火光） + 动画驱动
// ============================================================
function buildAtmosphere(scene) {
    if (_atmos.smoke.length || _atmos.fire) return;
    // 烟板 ×3
    const smokeDef = [
        { x: -16, y: 6, z: -44, w: 14, h: 7, sp: 0.3 },
        { x: -2, y: 8, z: -47, w: 10, h: 5, sp: 0.22 },
        { x: 13, y: 5, z: -43, w: 12, h: 6, sp: 0.35 }
    ];
    for (const d of smokeDef) {
        const tex = makeCloudTex();
        const mat = new THREE.MeshBasicMaterial({
            map: tex, color: 0xb7ada2, transparent: true,
            opacity: 0.26, depthWrite: false
        });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), mat);
        m.position.set(d.x, d.y, d.z);
        m.renderOrder = 2;
        scene.add(m);
        _atmos.smoke.push({ mesh: m, bx: d.x, by: d.y, bz: d.z, sp: d.sp, t: Math.random() * 100, ph: Math.random() * Math.PI * 2 });
    }
    // 火光 Sprite ×1
    const fireTex = makeFireTex();
    const fireMat = new THREE.SpriteMaterial({
        map: fireTex, color: new THREE.Color(2.5, 1.1, 0.4),
        transparent: true, opacity: 0.22, depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const fire = new THREE.Sprite(fireMat);
    fire.scale.set(8, 8, 1);
    fire.position.set(-18, 4.5, -47);
    scene.add(fire);
    _atmos.fire = { sprite: fire, t: 0 };
}
function makeCloudTex() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    for (let i = 0; i < 22; i++) {
        const x = Math.random() * s, y = Math.random() * s;
        const r = 30 + Math.random() * 70;
        const a = 0.05 + Math.random() * 0.1;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    return new THREE.CanvasTexture(cv);
}
function makeFireTex() {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,200,120,1)');
    g.addColorStop(0.4, 'rgba(255,140,60,0.6)');
    g.addColorStop(1, 'rgba(255,90,30,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
}

export function updateSceneAtmosphere(delta) {
    const scene = _sceneRef;
    if (!scene) return;
    buildAtmosphere(scene);
    // 烟板：漂移 + 透明度呼吸
    for (const s of _atmos.smoke) {
        s.t += delta;
        s.mesh.position.x = s.bx + Math.sin(s.t * s.sp * 0.5) * 3;
        s.mesh.position.y = s.by + Math.sin(s.t * 0.2 + s.ph) * 0.5;
        s.mesh.material.opacity = 0.24 + Math.sin(s.t * 0.4 + s.ph) * 0.06;
        // 始终面向相机
        if (_camRef) s.mesh.lookAt(_camRef.position);
    }
    // 火光 flicker
    if (_atmos.fire) {
        _atmos.fire.t += delta;
        const f = 0.18 + (vnoise(_atmos.fire.t * 4, 0, 11) * 0.1) + Math.sin(_atmos.fire.t * 12) * 0.04;
        _atmos.fire.sprite.material.opacity = Math.max(0.15, Math.min(0.28, f));
    }
}
let _sceneRef = null, _camRef = null;
