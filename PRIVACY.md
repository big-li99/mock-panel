# MockPanel 接口模拟 — 隐私政策 / Privacy Policy

生效日期 / Effective Date: 2026-11-25

---

## 中文版（简体中文）

### 1. 概述
**MockPanel 接口模拟**是一款纯离线、免登录、本地运行的 Chrome 浏览器扩展（Manifest V3），用于在开发者本地浏览器中拦截和模拟网页的 XHR / fetch 接口响应。我们高度重视用户隐私，本扩展不收集、不存储（到任何远程服务器）、不传输、不出售任何个人身份信息或网络请求数据。

### 2. 数据收集与传输声明
- **零外部传输**：本扩展不包含任何后端服务器、第三方数据统计（Analytics）、错误遥测（Telemetry）或广告 SDK。扩展不会主动向任何外部服务器发起网络请求。
- **不收集个人数据**：本扩展不收集个人身份信息、浏览历史、账号凭据、Cookie 或设备指纹。

### 3. 本地存储的数据（`chrome.storage.local`）
仅在您的本地浏览器 `chrome.storage.local` 中保存您主动创建或导入的 Mock 配置：
- `mockPanel.enabled`：全局总开关状态（布尔值）。
- `mockPanel.ruleIds`：Mock 规则优先级排序列表。
- `rule:<id>`：您编写的规则元信息（名称、站点范围 `scope`、HTTP 方法、URL 匹配条件、附加条件、状态码、延迟、自定义响应头等）。
- `rulebody:<id>`：您编写的模拟响应体文本。

### 4. 实时抓包数据的处理（仅限内存）
- 仅当您主动打开 MockPanel 侧边栏（且未点击“暂停”）时，扩展才会在后台 Service Worker 的**内存环形缓冲区**中暂存当前激活标签页最近最多 100 条 XHR / fetch 请求详情（URL、方法、状态码、请求头/体、响应头/体），用于在侧边栏展示并方便您点选字段一键创建 Mock 规则。
- **绝不写盘**：所有实时抓包记录仅存在于内存中，**绝不写入 `chrome.storage.local` 或任何持久化磁盘**。
- **自动销毁**：关闭侧边栏后立即停止捕获；点击“清空”按钮或关闭对应浏览器标签页时立即从内存中释放相关记录。

### 5. 权限用途说明
- `storage` & `unlimitedStorage`：用于在本地浏览器持久化保存您的 Mock 规则与较大体积的模拟响应体。
- `sidePanel`：用于提供 Chrome 侧边栏常驻工作台界面。
- `tabs`：用于识别当前激活标签页的 `origin`（以便按站点隔离规则与更新扩展图标角标），以及在您点击“刷新”按钮时重新加载当前标签页。
- `http://*/*` & `https://*/*`（Host 权限）：由于开发者可在任意本地开发地址（如 `localhost`）、测试环境或线上站点调试接口，扩展需要经由 `content_scripts` 注入到用户访问的网页中以拦截并模拟 XHR / fetch 请求。仅当侧边栏打开抓包或当前站点存在已启用的规则时才会介入，无规则且未抓包时直接透传。

### 6. 无远程代码
本扩展所有代码（包括离线打包的 CodeMirror 5 编辑器）均完整包含在扩展安装包内，不加载或执行任何远程脚本。

### 7. 数据控制与联系我们
- 您可以随时在侧边栏中删除单条规则、导出规则备份，或通过 Chrome 扩展管理页卸载本扩展以彻底清除所有本地数据。
- 如有隐私相关问题，请通过 GitHub Issues 联系我们：https://github.com/big-li99/mock-panel/issues

---

## English Version

### 1. Overview
**MockPanel** (`MockPanel 接口模拟`) is a 100% offline, local-only Chrome Extension (Manifest V3) for intercepting and mocking XHR and `fetch` API responses during web development and testing. We respect your privacy: MockPanel does **not** collect, transmit, share, or sell any personal information or browsing/network data.

### 2. No Data Collection or External Transmission
- **Zero external servers:** MockPanel has no backend servers, analytics, telemetry, crash reporting, or advertising SDKs. The extension makes no external network requests on its own.
- **No personal data collected:** MockPanel does not collect personally identifiable information (PII), browsing history, credentials, cookies, or user activity logs.

### 3. Locally Stored Configuration (`chrome.storage.local`)
All configuration data created or imported by you stays strictly inside your browser's local `chrome.storage.local`:
- `mockPanel.enabled`: Global master toggle (boolean).
- `mockPanel.ruleIds`: Ordered list of rule IDs defining priority.
- `rule:<id>`: Rule metadata defined by you (name, origin scope, HTTP method, URL matcher, optional request conditions, status code, simulated delay, custom headers).
- `rulebody:<id>`: Mock response body text defined by you.

### 4. In-Memory Live Request Capture
- Live request inspection is active **only** while the MockPanel Side Panel is open and not paused.
- Captured XHR / `fetch` request and response snapshots for the active tab are stored strictly in an **in-memory ring buffer** (up to 100 entries per tab) inside the extension Service Worker so you can inspect requests and generate mock rules with one click.
- **Never written to disk:** Captured traffic is **never** written to `chrome.storage.local`, IndexedDB, or any external service.
- **Automatic cleanup:** Recording stops immediately when the Side Panel closes, and in-memory buffers are immediately discarded when you click Clear or close the tab.

### 5. Permissions Explanation
- `storage` & `unlimitedStorage`: Stores your mock rules and potentially large JSON/text mock response bodies locally in your browser.
- `sidePanel`: Renders the MockPanel workspace inside Chrome's native Side Panel.
- `tabs`: Reads the active tab's `origin` to isolate rules per site, update the extension badge count, and reload the active tab when you click the Refresh button.
- `http://*/*` & `https://*/*` (Host permissions): Required so developers can mock APIs across arbitrary local (`localhost`), staging, or production origins via `content_scripts` intercepting `XMLHttpRequest` and `fetch`. Requests pass through untouched with zero inspection when capture is off and no enabled rules match the current origin.

### 6. No Remote Code
All runtime code, including the bundled CodeMirror 5 editor (`vendor/codemirror/`), is self-contained inside the extension package. No remote scripts are ever loaded or executed.

### 7. Data Deletion & Contact
- You can delete individual rules inside the Side Panel or uninstall the extension at any time to permanently erase all locally stored data.
- For privacy questions or support, please open an issue at: https://github.com/big-li99/mock-panel/issues
