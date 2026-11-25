# MockPanel Chrome Web Store 上架与自动发布指南

本文档提供 **MockPanel 接口模拟** 首次上架 Chrome Web Store（CWS）的完整操作步骤、可直接复制粘贴的表单文案，以及后续开启 GitHub Actions 自动发布的配置方法。

---

## 1. 注册 Chrome Web Store 开发者账号

1. 打开 Chrome Web Store 开发者控制台：  
   https://chrome.google.com/webstore/devconsole
2. 使用你的 Google 账号登录。
3. 首次使用需支付一次性 **$5 美元** 注册费（支持国际信用卡 / Visa / Mastercard）。
4. 付款完成后进入左侧 **Account（账号）** 页面：
   - 填写联系人邮箱（Contact email）并完成邮件验证（**未验证邮箱无法提交审核**）。
   - 记录页面上的 **Publisher ID**（后续配置自动发布 `CWS_PUBLISHER_ID` 时会用到）。

---

## 2. 准备并上传扩展安装包

1. 在本地执行打包（或直接从 GitHub Release `v1.0.0` 下载 `mock-panel-1.0.0.zip`）：
   ```bash
   node tools/package.js
   # 输出：dist/mock-panel-1.0.0.zip
   ```
   > 该包已通过白名单过滤，仅包含 `manifest.json`、`src/`、`icons/`、`vendor/`，不含任何 `tools/` 测试或开发脚本。
2. 在开发者控制台点击右上角 **+ New Item（新增内容）**，上传 `dist/mock-panel-1.0.0.zip`。
3. 上传成功后，在控制台 URL 或左侧栏即可看到生成的 **32 位 Extension ID**（记录下来，后续自动发布用作 `CWS_EXTENSION_ID`）。

---

## 3. Store Listing（商品详情）填写对照表

### 基础信息
- **Title（名称）**：默认随 `manifest.json` 同步为 `MockPanel 接口模拟`
- **Summary（简短描述，上限 132 字符）**：默认随 `manifest.json` 同步为：
  ```text
  通用接口响应 Mock 侧边栏工具：实时抓包、按 Method/URL/Query/请求头/请求体条件精准匹配并模拟响应体、状态码与延迟。
  ```
- **Category（分类）**：`Developer Tools`（开发者工具）
- **Language（主要语言）**：`Chinese (Simplified)`（简体中文）

### Detailed Description（详细描述，可直接复制）

```text
MockPanel 接口模拟是一款纯离线、免登录、零代理、无规则数量上限的 Chrome 侧边栏 API 响应 Mock 工具（基于 Manifest V3，支持 Chrome 114+）。

【核心特性】
1. Chrome 侧边栏常驻工作台
   - 无需打开 DevTools，也不会像普通弹窗一样点击页面就关闭；
   - 窄屏自动切入全宽编辑器，拉宽超过 720px 自动切换左右双栏；
   - 扩展图标实时角标显示当前站点生效规则数，支持总开关一键停用。

2. 打开即实时抓包，点选字段一键建规则
   - 侧边栏打开时自动录制当前标签页（含 iframe）的 XHR / fetch 请求，支持暂停、筛选、清空；
   - 关闭侧边栏立即停止录制，所有抓包数据仅存在扩展内存缓冲中（每标签页最多 100 条），绝不写盘、绝不上传；
   - 打开任意抓包详情即可查看解析好的 Query / 请求头 / 请求体字段，勾选后一键生成 Mock 规则。

3. 按站点隔离 + 多维度精准匹配
   - 自动按 origin（协议 + 域名 + 端口）隔离规则与角标，清晰区分 localhost:3000 与 localhost:8080；单条规则也可设为全局生效（*）；
   - 支持 HTTP Method、URL（包含 / 精确 / 通配符 * / 正则表达式），以及 Query 参数、请求头、请求体（点号路径 a.b.c、数组下标及 $raw）的多种比较运算（=、!=、包含、存在、正则），兼容 JSON 与 x-www-form-urlencoded。

4. 完整响应模拟与离线代码编辑器
   - 支持自定义 HTTP 状态码（含 204 空响应、4xx/5xx 错误模拟）、模拟网络延迟（ms）、自定义响应头及任意非 JSON 文本/HTML/XML 响应；
   - 规则按列表从上到下顺序命中第一条，支持拖拽与上下按钮调序；
   - 内置离线 CodeMirror 5 编辑器（语法高亮、查找替换 Ctrl/Cmd+F、深浅色自适应）；
   - 支持 schemaVersion=1 的 JSON 规则导入/导出（单站点或全部、合并或覆盖）。

5. 隐私与安全承诺
   - 100% 纯离线本地运行，无任何后端服务器、统计埋点或账号系统。

---

MockPanel is a 100% offline, zero-proxy, zero-login Chrome Side Panel extension (MV3, Chrome 114+) for inspecting and mocking XHR and fetch API responses.
- Persistent Chrome Side Panel UI (single-pane under 720px, dual-pane >=720px)
- Live in-memory request capture while Side Panel is open (never written to disk, stops immediately on close)
- Per-origin rule isolation plus global (*) rules
- Multi-dimensional matching on Method, URL (contains / equals / wildcard / regex), Query, Headers, and JSON/form Body paths
- Custom HTTP status codes, network delay (ms), custom response headers, and bundled offline CodeMirror 5 editor
```

