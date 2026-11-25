/* MockPanel —— 后台 Service Worker
 *
 * 职责：
 *   1. 初始化默认配置、点击扩展图标打开侧边栏；
 *   2. 管理 Side Panel Port 连接：侧边栏打开时开启当前激活标签页抓包，断开或切走时停止；
 *   3. 在内存中维护每个标签页的抓包环形缓冲（最多 MAX_CAPTURE_PER_TAB 条，不写磁盘）；
 *   4. 按当前标签页 origin 实时维护扩展图标角标。
 */

import {
  K_ENABLED,
  K_RULE_IDS,
  MAX_CAPTURE_PER_TAB,
  P_RULE,
  PORT_PANEL
} from './shared/constants.js';
import { extractOrigin } from './shared/matcher.js';
import {
  countActiveRulesForOrigin,
  loadAllMeta,
  seedDefaults
} from './shared/storage.js';

export function createController(chromeApi) {
  let panelPort = null;
  let activeTabId = null;
  let activeUrl = '';
  let activeOrigin = '';
  let capturePaused = false;
  const capturesByTab = new Map();
  const removedTabIds = new Set();

  function callApiWithStatus(fn, ...args) {
    return new Promise((resolve) => {
      try {
        let settled = false;
        const done = (ok, value) => {
          if (settled) return;
          settled = true;
          resolve({ ok, value });
        };
        const ret = fn(...args, (cbVal) => {
          const lastErr = chromeApi.runtime && chromeApi.runtime.lastError;
          if (lastErr) {
            done(false, undefined);
            return;
          }
          done(true, cbVal);
        });
        if (ret && typeof ret.then === 'function') {
          ret.then((val) => done(true, val), () => done(false, undefined));
        }
      } catch {
        resolve({ ok: false, value: undefined });
      }
    });
  }

  async function callApi(fn, ...args) {
    const res = await callApiWithStatus(fn, ...args);
    return res.value;
  }

  function markTabRemoved(tabId) {
    if (tabId == null) return;
    if (removedTabIds.size >= 500) {
      const oldest = removedTabIds.values().next().value;
      removedTabIds.delete(oldest);
    }
    removedTabIds.add(tabId);
  }

  function getCaptures(tabId) {
    if (tabId == null) return [];
    return capturesByTab.get(tabId) || [];
  }

  function pushCapture(tabId, entry) {
    const prev = capturesByTab.get(tabId) || [];
    const next = [entry, ...prev].slice(0, MAX_CAPTURE_PER_TAB);
    capturesByTab.set(tabId, next);
    return next;
  }

  function postToPanel(msg) {
    if (!panelPort) return;
    try {
      panelPort.postMessage(msg);
    } catch {
      panelPort = null;
    }
  }

  function safeSendTab(tabId, msg) {
    if (tabId == null || removedTabIds.has(tabId) || !chromeApi.tabs || !chromeApi.tabs.sendMessage) return;
    try {
      const ret = chromeApi.tabs.sendMessage(tabId, msg, () => {
        void (chromeApi.runtime && chromeApi.runtime.lastError);
      });
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch { /* ignore */ }
  }

  async function queryCurrentActiveTab() {
    if (!chromeApi.tabs || !chromeApi.tabs.query) return null;
    const lastFocused = await callApi(
      chromeApi.tabs.query.bind(chromeApi.tabs),
      { active: true, lastFocusedWindow: true }
    );
    if (Array.isArray(lastFocused) && lastFocused.length) return lastFocused[0];

    const currentWin = await callApi(
      chromeApi.tabs.query.bind(chromeApi.tabs),
      { active: true, currentWindow: true }
    );
    if (Array.isArray(currentWin) && currentWin.length) return currentWin[0];

    const anyActive = await callApi(
      chromeApi.tabs.query.bind(chromeApi.tabs),
      { active: true }
    );
    return Array.isArray(anyActive) && anyActive.length ? anyActive[0] : null;
  }

  async function setBadgeForTab(tabId, text, color) {
    if (!chromeApi.action) return;
    if (tabId != null && removedTabIds.has(tabId)) return;
    const textPayload = tabId != null ? { tabId, text } : { text };
    const colorPayload = tabId != null ? { tabId, color } : { color };
    const res = await callApiWithStatus(chromeApi.action.setBadgeText.bind(chromeApi.action), textPayload);
    if (!res.ok) return;
    if (tabId != null && removedTabIds.has(tabId)) return;
    await callApiWithStatus(chromeApi.action.setBadgeBackgroundColor.bind(chromeApi.action), colorPayload);
  }

  async function refreshTabBadge(tabId, url) {
    if (!chromeApi.storage || !chromeApi.storage.local) return;
    if (tabId != null && removedTabIds.has(tabId)) return;
    const { enabled, ruleIds, rulesById } = await loadAllMeta(chromeApi.storage.local);
    if (tabId != null && removedTabIds.has(tabId)) return;
    if (!enabled) {
      await setBadgeForTab(tabId, 'off', '#9aa4b2');
      return;
    }
    const origin = extractOrigin(url);
    if (!origin) {
      await setBadgeForTab(tabId, '', '#9aa4b2');
      return;
    }
    const count = countActiveRulesForOrigin(enabled, ruleIds, rulesById, origin);
    await setBadgeForTab(tabId, count > 0 ? String(count) : '', count > 0 ? '#16a34a' : '#9aa4b2');
  }

  async function refreshAllWindowBadges() {
    if (!chromeApi.tabs || !chromeApi.tabs.query) return;
    const tabs = await callApi(chromeApi.tabs.query.bind(chromeApi.tabs), { active: true });
    if (!Array.isArray(tabs)) return;
    for (const tab of tabs) {
      if (tab && tab.id != null && !removedTabIds.has(tab.id)) {
        await refreshTabBadge(tab.id, tab.url || '');
      }
    }
  }

  async function syncActiveTab(tab) {
    const prevTabId = activeTabId;
    const nextTabId = tab && tab.id != null && !removedTabIds.has(tab.id) ? tab.id : null;
    const nextUrl = nextTabId != null ? ((tab && tab.url) || '') : '';
    const nextOrigin = extractOrigin(nextUrl);
    const changed = prevTabId !== nextTabId;

    activeTabId = nextTabId;
    activeUrl = nextUrl;
    activeOrigin = nextOrigin;

    if (panelPort) {
      if (changed && prevTabId != null) {
        safeSendTab(prevTabId, { type: 'setCapture', enabled: false });
      }
      if (nextTabId != null) {
        safeSendTab(nextTabId, { type: 'setCapture', enabled: !capturePaused });
      }
      postToPanel({
        type: 'activeTabChanged',
        tabId: activeTabId,
        url: activeUrl,
        origin: activeOrigin,
        paused: capturePaused,
        captures: getCaptures(activeTabId)
      });
    }

    if (activeTabId != null) {
      await refreshTabBadge(activeTabId, activeUrl);
    }
  }

  async function sendPanelInit(port) {
    const tab = await queryCurrentActiveTab();
    const validTab = tab && tab.id != null && !removedTabIds.has(tab.id) ? tab : null;
    activeTabId = validTab ? validTab.id : null;
    activeUrl = validTab ? (validTab.url || '') : '';
    activeOrigin = extractOrigin(activeUrl);

    if (activeTabId != null) {
      safeSendTab(activeTabId, { type: 'setCapture', enabled: !capturePaused });
      await refreshTabBadge(activeTabId, activeUrl);
    }

    if (panelPort === port) {
      try {
        port.postMessage({
          type: 'init',
          tabId: activeTabId,
          url: activeUrl,
          origin: activeOrigin,
          paused: capturePaused,
          captures: getCaptures(activeTabId)
        });
      } catch { /* ignore */ }
    }
  }

  function handleConnect(port) {
    if (!port || port.name !== PORT_PANEL) return;
    panelPort = port;
    capturePaused = false;

    sendPanelInit(port);

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'setCapturePaused') {
        capturePaused = Boolean(msg.paused);
        if (activeTabId != null) {
          safeSendTab(activeTabId, { type: 'setCapture', enabled: !capturePaused });
        }
        postToPanel({ type: 'captureStateChanged', paused: capturePaused });
      } else if (msg.type === 'clearCaptures') {
        const targetId = msg.tabId != null ? msg.tabId : activeTabId;
        if (targetId != null) capturesByTab.delete(targetId);
        postToPanel({ type: 'capturesCleared', tabId: targetId });
      } else if (msg.type === 'requestState') {
        sendPanelInit(port);
      }
    });

    port.onDisconnect.addListener(() => {
      if (panelPort !== port) return;
      panelPort = null;
      if (activeTabId != null) {
        safeSendTab(activeTabId, { type: 'setCapture', enabled: false });
      }
    });
  }

  function handleMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return false;
    const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;

    if (msg.type === 'getCaptureState') {
      const captureOn = Boolean(panelPort && !capturePaused && tabId != null && tabId === activeTabId);
      if (sendResponse) sendResponse({ captureOn });
      return false;
    }

    if (msg.type === 'captured') {
      if (tabId == null || !msg.entry) return false;
      const entry = { ...msg.entry, tabId };
      pushCapture(tabId, entry);
      if (panelPort && tabId === activeTabId) {
        postToPanel({ type: 'captureAdded', tabId, entry });
      }
      return false;
    }

    return false;
  }

  function init() {
    if (chromeApi.sidePanel && chromeApi.sidePanel.setPanelBehavior) {
      try {
        const ret = chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      } catch { /* ignore */ }
    }

    chromeApi.runtime.onInstalled?.addListener(() => {
      seedDefaults(chromeApi.storage.local).then(refreshAllWindowBadges).catch(() => {});
    });

    chromeApi.runtime.onStartup?.addListener(() => {
      refreshAllWindowBadges().catch(() => {});
    });

    chromeApi.runtime.onConnect?.addListener(handleConnect);
    chromeApi.runtime.onMessage?.addListener(handleMessage);

    chromeApi.tabs?.onActivated?.addListener(async ({ tabId }) => {
      if (removedTabIds.has(tabId)) return;
      const tab = await callApi(chromeApi.tabs.get.bind(chromeApi.tabs), tabId);
      if (tab && !removedTabIds.has(tab.id)) await syncActiveTab(tab);
    });

    chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
      if (!tab || !tab.active || removedTabIds.has(tabId)) return;
      if (changeInfo && (changeInfo.url || changeInfo.status === 'complete')) {
        syncActiveTab(tab);
      }
    });

    chromeApi.windows?.onFocusChanged?.addListener(async (windowId) => {
      if (windowId === -1) return;
      const tab = await queryCurrentActiveTab();
      if (tab && !removedTabIds.has(tab.id)) await syncActiveTab(tab);
    });

    chromeApi.tabs?.onRemoved?.addListener((tabId) => {
      markTabRemoved(tabId);
      capturesByTab.delete(tabId);
      if (activeTabId === tabId) {
        activeTabId = null;
        activeUrl = '';
        activeOrigin = '';
      }
    });

    chromeApi.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      const relevant = Object.keys(changes).some(
        (k) => k === K_ENABLED || k === K_RULE_IDS || k.startsWith(P_RULE)
      );
      if (relevant) refreshAllWindowBadges().catch(() => {});
    });

    refreshAllWindowBadges().catch(() => {});
  }

  return {
    init,
    refreshTabBadge,
    refreshAllWindowBadges,
    syncActiveTab,
    getState() {
      return {
        panelConnected: Boolean(panelPort),
        activeTabId,
        activeUrl,
        activeOrigin,
        capturePaused,
        captureCounts: new Map(Array.from(capturesByTab.entries()).map(([k, v]) => [k, v.length]))
      };
    },
    getCaptures
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.storage) {
  const controller = createController(chrome);
  controller.init();
}
