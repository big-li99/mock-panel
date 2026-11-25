/* 生成 Chrome Web Store 商店素材（3 张 1280×800 截图 + 1 张 440×280 宣传图，均为 24-bit RGB 无透明通道 PNG）。
 *
 * 运行：
 *   node tools/generate_store_assets.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'store');
const SCREENSHOTS_DIR = path.join(STORE_DIR, 'screenshots');

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FFMPEG_BIN = '/opt/homebrew/bin/ffmpeg';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function buildMockEnvScript(options) {
  const { autoAction, initialPaused = false } = options;
  return `
    (function () {
      const ORIGIN = 'http://localhost:3000';
      const now = 1764050000000;
      const STORE = {
        'mockPanel.enabled': true,
        'mockPanel.ruleIds': ['r_demo_1', 'r_demo_2', 'r_demo_3', 'r_demo_global'],
        'rule:r_demo_1': {
          id: 'r_demo_1',
          name: '用户信息 Mock',
          scope: ORIGIN,
          method: 'GET',
          urlOp: 'equals',
          urlPattern: '/api/user/profile',
          conditions: [],
          status: 200,
          delayMs: 80,
          responseHeaders: [],
          contentType: 'application/json;charset=utf-8',
          enabled: true,
          updatedAt: now - 60000
        },
        'rulebody:r_demo_1': JSON.stringify({
          code: 0,
          data: { id: 42, name: '李明', role: 'admin', plan: 'pro' }
        }, null, 2),
        'rule:r_demo_2': {
          id: 'r_demo_2',
          name: 'GraphQL GetOrders 报错测试',
          scope: ORIGIN,
          method: 'POST',
          urlOp: 'contains',
          urlPattern: '/graphql',
          conditions: [
            { source: 'body', path: 'operationName', op: 'equals', value: 'GetOrders' },
            { source: 'header', path: 'x-env', op: 'equals', value: 'staging' }
          ],
          status: 500,
          delayMs: 300,
          responseHeaders: [{ name: 'X-Mock-Source', value: 'MockPanel' }],
          contentType: 'application/json;charset=utf-8',
          enabled: true,
          updatedAt: now - 120000
        },
        'rulebody:r_demo_2': JSON.stringify({
          errors: [
            {
              message: '模拟订单服务超时（500）',
              code: 'ORDER_UPSTREAM_TIMEOUT',
              retryable: true
            }
          ],
          data: null
        }, null, 2),
        'rule:r_demo_3': {
          id: 'r_demo_3',
          name: '支付限流模拟 (429)',
          scope: ORIGIN,
          method: 'POST',
          urlOp: 'wildcard',
          urlPattern: '/api/pay/*/submit',
          conditions: [
            { source: 'query', path: 'dryRun', op: 'notEquals', value: '1' }
          ],
          status: 429,
          delayMs: 150,
          responseHeaders: [{ name: 'Retry-After', value: '30' }],
          contentType: 'application/json;charset=utf-8',
          enabled: true,
          updatedAt: now - 240000
        },
        'rulebody:r_demo_3': JSON.stringify({
          code: 42901,
          message: '请求过于频繁，请稍后重试'
        }, null, 2),
        'rule:r_demo_global': {
          id: 'r_demo_global',
          name: '全局灰度开关',
          scope: '*',
          method: 'GET',
          urlOp: 'wildcard',
          urlPattern: '/api/*/flags',
          conditions: [],
          status: 200,
          delayMs: 0,
          responseHeaders: [],
          contentType: 'application/json;charset=utf-8',
          enabled: false,
          updatedAt: now - 360000
        },
        'rulebody:r_demo_global': JSON.stringify({
          newCheckout: true,
          enableMockBanner: false
        }, null, 2)
      };

      const CAPTURES = [
        {
          id: 'c_1',
          origin: ORIGIN,
          url: ORIGIN + '/api/user/profile?tab=base',
          path: '/api/user/profile?tab=base',
          method: 'GET',
          status: 200,
          durationMs: 82,
          size: 94,
          reqHeaders: { 'x-trace-id': 'tr-9f12a', accept: 'application/json' },
          reqBody: '',
          resHeaders: { 'content-type': 'application/json;charset=utf-8' },
          resBody: JSON.stringify({ code: 0, data: { id: 42, name: '李明', role: 'admin' } }),
          mocked: true,
          matchedRuleId: 'r_demo_1',
          matchedRuleName: '用户信息 Mock',
          ts: now - 3000
        },
        {
          id: 'c_2',
          origin: ORIGIN,
          url: ORIGIN + '/graphql?locale=zh-CN',
          path: '/graphql?locale=zh-CN',
          method: 'POST',
          status: 200,
          durationMs: 46,
          size: 214,
          reqHeaders: {
            'content-type': 'application/json',
            'x-env': 'staging',
            'x-app-version': '2.4.0'
          },
          reqBody: JSON.stringify({
            operationName: 'GetOrders',
            variables: { page: 1, pageSize: 20, status: 'PAID' }
          }),
          resHeaders: { 'content-type': 'application/json' },
          resBody: JSON.stringify({
            data: {
              orders: [
                { id: 'ORD-1001', amount: 199.0, status: 'PAID' },
                { id: 'ORD-1002', amount: 89.5, status: 'SHIPPED' }
              ]
            }
          }),
          mocked: false,
          matchedRuleId: '',
          matchedRuleName: '',
          ts: now - 8000
        },
        {
          id: 'c_3',
          origin: ORIGIN,
          url: ORIGIN + '/api/pay/wechat/submit',
          path: '/api/pay/wechat/submit',
          method: 'POST',
          status: 429,
          durationMs: 151,
          size: 64,
          reqHeaders: { 'content-type': 'application/json' },
          reqBody: JSON.stringify({ orderId: 'ORD-1001', channel: 'wechat' }),
          resHeaders: { 'content-type': 'application/json', 'retry-after': '30' },
          resBody: JSON.stringify({ code: 42901, message: '请求过于频繁，请稍后重试' }),
          mocked: true,
          matchedRuleId: 'r_demo_3',
          matchedRuleName: '支付限流模拟 (429)',
          ts: now - 15000
        },
        {
          id: 'c_4',
          origin: ORIGIN,
          url: ORIGIN + '/api/v2/catalog/categories',
          path: '/api/v2/catalog/categories',
          method: 'GET',
          status: 200,
          durationMs: 31,
          size: 328,
          reqHeaders: { accept: 'application/json' },
          reqBody: '',
          resHeaders: { 'content-type': 'application/json' },
          resBody: JSON.stringify({ items: [{ id: 1, name: '电子产品' }, { id: 2, name: '办公设备' }] }),
          mocked: false,
          matchedRuleId: '',
          matchedRuleName: '',
          ts: now - 25000
        }
      ];

      const listeners = [];
      window.chrome = {
        storage: {
          local: {
            get(arg, cb) {
              let out = {};
              if (arg === null) out = Object.assign({}, STORE);
              else if (Array.isArray(arg)) arg.forEach((k) => { if (k in STORE) out[k] = STORE[k]; });
              else if (typeof arg === 'string') { if (arg in STORE) out[arg] = STORE[arg]; }
              else Object.keys(arg).forEach((k) => { out[k] = (k in STORE) ? STORE[k] : arg[k]; });
              cb(out);
            },
            set(p, cb) { Object.assign(STORE, p); cb && cb(); },
            remove(k, cb) { (Array.isArray(k) ? k : [k]).forEach((x) => delete STORE[x]); cb && cb(); }
          },
          onChanged: { addListener() {} }
        },
        runtime: {
          lastError: undefined,
          connect() {
            const port = {
              onMessage: { addListener(fn) { listeners.push(fn); } },
              onDisconnect: { addListener() {} },
              postMessage(msg) {
                if (msg.type === 'setCapturePaused') {
                  listeners.forEach((fn) => fn({ type: 'captureStateChanged', paused: msg.paused }));
                } else if (msg.type === 'clearCaptures') {
                  listeners.forEach((fn) => fn({ type: 'capturesCleared', tabId: 1 }));
                }
              }
            };
            setTimeout(() => {
              listeners.forEach((fn) => fn({
                type: 'init',
                tabId: 1,
                url: ORIGIN + '/dashboard',
                origin: ORIGIN,
                paused: ${initialPaused ? 'true' : 'false'},
                captures: CAPTURES
              }));
            }, 15);
            return port;
          }
        },
        tabs: {
          query(_q, cb) { cb([{ id: 1, url: ORIGIN + '/dashboard' }]); },
          reload() {}
        }
      };

      window.addEventListener('DOMContentLoaded', () => {
        let attempts = 0;
        const waitReady = () => {
          attempts++;
          const ready = document.querySelector('#rulesList .rule-card');
          if (ready || attempts >= 40) {
            setTimeout(() => {
              ${autoAction}
            }, 60);
            return;
          }
          setTimeout(waitReady, 50);
        };
        waitReady();
      });
    })();
  `;
}

function renderSidepanelDoc(baseHref, options) {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'sidepanel.html'), 'utf8');
  const mockScript = buildMockEnvScript(options);
  return html.replace(
    '<head>',
    `<head>\n  <base href="${baseHref}">\n  <script>${mockScript}<\/script>`
  );
}

function buildShowcaseShell({ title, subtitle, badges, frameSrc, frameWidth, frameHeight }) {
  const badgesHtml = badges.map((b) => `<span class="pill">${b}</span>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 1280px;
      height: 800px;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at 12% 14%, rgba(79, 70, 229, 0.14), transparent 42%),
        radial-gradient(circle at 88% 85%, rgba(13, 148, 136, 0.14), transparent 44%),
        linear-gradient(135deg, #f5f7ff 0%, #eef4f8 52%, #edf7f5 100%);
      color: #0f172a;
    }
    .canvas {
      width: 100%;
      height: 100%;
      padding: 28px 54px 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
    }
    .hero {
      width: ${frameWidth}px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .hero-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .hero-icon {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      box-shadow: 0 6px 16px rgba(79, 70, 229, 0.25);
    }
    .hero-title {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #111827;
    }
    .hero-sub {
      margin: 3px 0 0;
      font-size: 13px;
      color: #475569;
    }
    .hero-pills {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: nowrap;
    }
    .pill {
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(79, 70, 229, 0.18);
      color: #3730a3;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 2px 6px rgba(15, 23, 42, 0.05);
      white-space: nowrap;
    }
    .window {
      width: ${frameWidth}px;
      height: ${frameHeight}px;
      border-radius: 14px;
      background: #ffffff;
      border: 1px solid rgba(15, 23, 42, 0.12);
      box-shadow:
        0 24px 60px rgba(15, 23, 42, 0.14),
        0 4px 14px rgba(15, 23, 42, 0.06);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .win-bar {
      height: 34px;
      flex: none;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      align-items: center;
      padding: 0 14px;
      gap: 8px;
    }
    .traffic {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .traffic i {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .t-red { background: #ef4444; }
    .t-yel { background: #f59e0b; }
    .t-grn { background: #10b981; }
    .win-label {
      margin-left: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #475569;
    }
    iframe {
      width: 100%;
      flex: 1;
      border: none;
      background: #fff;
    }
  </style>
</head>
<body>
  <div class="canvas">
    <header class="hero">
      <div class="hero-left">
        <img class="hero-icon" src="/icons/icon128.png" alt="MockPanel">
        <div>
          <h1 class="hero-title">${title}</h1>
          <p class="hero-sub">${subtitle}</p>
        </div>
      </div>
      <div class="hero-pills">${badgesHtml}</div>
    </header>
    <div class="window">
      <div class="win-bar">
        <div class="traffic"><i class="t-red"></i><i class="t-yel"></i><i class="t-grn"></i></div>
        <span class="win-label">Chrome Side Panel — MockPanel 接口模拟</span>
      </div>
      <iframe id="panelFrame" src="${frameSrc}"></iframe>
    </div>
  </div>
</body>
</html>`;
}

function buildBrowserDockedShowcase(frameSrc) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>MockPanel 浏览器侧边栏常驻场景</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 1280px;
      height: 800px;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #e2e8f0;
      color: #0f172a;
    }
    .chrome {
      width: 1280px;
      height: 800px;
      display: flex;
      flex-direction: column;
      background: #ffffff;
    }
    .tab-strip {
      height: 38px;
      background: #dfe5ee;
      display: flex;
      align-items: flex-end;
      padding: 0 14px;
      gap: 10px;
    }
    .mac-dots {
      display: flex;
      gap: 7px;
      align-items: center;
      height: 38px;
      margin-right: 6px;
    }
    .mac-dots i {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      display: inline-block;
    }
    .tab-item {
      height: 30px;
      padding: 0 14px;
      background: #ffffff;
      border-radius: 8px 8px 0 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #1e293b;
      min-width: 220px;
    }
    .tab-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4f46e5;
    }
    .nav-bar {
      height: 44px;
      background: #ffffff;
      border-bottom: 1px solid #cbd5e1;
      display: flex;
      align-items: center;
      padding: 0 14px;
      gap: 10px;
    }
    .nav-arrows {
      color: #64748b;
      font-size: 14px;
      letter-spacing: 6px;
      user-select: none;
    }
    .omnibox {
      flex: 1;
      height: 30px;
      border-radius: 999px;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      padding: 0 14px;
      font-size: 13px;
      color: #334155;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .ext-btn {
      position: relative;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ext-btn img {
      width: 20px;
      height: 20px;
      border-radius: 4px;
    }
    .ext-badge {
      position: absolute;
      right: -4px;
      bottom: -3px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 999px;
      background: #16a34a;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1.5px solid #fff;
    }
    .body-split {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .web-page {
      flex: 1;
      background: #f8fafc;
      padding: 28px 34px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      overflow: hidden;
    }
    .page-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .page-title {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      color: #0f172a;
    }
    .page-sub {
      margin: 4px 0 0;
      font-size: 13px;
      color: #64748b;
    }
    .user-chip {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      font-size: 13px;
    }
    .avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: linear-gradient(135deg, #4f46e5, #0d9488);
      color: #fff;
      font-weight: 700;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }
    .kpi {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px;
    }
    .kpi-label { font-size: 12px; color: #64748b; }
    .kpi-val { font-size: 22px; font-weight: 700; margin-top: 6px; color: #0f172a; }
    .kpi-tag {
      display: inline-block;
      margin-top: 8px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
    }
    .tag-ok { background: #dcfce7; color: #15803d; }
    .tag-err { background: #fee2e2; color: #b91c1c; }
    .tag-warn { background: #fef3c7; color: #b45309; }
    .alert-card {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 12px;
      padding: 16px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .alert-title { font-size: 14px; font-weight: 700; color: #991b1b; }
    .alert-desc { font-size: 12px; color: #b91c1c; margin-top: 4px; }
    .alert-btn {
      padding: 7px 14px;
      border-radius: 8px;
      background: #dc2626;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      border: none;
      white-space: nowrap;
    }
    .table-card {
      flex: 1;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .table-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
      font-weight: 700;
    }
    .hint-box {
      padding: 10px 14px;
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      border-radius: 8px;
      font-size: 12px;
      color: #3730a3;
      line-height: 1.5;
    }
    .mock-rows {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .m-row {
      display: grid;
      grid-template-columns: 90px 1fr 90px 90px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 8px;
      background: #f8fafc;
      font-size: 12px;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .side-dock {
      width: 420px;
      flex: none;
      border-left: 1px solid #cbd5e1;
      background: #ffffff;
      display: flex;
      flex-direction: column;
    }
    .side-dock-head {
      height: 36px;
      padding: 0 12px;
      border-bottom: 1px solid #e2e8f0;
      background: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 600;
      color: #334155;
    }
    .side-dock iframe {
      flex: 1;
      width: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <div class="chrome">
    <div class="tab-strip">
      <div class="mac-dots">
        <i style="background:#ef4444"></i>
        <i style="background:#f59e0b"></i>
        <i style="background:#10b981"></i>
      </div>
      <div class="tab-item">
        <span class="tab-dot"></span>
        <span>订单控制台 · localhost:3000</span>
      </div>
    </div>
    <div class="nav-bar">
      <div class="nav-arrows">◀ ▶ ↻</div>
      <div class="omnibox">http://localhost:3000/dashboard</div>
      <div class="ext-btn" title="MockPanel 接口模拟">
        <img src="/icons/icon48.png" alt="MockPanel">
        <span class="ext-badge">3</span>
      </div>
    </div>
    <div class="body-split">
      <main class="web-page">
        <div class="page-head">
          <div>
            <h1 class="page-title">业务控制台（本地联调演示）</h1>
            <p class="page-sub">无需打开 DevTools，右侧 Chrome 侧边栏常驻切换规则并实时验证页面异常/边界态</p>
          </div>
          <div class="user-chip">
            <span class="avatar">李</span>
            <div>
              <div style="font-weight:700;">李明（Mock 用户）</div>
              <div style="font-size:11px;color:#64748b;">role: admin · plan: pro</div>
            </div>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi">
            <div class="kpi-label">/api/user/profile</div>
            <div class="kpi-val">200 OK</div>
            <span class="kpi-tag tag-ok">已由 MockPanel 接管 (80ms)</span>
          </div>
          <div class="kpi">
            <div class="kpi-label">/graphql (GetOrders)</div>
            <div class="kpi-val">500 Error</div>
            <span class="kpi-tag tag-err">模拟异常降级中 (300ms)</span>
          </div>
          <div class="kpi">
            <div class="kpi-label">/api/pay/*/submit</div>
            <div class="kpi-val">429 Limit</div>
            <span class="kpi-tag tag-warn">限流重试提示验证中</span>
          </div>
        </div>

        <div class="alert-card">
          <div>
            <div class="alert-title">订单列表加载失败：模拟订单服务超时（ORDER_UPSTREAM_TIMEOUT）</div>
            <div class="alert-desc">命中 MockPanel 规则「GraphQL GetOrders 报错测试」，正在验证前端错误兜底组件与重试交互。</div>
          </div>
          <button class="alert-btn">重新加载订单</button>
        </div>

        <div class="table-card">
          <div class="table-head">
            <span>当前页面接口命中概览</span>
            <span style="font-size:12px;color:#64748b;font-weight:500;">按站点 http://localhost:3000 自动隔离</span>
          </div>
          <div class="hint-box">
            💡 点击工具栏图标即可展开右侧 MockPanel 侧边栏：可随时开关单条规则、拖拽调整命中优先级、查看实时抓包或导入/导出 JSON 配置。
          </div>
          <div class="mock-rows">
            <div class="m-row">
              <span style="font-weight:700;color:#4f46e5;">GET</span>
              <span class="mono">/api/user/profile?tab=base</span>
              <span style="color:#16a34a;font-weight:700;">200 Mock</span>
              <span style="color:#64748b;text-align:right;">82 ms</span>
            </div>
            <div class="m-row">
              <span style="font-weight:700;color:#0284c7;">POST</span>
              <span class="mono">/graphql (operationName=GetOrders)</span>
              <span style="color:#dc2626;font-weight:700;">500 Mock</span>
              <span style="color:#64748b;text-align:right;">302 ms</span>
            </div>
            <div class="m-row">
              <span style="font-weight:700;color:#0284c7;">POST</span>
              <span class="mono">/api/pay/wechat/submit</span>
              <span style="color:#d97706;font-weight:700;">429 Mock</span>
              <span style="color:#64748b;text-align:right;">151 ms</span>
            </div>
          </div>
        </div>
      </main>

      <aside class="side-dock">
        <div class="side-dock-head">
          <span>Side Panel · MockPanel 接口模拟</span>
          <span style="color:#94a3b8;">✕</span>
        </div>
        <iframe id="dockFrame" src="${frameSrc}"></iframe>
      </aside>
    </div>
  </div>
</body>
</html>`;
}

function buildPromoTileHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>MockPanel Promo Tile</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 440px;
      height: 280px;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: linear-gradient(135deg, #4338ca 0%, #4f46e5 45%, #0d9488 100%);
      color: #ffffff;
    }
    .wrap {
      width: 440px;
      height: 280px;
      padding: 28px 26px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
    }
    .glow {
      position: absolute;
      width: 220px;
      height: 220px;
      right: -50px;
      top: -60px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,255,255,0.18), transparent 70%);
    }
    .top {
      display: flex;
      align-items: center;
      gap: 16px;
      position: relative;
      z-index: 1;
    }
    .icon {
      width: 72px;
      height: 72px;
      border-radius: 16px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.28);
      border: 2px solid rgba(255, 255, 255, 0.25);
      background: #fff;
    }
    .title {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .sub {
      margin: 6px 0 0;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.88);
      line-height: 1.4;
    }
    .mid {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.92);
      line-height: 1.5;
      background: rgba(15, 23, 42, 0.18);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 10px;
      padding: 10px 12px;
      position: relative;
      z-index: 1;
    }
    .tags {
      display: flex;
      gap: 8px;
      position: relative;
      z-index: 1;
    }
    .tag {
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.26);
      font-size: 12px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="glow"></div>
    <div class="top">
      <img class="icon" src="/icons/icon128.png" alt="MockPanel">
      <div>
        <h1 class="title">MockPanel<br>接口模拟</h1>
        <p class="sub">Chrome 侧边栏 API 响应模拟工具</p>
      </div>
    </div>
    <div class="mid">
      实时抓包 · Query / Header / Body 精准匹配<br>
      自定义状态码、延迟与响应头 · 免登录纯离线
    </div>
    <div class="tags">
      <span class="tag">⚡ 实时抓包</span>
      <span class="tag">🎯 多维匹配</span>
      <span class="tag">🔒 纯离线</span>
    </div>
  </div>
</body>
</html>`;
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const pathname = reqUrl.pathname;
      const baseHref = `http://127.0.0.1:${server.address().port}/src/`;

      if (pathname === '/panel-mock/01') {
        const frameHtml = renderSidepanelDoc(baseHref, {
          autoAction: `
            const card = document.querySelector('.rule-card[data-rule-id="r_demo_2"]');
            if (card) card.click();
            setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
          `
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(frameHtml);
        return;
      }

      if (pathname === '/panel-mock/02') {
        const frameHtml = renderSidepanelDoc(baseHref, {
          autoAction: `
            const tabCap = document.getElementById('tabCaptures');
            if (tabCap) tabCap.click();
            setTimeout(() => {
              const cards = Array.from(document.querySelectorAll('.cap-card'));
              const target = cards.find((c) => c.textContent.includes('/graphql')) || cards[0];
              if (target) target.click();
              setTimeout(() => {
                const boxes = document.querySelectorAll('#capFieldsList .pick-row input[type="checkbox"]');
                if (boxes[0]) boxes[0].click();
                if (boxes[1]) boxes[1].click();
              }, 80);
            }, 80);
          `
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(frameHtml);
        return;
      }

      if (pathname === '/panel-mock/03') {
        const frameHtml = renderSidepanelDoc(baseHref, {
          autoAction: `/* 保持窄屏规则列表首屏展示 */`
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(frameHtml);
        return;
      }

      if (pathname === '/showcase/01') {
        const html = buildShowcaseShell({
          title: 'MockPanel 接口模拟 — 多维度精准匹配与离线编辑器',
          subtitle: '按站点隔离规则 · 支持 Method / URL / Query / Header / 请求体匹配 · 状态码与延迟模拟',
          badges: ['按站点隔离', 'CodeMirror 5 离线高亮', '自上而下优先级'],
          frameSrc: '/panel-mock/01',
          frameWidth: 1172,
          frameHeight: 654
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (pathname === '/showcase/02') {
        const html = buildShowcaseShell({
          title: '打开侧边栏即实时抓包 · 点选字段一键创建 Mock 规则',
          subtitle: '仅在侧边栏打开时于内存暂存最近 100 条 XHR / fetch 请求，绝不写盘，关闭即停',
          badges: ['仅存内存不写盘', '自动提取 Query/Header/Body', '一键生成规则'],
          frameSrc: '/panel-mock/02',
          frameWidth: 1172,
          frameHeight: 654
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (pathname === '/showcase/03') {
        const html = buildBrowserDockedShowcase('/panel-mock/03');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (pathname === '/showcase/promo') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildPromoTileHtml());
        return;
      }

      const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
      const absPath = path.join(ROOT, safePath);
      if (!absPath.startsWith(ROOT) || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(absPath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(absPath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function captureAndConvert(url, width, height, outPath, tmpDir) {
  const rawPng = path.join(tmpDir, path.basename(outPath, '.png') + '.raw.png');
  const userDataDir = path.join(tmpDir, 'chrome-profile-' + path.basename(outPath, '.png'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  await execFileAsync(CHROME_BIN, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=4000',
    `--screenshot=${rawPng}`,
    url
  ], { timeout: 60000 });

  // Chrome Web Store 要求商店截图和宣传图不能带 Alpha 透明通道，统一转为 24-bit RGB PNG
  await execFileAsync(FFMPEG_BIN, [
    '-y',
    '-loglevel', 'error',
    '-i', rawPng,
    '-pix_fmt', 'rgb24',
    outPath
  ], { timeout: 30000 });
}

async function main() {
  if (!fs.existsSync(CHROME_BIN)) {
    throw new Error('找不到 Google Chrome: ' + CHROME_BIN);
  }
  if (!fs.existsSync(FFMPEG_BIN)) {
    throw new Error('找不到 ffmpeg: ' + FFMPEG_BIN);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-panel-assets-'));
  const server = await startStaticServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const targets = [
    {
      route: '/showcase/01',
      width: 1280,
      height: 800,
      out: path.join(SCREENSHOTS_DIR, '01-rules-editor-1280x800.png')
    },
    {
      route: '/showcase/02',
      width: 1280,
      height: 800,
      out: path.join(SCREENSHOTS_DIR, '02-live-capture-1280x800.png')
    },
    {
      route: '/showcase/03',
      width: 1280,
      height: 800,
      out: path.join(SCREENSHOTS_DIR, '03-sidepanel-docked-1280x800.png')
    },
    {
      route: '/showcase/promo',
      width: 440,
      height: 280,
      out: path.join(STORE_DIR, 'promo-small-440x280.png')
    }
  ];

  try {
    for (const item of targets) {
      await captureAndConvert(baseUrl + item.route, item.width, item.height, item.out, tmpDir);
      const sizeKb = (fs.statSync(item.out).size / 1024).toFixed(1);
      console.log(`生成完成 ✅ ${path.relative(ROOT, item.out)} (${item.width}x${item.height}, ${sizeKb} KB)`);
    }
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('生成商店素材失败:', err);
  process.exit(1);
});
