/* MockPanel Side Panel 主入口与视图协调 */

import { PORT_PANEL } from '../shared/constants.js';
import { listKnownOrigins, loadAllMeta, setGlobalEnabled } from '../shared/storage.js';
import { createCapturesView } from './captures_view.js';
import { createEditorView } from './editor_view.js';
import { createRulesView } from './rules_view.js';

const $ = (id) => document.getElementById(id);

let storeState = { enabled: true, ruleIds: [], rulesById: {} };
let activeTabId = null;
let activeOrigin = '';
let siteFilter = 'follow';
let activeMainTab = 'rules';
let port = null;

function renderHead() {
  $('master').checked = storeState.enabled;
  $('masterText').textContent = storeState.enabled ? '已开启' : '已关闭';
  $('dot').className = 'dot' + (storeState.enabled ? ' on' : '');
}

function renderSiteSelect() {
  const sel = $('siteSelect');
  const prev = siteFilter;
  sel.textContent = '';

  const followOpt = document.createElement('option');
  followOpt.value = 'follow';
  followOpt.textContent = activeOrigin ? `当前站点 (${activeOrigin})` : '当前页面（非 HTTP）';
  sel.appendChild(followOpt);

  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = '全部站点规则';
  sel.appendChild(allOpt);

  const globalOpt = document.createElement('option');
  globalOpt.value = '*';
  globalOpt.textContent = '仅全局规则 (*)';
  sel.appendChild(globalOpt);

  const known = listKnownOrigins(storeState.rulesById);
  for (const origin of known) {
    if (origin === activeOrigin) continue;
    const opt = document.createElement('option');
    opt.value = origin;
    opt.textContent = `站点: ${origin}`;
    sel.appendChild(opt);
  }

  const hasPrev = Array.from(sel.options).some((o) => o.value === prev);
  siteFilter = hasPrev ? prev : 'follow';
  sel.value = siteFilter;
}

function switchMainTab(next) {
  activeMainTab = next;
  $('tabRules').className = 'tab' + (next === 'rules' ? ' active' : '');
  $('tabCaptures').className = 'tab' + (next === 'captures' ? ' active' : '');
  $('rulesPanel').hidden = next !== 'rules';
  $('capturesPanel').hidden = next !== 'captures';
}

function showDetailMode(mode) {
  $('app').classList.add('editing');
  $('detailEmpty').hidden = mode !== 'empty';
  $('editorView').hidden = mode !== 'editor';
  $('captureDetailView').hidden = mode !== 'capture';
}

function exitDetailPane() {
  $('app').classList.remove('editing');
  $('detailEmpty').hidden = false;
  $('editorView').hidden = true;
  $('captureDetailView').hidden = true;
  editorView.clearCurrent();
}

const ctx = {
  getStoreState: () => storeState,
  getActiveOrigin: () => activeOrigin,
  getKnownOrigins: () => listKnownOrigins(storeState.rulesById),
  getSiteFilter: () => siteFilter,
  getSelectedRuleId: () => editorView.getCurrentRuleId(),
  getPreferredScopeForNew: () => {
    if (siteFilter === '*') return '*';
    if (siteFilter !== 'follow' && siteFilter !== 'all') return siteFilter;
    return activeOrigin || '*';
  },
  showEditorPane: () => showDetailMode('editor'),
  showCaptureDetailPane: () => showDetailMode('capture'),
  exitDetailPane,
  openRule: (meta) => {
    switchMainTab('rules');
    editorView.openExisting(meta);
    rulesView.render();
  },
  openNewRule: () => {
    switchMainTab('rules');
    editorView.openNewDraft();
    rulesView.render();
  },
  openDraftFromCapture: (meta, body, captureEntry) => {
    switchMainTab('rules');
    editorView.openNewDraft(meta, body, captureEntry);
    rulesView.render();
  },
  jumpToRuleById: (ruleId) => {
    const meta = storeState.rulesById[ruleId];
    if (!meta) return;
    switchMainTab('rules');
    editorView.openExisting(meta);
    rulesView.render();
  },
  async onRuleMutated() {
    await refreshStore();
  },
  setCapturePaused(paused) {
    if (port) port.postMessage({ type: 'setCapturePaused', paused });
  },
  clearCaptures() {
    if (port) port.postMessage({ type: 'clearCaptures', tabId: activeTabId });
  }
};

const rulesView = createRulesView(ctx);
const capturesView = createCapturesView(ctx);
const editorView = createEditorView(ctx);

async function refreshStore() {
  storeState = await loadAllMeta();
  renderHead();
  renderSiteSelect();
  rulesView.render();
}

function connectBackground() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connect) return;
  try {
    port = chrome.runtime.connect({ name: PORT_PANEL });
  } catch {
    port = null;
    return;
  }

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init' || msg.type === 'activeTabChanged') {
      activeTabId = msg.tabId ?? null;
      activeOrigin = msg.origin || '';
      capturesView.setPaused(Boolean(msg.paused));
      capturesView.setCaptures(msg.captures || [], false);
      if (msg.type === 'activeTabChanged' && !$('captureDetailView').hidden) {
        exitDetailPane();
      }
      renderSiteSelect();
      rulesView.render();
    } else if (msg.type === 'captureAdded') {
      if (msg.tabId === activeTabId) {
        capturesView.prependCapture(msg.entry);
      }
    } else if (msg.type === 'capturesCleared') {
      if (msg.tabId === activeTabId || msg.tabId == null) {
        capturesView.setCaptures([], false);
        if (!$('captureDetailView').hidden) exitDetailPane();
      }
    } else if (msg.type === 'captureStateChanged') {
      capturesView.setPaused(Boolean(msg.paused));
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
  });
}

function reloadTabSafe(tabId, allowFallback) {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.reload) return;
  let handled = false;
  const fallbackOnce = () => {
    if (handled || !allowFallback || !chrome.tabs.query) return;
    handled = true;
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        const target = tabs && tabs[0];
        if (target && target.id != null) {
          reloadTabSafe(target.id, false);
        }
      });
    } catch { /* ignore */ }
  };

  if (tabId == null) {
    fallbackOnce();
    return;
  }

  try {
    const ret = chrome.tabs.reload(tabId, () => {
      if (chrome.runtime && chrome.runtime.lastError) {
        fallbackOnce();
      }
    });
    if (ret && typeof ret.catch === 'function') {
      ret.catch(() => fallbackOnce());
    }
  } catch {
    fallbackOnce();
  }
}

function bindTopEvents() {
  $('tabRules').addEventListener('click', () => switchMainTab('rules'));
  $('tabCaptures').addEventListener('click', () => switchMainTab('captures'));

  $('siteSelect').addEventListener('change', () => {
    siteFilter = $('siteSelect').value;
    rulesView.render();
  });

  $('master').addEventListener('change', async () => {
    const next = $('master').checked;
    storeState.enabled = next;
    renderHead();
    await setGlobalEnabled(next);
  });

  $('btnReload').addEventListener('click', () => {
    reloadTabSafe(activeTabId, true);
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area === 'local') refreshStore();
    });
  }

  window.addEventListener('resize', () => {
    if (!$('editorView').hidden) editorView.refresh();
  });
}

async function boot() {
  rulesView.init();
  capturesView.init();
  editorView.init();
  bindTopEvents();
  await refreshStore();
  connectBackground();
}

boot();
