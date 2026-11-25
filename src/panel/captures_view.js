/* 侧边栏实时抓包列表、详情预览与点选条件一键建规则视图 */

import { extractSelectableFields } from '../shared/matcher.js';

const SOURCE_LABELS = { query: 'Query', header: 'Header', body: 'Body' };

const $ = (id) => document.getElementById(id);

function fmtSize(n) {
  n = n || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function tryPrettyJson(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatHeadersText(map) {
  if (!map || typeof map !== 'object') return '（无）';
  const keys = Object.keys(map).sort();
  if (!keys.length) return '（无）';
  return keys.map((k) => `${k}: ${map[k]}`).join('\n');
}

function pathnameOf(url) {
  try {
    return new URL(url, 'http://localhost').pathname || '/';
  } catch {
    return String(url || '').split('?')[0] || '/';
  }
}

export function createCapturesView(ctx) {
  let captures = [];
  let paused = false;
  let selectedId = null;
  let activeSubTab = 'fields';
  let checkedFieldKeys = new Set();

  function init() {
    $('capSearch').addEventListener('input', renderList);
    $('capMethod').addEventListener('change', renderList);

    $('btnPauseCap').addEventListener('click', () => {
      ctx.setCapturePaused(!paused);
    });

    $('btnClearCap').addEventListener('click', () => {
      ctx.clearCaptures();
    });

    $('btnBackFromCap').addEventListener('click', () => {
      selectedId = null;
      ctx.exitDetailPane();
      renderList();
    });

    for (const btn of $('capSubTabs').querySelectorAll('.sub-tab')) {
      btn.addEventListener('click', () => {
        activeSubTab = btn.dataset.capTab;
        renderSubTabs();
      });
    }

    $('btnCopyCapRes').addEventListener('click', () => {
      const entry = getSelectedEntry();
      if (!entry || !navigator.clipboard) return;
      navigator.clipboard.writeText(tryPrettyJson(entry.resBody) || '').catch(() => {});
    });

    $('btnCopyCapReq').addEventListener('click', () => {
      const entry = getSelectedEntry();
      if (!entry || !navigator.clipboard) return;
      navigator.clipboard.writeText(tryPrettyJson(entry.reqBody) || '').catch(() => {});
    });

    $('btnJumpRule').addEventListener('click', () => {
      const entry = getSelectedEntry();
      if (entry && entry.matchedRuleId) {
        ctx.jumpToRuleById(entry.matchedRuleId);
      }
    });

    $('btnCreateMock').addEventListener('click', () => {
      const entry = getSelectedEntry();
      if (!entry) return;
      createMockFromEntry(entry);
    });
  }

  function getSelectedEntry() {
    if (!selectedId) return null;
    return captures.find((c) => c.id === selectedId) || null;
  }

  function setCaptures(list, keepSelection = false) {
    captures = Array.isArray(list) ? list.slice() : [];
    if (!keepSelection) selectedId = null;
    else if (selectedId && !getSelectedEntry()) selectedId = null;
    renderList();
    if (selectedId) renderDetail();
  }

  function prependCapture(entry) {
    if (!entry) return;
    captures = [entry, ...captures].slice(0, 100);
    renderList();
  }

  function setPaused(val) {
    paused = Boolean(val);
    $('btnPauseCap').textContent = paused ? '继续' : '暂停';
    $('recDot').className = 'rec-dot' + (paused ? ' paused' : '');
    $('capStatusStrip').textContent = paused
      ? '抓包已暂停（已开启的 Mock 规则仍会正常生效）'
      : '正在监听当前标签页的 XHR / fetch 请求…';
  }

  function renderSubTabs() {
    for (const btn of $('capSubTabs').querySelectorAll('.sub-tab')) {
      btn.className = 'sub-tab' + (btn.dataset.capTab === activeSubTab ? ' active' : '');
    }
    $('capTabFields').hidden = activeSubTab !== 'fields';
    $('capTabRes').hidden = activeSubTab !== 'res';
    $('capTabReq').hidden = activeSubTab !== 'req';
  }

  function renderList() {
    $('capturesCount').textContent = String(captures.length);
    const query = $('capSearch').value.trim().toLowerCase();
    const methodFilter = $('capMethod').value;

    const filtered = captures.filter((c) => {
      if (methodFilter !== 'ALL' && c.method !== methodFilter) return false;
      if (!query) return true;
      const hay = `${c.method} ${c.path} ${c.url} ${c.status} ${c.matchedRuleName || ''}`.toLowerCase();
      return hay.includes(query);
    });

    const listEl = $('capturesList');
    const emptyEl = $('capturesEmpty');
    listEl.textContent = '';

    if (!filtered.length) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    for (const c of filtered) {
      const card = document.createElement('div');
      card.className = 'cap-card' + (c.id === selectedId ? ' active' : '');

      const top = document.createElement('div');
      top.className = 'card-mid';

      const mPill = document.createElement('span');
      mPill.className = `method-pill ${c.method}`;
      mPill.textContent = c.method;

      const pathSpan = document.createElement('span');
      pathSpan.className = 'card-url';
      pathSpan.textContent = c.path || c.url;

      const stChip = document.createElement('span');
      stChip.className = 'chip ' + (c.status >= 500 || c.status === 0 ? 'err' : (c.status >= 400 ? 'warn' : 'ok'));
      stChip.textContent = c.status ? String(c.status) : 'ERR';

      top.append(mPill, pathSpan, stChip);

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      if (c.mocked) {
        const mockTag = document.createElement('span');
        mockTag.className = 'chip mock';
        mockTag.textContent = c.matchedRuleName ? `Mock: ${c.matchedRuleName}` : 'Mock';
        meta.appendChild(mockTag);
      }

      const dur = document.createElement('span');
      dur.textContent = `${c.durationMs || 0}ms`;
      const size = document.createElement('span');
      size.textContent = fmtSize(c.size);
      meta.append(dur, size);

      card.append(top, meta);
      card.addEventListener('click', () => {
        selectedId = c.id;
        checkedFieldKeys = new Set();
        renderList();
        renderDetail();
        ctx.showCaptureDetailPane();
      });
      listEl.appendChild(card);
    }
  }

  function renderDetail() {
    const entry = getSelectedEntry();
    if (!entry) return;

    const methodEl = $('capDetailMethod');
    methodEl.className = `method-pill ${entry.method}`;
    methodEl.textContent = entry.method;
    $('capDetailPath').textContent = entry.path || entry.url;

    const jumpBtn = $('btnJumpRule');
    jumpBtn.hidden = !entry.matchedRuleId;

    const metaEl = $('capDetailMeta');
    metaEl.textContent = '';
    const bits = [
      `状态 ${entry.status || 0}`,
      `耗时 ${entry.durationMs || 0}ms`,
      `体积 ${fmtSize(entry.size)}`,
      entry.mocked ? `命中 Mock（${entry.matchedRuleName || entry.matchedRuleId}）` : '真实网络响应',
      entry.url
    ];
    for (const b of bits) {
      const s = document.createElement('span');
      s.textContent = b;
      metaEl.appendChild(s);
    }

    // 点选条件列表
    const fieldsList = $('capFieldsList');
    fieldsList.textContent = '';
    const fields = extractSelectableFields(entry);
    if (!fields.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = '该请求没有提取到可点选的 Query / 请求头 / 请求体字段，可直接点右上角「创建 Mock 规则」。';
      fieldsList.appendChild(empty);
    } else {
      for (const f of fields) {
        const fKey = `${f.source}\u0000${f.path}`;
        const row = document.createElement('label');
        row.className = 'pick-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checkedFieldKeys.has(fKey);
        cb.addEventListener('change', () => {
          if (cb.checked) checkedFieldKeys.add(fKey);
          else checkedFieldKeys.delete(fKey);
        });

        const src = document.createElement('span');
        src.className = 'pick-src';
        src.textContent = SOURCE_LABELS[f.source] || f.source;

        const p = document.createElement('span');
        p.className = 'pick-path';
        p.textContent = f.path;

        const v = document.createElement('span');
        v.className = 'pick-val';
        v.textContent = f.value;
        v.title = f.value;

        row.append(cb, src, p, v);
        fieldsList.appendChild(row);
      }
    }

    // 响应体与请求体预览
    $('capResPre').textContent = tryPrettyJson(entry.resBody) || '（空响应体）';
    $('capResHeadersPre').textContent = formatHeadersText(entry.resHeaders);
    $('capReqBodyPre').textContent = tryPrettyJson(entry.reqBody) || '（无请求体）';
    $('capReqHeadersPre').textContent = formatHeadersText(entry.reqHeaders);

    renderSubTabs();
  }

  function createMockFromEntry(entry) {
    const pathname = pathnameOf(entry.url);
    const fields = extractSelectableFields(entry);
    const conditions = [];
    for (const f of fields) {
      const key = `${f.source}\u0000${f.path}`;
      if (checkedFieldKeys.has(key)) {
        conditions.push({ source: f.source, path: f.path, op: 'equals', value: f.value });
      }
    }

    const ct = (entry.resHeaders && entry.resHeaders['content-type']) || 'application/json;charset=utf-8';
    const prettyBody = tryPrettyJson(entry.resBody);

    ctx.openDraftFromCapture({
      name: `${entry.method} ${pathname}`,
      scope: entry.origin || ctx.getPreferredScopeForNew(),
      method: entry.method || 'ANY',
      urlOp: 'equals',
      urlPattern: pathname,
      conditions,
      status: entry.status >= 100 && entry.status <= 599 ? entry.status : 200,
      delayMs: 0,
      responseHeaders: [],
      contentType: ct,
      enabled: true
    }, prettyBody, entry);
  }

  return {
    init,
    setCaptures,
    prependCapture,
    setPaused,
    clearSelection() { selectedId = null; }
  };
}
