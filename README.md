# MockPanel 接口模拟（Chrome 扩展）

纯离线、免登录、零代理、无规则数量上限的通用 API 响应 Mock 侧边栏工具（Chrome MV3，最低支持 Chrome 114+）。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **Chrome Side Panel 常驻工作台** | 不用打开 DevTools，也不会像弹窗一样点一下页面就关闭；窄屏自动切入全宽编辑器，拉宽超过 `720px` 自动切换左右双栏 |
| **打开即实时抓包** | 侧边栏打开时自动录制当前激活标签页（含 iframe）的 XHR / fetch 请求，支持暂停、筛选、清空；关闭侧边栏立刻停止录制，抓包仅存内存不写磁盘 |
| **按站点隔离 + 全局规则** | 自动按 `origin`（协议 + 域名 + 端口）隔离规则列表与图标角标，区分 `localhost:3000` 与 `localhost:8080`；单条规则可选「全局生效（`*`）」 |
| **多维度精准匹配** | `HTTP Method` + `URL`（包含 / 精确 / `*` 通配 / 正则）+ 附加条件（`Query 参数` / `请求头` / `请求体` 点号路径 `a.b.c`、数组下标及 `$raw`），支持 `=`、`!=`、包含、存在、正则，请求体兼容 JSON 与 `x-www-form-urlencoded` |
| **点选条件一键建规则** | 打开任意一条抓包即可查看解析好的 Query / 请求头 / 请求体叶子字段，勾选后点「创建 Mock 规则」自动填入规则与响应体 |
| **完整响应模拟** | 支持自定义 HTTP 状态码（含 `204` 空响应体、4xx/5xx 报错）、模拟网络延迟（ms）、自定义响应头、JSON / 纯文本 / HTML / XML 等非 JSON 响应 |
| **确定性优先级** | 规则按列表**从上到下命中第一条**，支持直接拖拽或 `↑` / `↓` 调序 |
| **离线编辑器与导入导出** | 内置离线 CodeMirror 5（语法高亮、查找替换 `Ctrl/Cmd+F`、深浅色自适应）；支持带 `schemaVersion: 1` 的 JSON 导入导出（单站点或全部、合并或覆盖） |

## 安装

无需构建步骤，克隆即用：

1. 打开 Chrome 地址栏进入 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库根目录 `mock-panel`
4. 点击工具栏中的 **MockPanel 接口模拟** 图标打开右侧侧边栏

## 工作原理

```
页面世界 (inject.js)                 隔离世界 (bridge.js)               后台 & Side Panel
─────────────────────               ────────────────────               ─────────────────
拦截 XHR / fetch       ─postMessage─► 过滤当前 origin + 全局规则 ◄─────► 规则编辑 / 导入导出
- 200 无自定义头 → blob:              - 按 ruleIds 保持顺序                - Port 控制抓包启停
- 非 200 / 自定义头 → 实例覆写          - captureOn 时转发抓包              - 内存环形缓冲（每 Tab 100 条）
- 无规则且未抓包 → 极速透传                                               - 按当前站点显示角标
```

## 目录结构

```
mock-panel/
├── manifest.json                  MV3 清单（minimum_chrome_version: 114）
├── icons/                         扩展图标（tools/make_icons.py 生成）
├── vendor/codemirror/             离线 CodeMirror 5 运行时（MIT）
├── src/
│   ├── inject.js                  页面世界脚本（单文件 IIFE）：XHR/fetch 拦截、匹配引擎、混合回放
│   ├── bridge.js                  隔离世界脚本（单文件 IIFE）：规则过滤同步与抓包开关桥接
│   ├── background.js              Service Worker（ES Module）：Port 抓包控制、内存缓冲、按 Tab 角标
│   ├── shared/
│   │   ├── constants.js           存储键、前缀、通道名、HTTP 状态码表
│   │   ├── matcher.js             规则元信息清洗、Scope 判定、抓包字段提取
│   │   ├── storage.js             chrome.storage.local 分层存储（元信息与响应体分离）
│   │   └── import_export.js       schemaVersion=1 规则导出与合并/覆盖导入
│   ├── sidepanel.html/.css        侧边栏响应式界面
│   └── panel/                     侧边栏前端模块（main / rules_view / captures_view / editor_view）
└── tools/
    ├── make_icons.py              生成 icons/（纯 Python 标准库）
    ├── package.js                 打白名单发布包 dist/mock-panel-<版本>.zip
    ├── preview.html               本地排版预览（支持窄屏/宽屏切换）
    ├── test_inject.js             页面世界匹配与 XHR/fetch 混合回放测试
    ├── test_bridge.js             隔离世界过滤、保序、签名去重测试
    ├── test_storage_io.mjs        存储分层、导入导出与抓包字段提取测试
    ├── test_background.mjs        后台 Port 生命周期、抓包缓冲与角标测试
    └── test_package.js            打包白名单与 zip 完整性测试
```

## 本地验证与打包

```bash
# 运行全部自动化测试
node tools/test_inject.js && \
node tools/test_bridge.js && \
node tools/test_storage_io.mjs && \
node tools/test_background.mjs && \
node tools/test_package.js

# 本地预览侧边栏排版
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/tools/preview.html

# 打发布包（输出 dist/mock-panel-<版本>.zip）
node tools/package.js
```

## 存储布局

元信息与响应体分 key 存放，角标统计与规则列表只读元信息，不搬运大 JSON：

| Key | 内容 |
| --- | --- |
| `mockPanel.enabled` | 全局总开关（boolean） |
| `mockPanel.ruleIds` | 全局有序规则 ID 列表（从上到下即命中优先级） |
| `rule:<id>` | 规则元信息（名称、`scope`、Method、URL 条件、附加条件、状态码、延迟、响应头、开关） |
| `rulebody:<id>` | 响应体文本（允许空字符串，如 `204`） |

> 实时抓包记录**只存在 Service Worker 内存缓冲中**（每个标签页最多 100 条，关闭标签页自动清理），绝不写入 `chrome.storage.local`。
