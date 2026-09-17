# 灵魂出窍自由相机 — 实施计划

## Context
用户希望添加一个"灵魂出窍"功能：按一个键后，相机脱离玩家身体自由飞行，可查看完整地图。再按同一键退出回到正常游戏。

## 修改文件
- [src/main.js](file:///c:/Users/lenovo/Desktop/my-threejs-project--template/src/main.js) — 唯一改动文件

## 实施步骤

### 1. 新增全局变量（~L19 后）
```js
let cameraFree;                  // 灵魂出窍自由相机
let isSoulMode = false;         // 是否处于灵魂出窍模式
let soulYaw = 0, soulPitch = 0; // 自由相机偏航/俯仰角
let soulFlyUp = false, soulFlyDown = false;
let savedCameraQuat = null;     // 进入时保存 cameraFirst 朝向，退出时恢复（防跳变）
let soulHintEl;                 // 模式提示 DOM
```

### 2. init() 中创建 cameraFree（~L188 后，cameraThird 之后）
```js
cameraFree = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
```

### 3. init() 中添加 mousemove 监听（~L197 后）
当 `isSoulMode && controls.isLocked` 时，用 `e.movementX/Y` 更新 `soulYaw/soulPitch`，灵敏度复用 `controls.pointerSpeed`（用户设置面板可调）。`soulPitch` 钳制在 ±89°。

### 4. 扩展 onKeyDown / onKeyUp
- `KeyV` → 调用 `toggleSoulMode()`
- `Space` → `soulFlyUp`
- `ShiftLeft` → `soulFlyDown`

### 5. 新增 toggleSoulMode() 函数
**进入时**：
- `savedCameraQuat = cameraFirst.quaternion.clone()`
- cameraFree 定位到 cameraFirst 当前位置
- 从 cameraFirst quaternion 提取 yaw/pitch 赋给 soulYaw/soulPitch
- 若指针未锁定，调用 `controls.lock(true)` 请求锁定
- 隐藏枪模型 + 准星
- 显示提示条："灵魂出窍 — V退出 | WASD飞行 | 空格升 | Shift降"

**退出时**：
- 恢复 `cameraFirst.quaternion`（防跳变）
- 隐藏提示条

### 6. 改造 animate() 循环
将 L398-L428 的 camera/player 更新逻辑包裹在 `if (!isSoulMode) {...}` 内；
新增 `else` 分支调用 `updateSoulCamera(delta)`：

```
updateSoulCamera(delta):
  cameraFree.rotation.set(soulPitch, soulYaw, 0)  // order=YXZ
  forward = (0,0,-1).applyEuler(cameraFree.rotation)
  right   = (1,0,0).applyEuler(Euler(0, soulYaw, 0))
  moveVec = forward*W - forward*S + right*D - right*A + (0,1,0)*Space - (0,1,0)*Shift
  cameraFree.position += moveVec.normalize() * 25 * delta  // 25 m/s
```

renderPass.camera 选择改为三路：`isSoulMode ? cameraFree : (isFirstPerson ? cameraFirst : cameraThird)`

### 7. 改造 updateGun()
开头加 `if (isSoulMode) { 隐藏枪+准星; return; }`

### 8. 改造 onMouseDown()
加 `&& !isSoulMode` 条件，灵魂模式下不可射击。

### 9. 改造 onWindowResize()
追加 `cameraFree.aspect = w/h; cameraFree.updateProjectionMatrix();`

## 关键设计决策
- **复用 PointerLockControls**：不新建第二个 PointerLockControls。灵魂模式下 PointerLockControls 仍会旋转 cameraFirst，但不渲染 cameraFirst 所以无影响；退出时从 savedCameraQuat 恢复，消除跳变。
- **WASD 方向含俯仰**：W 键沿相机朝向移动（含上下分量），符合自由飞行直觉；Space/Shift 额外提供纯垂直移动。
- **飞行速度 25 m/s**：地图 240m 宽，约 10s 横穿，够用。
- **游戏世界继续运行**：靶子移动、烟雾、火光等照常更新，更像"灵魂出窍观察活人世界"。

## 验证方法
1. `npx vite` 启动开发服务器
2. 点击画面锁定鼠标 → 按 V → 应看到相机脱离身体可自由飞行
3. WASD 飞行、空格上升、Shift下降、鼠标转头均正常
4. 飞到高处可看到完整靶场地图
5. 再按 V → 回到玩家第一人称，无视角跳变
6. 射击功能正常（灵魂模式下不可射击）
7. 设置面板灵敏度对灵魂模式鼠标生效