### Graphic Assets（商店视觉素材，均为无透明通道 24-bit RGB PNG）

| 栏位 | 文件路径 | 尺寸要求 |
| --- | --- | --- |
| Store icon（商店图标） | [`icons/icon128.png`](../icons/icon128.png) | `128×128` PNG |
| Screenshot 1（规则编辑器） | [`store/screenshots/01-rules-editor-1280x800.png`](../store/screenshots/01-rules-editor-1280x800.png) | `1280×800` PNG (RGB) |
| Screenshot 2（实时抓包与点选建规则） | [`store/screenshots/02-live-capture-1280x800.png`](../store/screenshots/02-live-capture-1280x800.png) | `1280×800` PNG (RGB) |
| Screenshot 3（侧边栏常驻浏览器） | [`store/screenshots/03-sidepanel-docked-1280x800.png`](../store/screenshots/03-sidepanel-docked-1280x800.png) | `1280×800` PNG (RGB) |
| Small promo tile（小宣传图，可选） | [`store/promo-small-440x280.png`](../store/promo-small-440x280.png) | `440×280` PNG (RGB) |

### Additional Fields（附加链接）
- **Official URL / Homepage URL**：`https://github.com/big-li99/mock-panel`
- **Support URL**：`https://github.com/big-li99/mock-panel/issues`

---

## 4. Privacy Practices（隐私权实践）表单填写指南

在开发者后台左侧 **Privacy practices** 页面逐项填写如下内容（建议中英对照直接粘贴英文或双语，便于审核团队快速通过）：

### 4.1 Single Purpose Description（单一用途说明）
```text
MockPanel provides a Chrome Side Panel developer tool to inspect XHR/fetch requests in real time (in memory only) and mock API responses locally per website origin.
（MockPanel 提供 Chrome 侧边栏开发者工具，用于仅在内存中实时查看 XHR/fetch 请求并按站点本地模拟 API 响应。）
```

### 4.2 Permission Justification（权限审核理由）

- **`storage`**：
  ```text
  Used to store user-created API mock rules, rule priority order, and the global enable toggle locally in chrome.storage.local. No data leaves the browser.
  ```
- **`unlimitedStorage`**：
  ```text
  Allows developers to store large JSON, HTML, or XML mock response bodies locally in chrome.storage.local without hitting the default 5MB quota limit during API testing.
  ```
- **`sidePanel`**：
  ```text
  Used to render MockPanel's persistent rule editor and live capture inspector inside Chrome's native Side Panel so developers can test pages without DevTools or losing state on page clicks.
  ```
