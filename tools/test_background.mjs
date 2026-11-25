/* 测试 src/background.js：Side Panel Port 生命周期、抓包缓冲、按 Tab 角标
 * 运行：node tools/test_background.mjs
 */

import { createController } from '../src/background.js';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

function createFakeChrome() {
  const store = {
    'mockPanel.enabled': true,
    'mockPanel.ruleIds': ['r_3000', 'r_global', 'r_8080', 'r_off'],
    'rule:r_3000': {
      id: 'r_3000', name: 'A', scope: 'http://localhost:3000',
      urlOp: 'contains', urlPattern: '/a', enabled: true
    },
    'rule:r_global': {
      id: 'r_global', name: 'G', scope: '*',
      urlOp: 'contains', urlPattern: '/g', enabled: true
    },
    'rule:r_8080': {
      id: 'r_8080', name: 'B', scope: 'http://localhost:8080',
      urlOp: 'contains', urlPattern: '/b', enabled: true
    },
    'rule:r_off': {
      id: 'r_off', name: 'Off', scope: 'http://localhost:3000',
      urlOp: 'contains', urlPattern: '/off', enabled: false
    }
  };

  let tabs = [
    { id: 1, url: 'http://localhost:3000/home', active: true },
    { id: 2, url: 'http://localhost:8080/admin', active: false },
    { id: 3, url: 'chrome://extensions', active: false }
  ];

  const tabMessages = [];
  const badgeBgCalls = [];
  const badges = new Map();
  let currentLastError;
  let lastErrorChecked = true;
  let uncheckedErrors = 0;

  function invokeWithLastError(errMsg, cb, ...cbArgs) {
    if (errMsg) {
      currentLastError = { message: errMsg };
      lastErrorChecked = false;
    } else {
      currentLastError = undefined;
      lastErrorChecked = true;
    }
    try {
      cb && cb(...cbArgs);
    } finally {
      if (errMsg && !lastErrorChecked) uncheckedErrors++;
      currentLastError = undefined;
    }
  }

  const listeners = {
    installed: [],
    connect: [],
    message: [],
    tabActivated: [],
    tabUpdated: [],
    tabRemoved: [],
    storageChanged: []
  };

  const chromeApi = {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          }
          cb(out);
        },
        set(patch, cb) {
          const changes = {};
          for (const [k, v] of Object.entries(patch)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          cb && cb();
          for (const fn of listeners.storageChanged) fn(changes, 'local');
        }
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) }
    },
    action: {
      setBadgeText({ tabId, text }, cb) {
        if (tabId != null && !tabs.some((t) => t.id === tabId)) {
          invokeWithLastError(`No tab with id: ${tabId}.`, cb);
          return;
        }
        const cur = badges.get(tabId) || {};
        cur.text = text;
        badges.set(tabId, cur);
        invokeWithLastError(undefined, cb);
      },
      setBadgeBackgroundColor({ tabId, color }, cb) {
        badgeBgCalls.push({ tabId, color });
        if (tabId != null && !tabs.some((t) => t.id === tabId)) {
          invokeWithLastError(`No tab with id: ${tabId}.`, cb);
          return;
        }
        const cur = badges.get(tabId) || {};
        cur.color = color;
        badges.set(tabId, cur);
        invokeWithLastError(undefined, cb);
      }
    },
    tabs: {
      query(q, cb) {
        let res = tabs.slice();
        if (q && q.active) res = res.filter((t) => t.active);
        if (cb) {
          invokeWithLastError(undefined, cb, res);
          return;
        }
        return Promise.resolve(res);
      },
      get(id, cb) {
        const t = tabs.find((x) => x.id === id) || null;
        if (cb) {
          if (!t) invokeWithLastError(`No tab with id: ${id}.`, cb, undefined);
          else invokeWithLastError(undefined, cb, t);
          return;
        }
        return t ? Promise.resolve(t) : Promise.reject(new Error(`No tab with id: ${id}.`));
      },
      sendMessage(tabId, msg, cb) {
        tabMessages.push({ tabId, msg });
        if (!tabs.some((t) => t.id === tabId)) {
          invokeWithLastError(`No tab with id: ${tabId}.`, cb);
          return;
        }
        invokeWithLastError(undefined, cb, { ok: true });
      },
      onActivated: { addListener: (fn) => listeners.tabActivated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) }
    },
    windows: { onFocusChanged: { addListener() {} } },
    runtime: {
      get lastError() {
        lastErrorChecked = true;
        return currentLastError;
      },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener() {} },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) }
    },
    _emitConnect(name) {
      const msgListeners = [];
      const discListeners = [];
      const panelMessages = [];
      const port = {
        name,
        onMessage: { addListener: (fn) => msgListeners.push(fn) },
        onDisconnect: { addListener: (fn) => discListeners.push(fn) },
        postMessage: (m) => panelMessages.push(m),
        _sendFromPanel: (m) => msgListeners.forEach((fn) => fn(m)),
        _disconnect: () => discListeners.forEach((fn) => fn())
      };
      listeners.connect.forEach((fn) => fn(port));
      return { port, panelMessages };
    },
    _emitRuntimeMessage(msg, tabId) {
      let resp = null;
      for (const fn of listeners.message) {
        fn(msg, { tab: { id: tabId } }, (r) => { resp = r; });
      }
      return resp;
    },
    _activateTab(tabId) {
      tabs = tabs.map((t) => ({ ...t, active: t.id === tabId }));
      return Promise.all(listeners.tabActivated.map((fn) => fn({ tabId })));
    },
    _removeTab(tabId) {
      tabs = tabs.filter((t) => t.id !== tabId);
      listeners.tabRemoved.forEach((fn) => fn(tabId));
    },
    _dropTabSilently(tabId) {
      tabs = tabs.filter((t) => t.id !== tabId);
    },
    _emitTabActivatedRaw(tabId) {
      return Promise.all(listeners.tabActivated.map((fn) => fn({ tabId })));
    },
    _store: store,
    _badges: badges,
    _badgeBgCalls: badgeBgCalls,
    _tabMessages: tabMessages,
    _getUncheckedErrors: () => uncheckedErrors
  };

  return chromeApi;
}

