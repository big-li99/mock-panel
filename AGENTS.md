# Repository Guidelines

## 项目结构

Chrome MV3 通用接口 Mock 扩展（**MockPanel 接口模拟**），零构建、零 npm 依赖，`manifest.json` 是唯一入口，最低 Chrome 版本 `114`。
唯一第三方运行时是 `vendor/codemirror/`（CodeMirror 5，MIT），以发行文件直接引入，勿手改。

- `src/inject.js` — MAIN world 页面脚本（**单文件 IIFE，禁止 `import`/`export`**）：拦截 XHR / fetch、规则匹配、混合回放（200 无自定义头走 `blob:`；非 200 或有自定义头走实例属性覆写）；纯函数经 `window.__mockPanelTest` 暴露给单测。
- `src/bridge.js` — ISOLATED world 桥接层（**单文件 IIFE，禁止 `import`/`export`**）：按 `location.origin` 与 `scope === '*'` 过滤并保序下发规则，响应 `setCapture` 控制抓包上报。
- `src/background.js` — Service Worker（ES Module）：导出 `createController(chromeApi)`，管理 Side Panel `Port` 连接、每 Tab 内存抓包环形缓冲（上限 100 条）、按当前标签页 `origin` 更新角标。
- `src/shared/` — ES Modules 共享逻辑：
  - `constants.js` — 存储键 `K_*`、前缀 `P_*`、通道 `CH_PAGE`/`CH_EXT`、HTTP 状态码映射
  - `matcher.js` — 规则清洗、有效性判定、`extractSelectableFields` 抓包字段提取
  - `storage.js` — `chrome.storage.local` 分层读写（`rule:<id>` 与 `rulebody:<id>` 分离）
  - `import_export.js` — `schemaVersion: 1` 导出与合并/覆盖导入
- `src/sidepanel.html` / `src/sidepanel.css` / `src/panel/` — Side Panel 响应式工作台（`<720px` 单栏切入编辑，`>=720px` 左右双栏）。
- `vendor/` — CodeMirror 5 运行时，勿手改。
- `icons/` — `tools/make_icons.py` 生成，勿手改。
- `tools/` — 仅开发与测试脚本，打包时不进产物。

## 代码风格与测试

- `src/inject.js`、`src/bridge.js` 保持单文件 IIFE + `'use strict'`（可用 Chrome 114+ 现代 JS）；其余 `src/` 模块使用原生 ES Modules。
- 2 空格缩进、单引号、语句以分号结尾；注释用简体中文。
- 所有测试使用纯 Node 零依赖脚本，每个断言用一句中文描述，全部通过输出 `全部通过 ✅` 且退出码为 0：
  - `node tools/test_inject.js`
  - `node tools/test_bridge.js`
  - `node tools/test_storage_io.mjs`
  - `node tools/test_background.mjs`
  - `node tools/test_package.js`

## 关键不变量

1. **模块边界**：`inject.js` 和 `bridge.js` 作为 MV3 静态 `content_scripts`，不得出现静态 `import`/`export`。
2. **存储分层与前缀安全**：元信息 `rule:<id>` 与响应体 `rulebody:<id>` 分离；判断前缀时必须先判更长的 `rulebody:` 再判 `rule:`。
3. **空条件草稿防护与极速透传**：`urlPattern` 为空或非法正则、或 `enabled === false` 的规则绝不下发也绝不命中；未开侧边栏（`captureOn === false`）且当前站点无生效规则时，`inject.js` 直接透传请求，不解析请求体、不克隆响应、不上报。
4. **抓包不写盘**：捕获记录只留在 `background.js` 内存缓冲，`tabs.onRemoved` 时释放，禁止写 `chrome.storage.local`。
5. **优先级确定性**：严格按 `mockPanel.ruleIds` 从上到下命中第一条规则，不在匹配层隐式重排。
6. **Fetch 204/304 边界**：`new Response` 遇到 `204` / `205` / `304` 时必须传 `null` 作为 body，否则浏览器抛 `TypeError`。
7. **CodeMirror 刷新**：侧边栏切入编辑视图或跨 `720px` 改变宽度后必须调用 `cm.refresh()`。
8. **打包白名单**：`tools/package.js` 的 `INCLUDE` 为 `['manifest.json', 'src', 'icons', 'vendor']`，新增运行时目录须同步更新。