- **`tabs`**：
  ```text
  Used to read the active tab's origin to isolate mock rules per website, display the active rule count badge on the extension icon, and reload the active tab when the user clicks the Refresh button.
  ```
- **Host Permission（`http://*/*`, `https://*/*`）**：
  ```text
  Developers use MockPanel to debug and mock APIs on arbitrary local development servers (such as localhost on different ports), staging environments, and production sites. Therefore, content scripts must be able to intercept XMLHttpRequest and fetch on user-visited HTTP/HTTPS origins. When the Side Panel is closed and no enabled rules apply to the current origin, requests pass through untouched with zero inspection or logging.
  ```

### 4.3 Remote Code（远程代码声明）
- 选择：**No, I am not using Remote code**
- 补充说明：
  ```text
  All JavaScript, CSS, and CodeMirror 5 editor assets are bundled offline inside the extension package (vendor/codemirror/). No remote scripts are ever loaded or executed.
  ```

### 4.4 Data Usage（数据使用声明）
- **数据收集勾选**：**全部不勾选**（本扩展不收集任何用户数据）。
- **认证勾选框（3 项合规承诺）**：全部勾选：
  - 不向第三方出售或传输用户数据；
  - 不将用户数据用于与扩展单一用途无关的目的；
  - 不将用户数据用于信用评分或借贷评估。
- **Privacy Policy URL（隐私政策链接）**：
  ```text
  https://github.com/big-li99/mock-panel/blob/main/PRIVACY.md
  ```

---

## 5. 提交审核与后续自动发布配置

### 5.1 首次人工提交审核
1. 完成上述 **Store Listing** 与 **Privacy practices** 保存，确认右上角提示无缺失项。
2. 点击 **Submit for Review（提交审核）**。
3. 首次审核一般需要 **1～3 个工作日**；含宽泛 Host 权限（`http://*/*`, `https://*/*`）的扩展有时会进入人工复核，通常数天内完成。

### 5.2 后续版本自动发布（Chrome Web Store API v2 + GitHub Actions）
仓库工作流 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 已集成 [`tools/publish_cws.mjs`](../tools/publish_cws.mjs)。首次在后台手动创建扩展并拿到 `Extension ID` 后，按以下步骤配置即可在每次推送 `v*` tag 时自动同步上传到 Chrome Web Store：

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建一个项目并启用 **Chrome Web Store API**。
2. 配置 OAuth consent screen，并创建一个类型为 **Desktop app**（或 Web application 添加回调 `https://developers.google.com/oauthplayground`）的 OAuth 2.0 Client，获得 `Client ID` 和 `Client Secret`。
3. 使用 Scope `https://www.googleapis.com/auth/chromewebstore` 完成一次 OAuth 授权，换取长期有效的 `Refresh Token`。
4. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中添加以下 Secrets：

| Secret 名称 | 必填 | 说明 |
| --- | --- | --- |
| `CWS_PUBLISHER_ID` | 是 | Chrome Web Store 开发者后台 Account 页中的 Publisher ID |
| `CWS_EXTENSION_ID` | 是 | 首次上传包后生成的 32 位扩展 ID |
| `CWS_CLIENT_ID` | 是 | Google Cloud OAuth2 Client ID |
| `CWS_CLIENT_SECRET` | 是 | Google Cloud OAuth2 Client Secret |
| `CWS_REFRESH_TOKEN` | 是 | 带 `chromewebstore` 权限的 OAuth2 Refresh Token |
| `CWS_PUBLISH_TYPE` | 否 | 可选 `DEFAULT_PUBLISH` 或 `STAGED_PUBLISH`（分阶段发布） |
| `CWS_SKIP_PUBLISH` | 否 | 设为 `true` 时只上传草稿包到后台，不自动提交审核 |

> 未配置上述 Secrets 时，GitHub Actions 会自动打印跳过信息并保持工作流成功，不影响正常生成 GitHub Release。