const tick = () => new Promise((r) => setTimeout(r, 15));

async function run() {
  const api = createFakeChrome();
  const ctrl = createController(api);
  ctrl.init();
  await tick();

  /* ---------- 场景 1：按当前标签页 origin 显示角标 ---------- */
  console.log('\n场景：按当前标签页 origin 计算角标');
  check('Tab 1 (localhost:3000) 显示本站点 + 全局共 2 条生效规则',
    api._badges.get(1) && api._badges.get(1).text === '2');

  await ctrl.refreshTabBadge(2, 'http://localhost:8080/admin');
  check('Tab 2 (localhost:8080) 显示本站点 + 全局共 2 条生效规则',
    api._badges.get(2) && api._badges.get(2).text === '2');

  await ctrl.refreshTabBadge(3, 'chrome://extensions');
  check('chrome:// 等非 HTTP 页面角标为空',
    api._badges.get(3) && api._badges.get(3).text === '');

  api.storage.local.set({ 'mockPanel.enabled': false });
  await tick();
  check('全局总开关关闭时角标变为 off',
    api._badges.get(1) && api._badges.get(1).text === 'off');

  api.storage.local.set({ 'mockPanel.enabled': true });
  await tick();

  /* ---------- 场景 2：Side Panel Port 抓包生命周期 ---------- */
  console.log('\n场景：Side Panel Port 开关抓包与标签页切换');
  api._tabMessages.length = 0;
  const { port, panelMessages } = api._emitConnect('mock-panel-ui');
  await tick();

  check('连接 Side Panel 时开启当前 Tab 1 抓包并发送 init',
    api._tabMessages.some((m) => m.tabId === 1 && m.msg.type === 'setCapture' && m.msg.enabled === true) &&
    panelMessages.some((m) => m.type === 'init' && m.tabId === 1 && m.origin === 'http://localhost:3000'));

  check('getCaptureState 对当前 Tab 1 返回 true，对后台 Tab 2 返回 false',
    api._emitRuntimeMessage({ type: 'getCaptureState' }, 1).captureOn === true &&
    api._emitRuntimeMessage({ type: 'getCaptureState' }, 2).captureOn === false);

  /* ---------- 场景 3：内存抓包缓冲上限与清空 ---------- */
  console.log('\n场景：抓包环形缓冲 100 条上限与生命周期清理');
  for (let i = 1; i <= 105; i++) {
    api._emitRuntimeMessage({ type: 'captured', entry: { id: 'c_' + i, url: '/api/' + i } }, 1);
  }
  const caps1 = ctrl.getCaptures(1);
  check('抓包缓冲只保留最新 100 条（不写 storage）',
    caps1.length === 100 && caps1[0].id === 'c_105' && caps1[99].id === 'c_6' &&
    !Object.keys(api._store).some((k) => k.includes('cap')));
  check('实时抓包同步推送给已连接的 Side Panel',
    panelMessages.some((m) => m.type === 'captureAdded' && m.entry.id === 'c_105'));

  /* ---------- 场景 4：切换标签页与暂停/关闭 ---------- */
  console.log('\n场景：切换标签页、暂停抓包与断开连接');
  api._tabMessages.length = 0;
  await api._activateTab(2);
  await tick();
  check('切到 Tab 2 时关闭 Tab 1 抓包、开启 Tab 2 抓包并通知 Panel',
    api._tabMessages.some((m) => m.tabId === 1 && m.msg.enabled === false) &&
    api._tabMessages.some((m) => m.tabId === 2 && m.msg.enabled === true) &&
    panelMessages.some((m) => m.type === 'activeTabChanged' && m.tabId === 2));

  api._tabMessages.length = 0;
  port._sendFromPanel({ type: 'setCapturePaused', paused: true });
  check('暂停抓包时向当前 Tab 2 发送 setCapture=false',
    api._tabMessages.some((m) => m.tabId === 2 && m.msg.type === 'setCapture' && m.msg.enabled === false) &&
    api._emitRuntimeMessage({ type: 'getCaptureState' }, 2).captureOn === false);

  port._sendFromPanel({ type: 'clearCaptures', tabId: 1 });
  check('clearCaptures 清空对应 Tab 抓包缓冲', ctrl.getCaptures(1).length === 0);

  port._sendFromPanel({ type: 'setCapturePaused', paused: false });
  api._tabMessages.length = 0;
  port._disconnect();
  check('Side Panel 断开时关闭当前 Tab 抓包',
    api._tabMessages.some((m) => m.tabId === 2 && m.msg.type === 'setCapture' && m.msg.enabled === false));

  api._emitRuntimeMessage({ type: 'captured', entry: { id: 'c_tab2', url: '/x' } }, 2);
  api._removeTab(2);
  check('标签页关闭时释放抓包缓冲内存', ctrl.getCaptures(2).length === 0);

  /* ---------- 场景 5：标签页已关闭时的 No tab with id 容错 ---------- */
  console.log('\n场景：已关闭或失效标签页不产生未检查 lastError');
  await api._emitTabActivatedRaw(999);
  await tick();

  api._badgeBgCalls.length = 0;
  await ctrl.refreshTabBadge(999, 'http://localhost:3000/closed');
  check('setBadgeText 遇 No tab with id 时不继续调用 setBadgeBackgroundColor',
    !api._badgeBgCalls.some((c) => c.tabId === 999));

  const conn2 = api._emitConnect('mock-panel-ui');
  await tick();
  api._dropTabSilently(1);
  conn2.port._disconnect();
  await tick();

  check('tabs.get / setBadgeText / tabs.sendMessage 遇到不存在的 tabId 均正确消费 runtime.lastError',
    api._getUncheckedErrors() === 0, 'uncheckedErrors=' + api._getUncheckedErrors());

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
