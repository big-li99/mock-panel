/* 侧边栏 Mock 规则列表、排序与导入导出视图 */

import { applyImport, exportRulesPayload, parseImportPayload } from '../shared/import_export.js';
import { ruleMatchesOrigin } from '../shared/matcher.js';
import {
  deleteRule,
  duplicateRule,
  loadRulesWithBodies,
  reorderRuleIds,
  toggleRuleEnabled
} from '../shared/storage.js';

const URL_OP_LABELS = {
  contains: '包含',
  equals: '精确',
  wildcard: '通配',
  regex: '正则'
};

const $ = (id) => document.getElementById(id);

export function createRulesView(ctx) {
  let dragSourceId = null;

  function init() {
    $('ruleSearch').addEventListener('input', render);
    $('btnNewRule').addEventListener('click', () => ctx.openNewRule());

    $('btnToggleIO').addEventListener('click', () => {
      $('ioDrawer').hidden = !$('ioDrawer').hidden;
      setIoMsg('');
    });

    $('btnExportSite').addEventListener('click', () => doExport('origin'));
    $('btnExportAll').addEventListener('click', () => doExport('all'));

    $('importFile').addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      await doImport(file);
    });
  }

  function setIoMsg(text, isErr = false) {
    const el = $('ioMsg');
    el.textContent = text || '';
    el.className = 'io-msg' + (isErr ? ' err' : '');
  }

  function getFilteredRules() {
    const { ruleIds, rulesById } = ctx.getStoreState();
    const filter = ctx.getSiteFilter();
    const activeOrigin = ctx.getActiveOrigin();
    const query = $('ruleSearch').value.trim().toLowerCase();

    const visible = [];
    for (const id of ruleIds) {
      const meta = rulesById[id];
      if (!meta) continue;

      if (filter === 'follow') {
        if (!ruleMatchesOrigin(meta, activeOrigin)) continue;
      } else if (filter === '*') {
        if (meta.scope !== '*') continue;
      } else if (filter !== 'all') {
        if (meta.scope !== filter) continue;
      }

      if (query) {
        const hay = `${meta.name} ${meta.method} ${meta.urlPattern} ${meta.scope}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      visible.push(meta);
    }
    return visible;
  }

  async function reorderVisible(newVisibleOrder) {
    const { ruleIds } = ctx.getStoreState();
    const oldSet = new Set(newVisibleOrder);
    const slots = [];
    for (let i = 0; i < ruleIds.length; i++) {
      if (oldSet.has(ruleIds[i])) slots.push(i);
    }
    if (slots.length !== newVisibleOrder.length) return;

    const nextIds = ruleIds.slice();
    for (let i = 0; i < slots.length; i++) {
      nextIds[slots[i]] = newVisibleOrder[i];
    }
    await reorderRuleIds(nextIds);
    await ctx.onRuleMutated(ctx.getSelectedRuleId());
  }

  function render() {
    const visible = getFilteredRules();
    const canReorder = !$('ruleSearch').value.trim();
    const selectedId = ctx.getSelectedRuleId();

    $('rulesCount').textContent = String(visible.length);
    $('rulesSortHint').textContent = canReorder
      ? '按列表从上到下命中第一条；可拖拽或用 ↑ ↓ 调序'
      : '搜索筛选状态下暂不可调序；清空搜索后可拖拽或调序';

    const listEl = $('rulesList');
    const emptyEl = $('rulesEmpty');
    listEl.textContent = '';

    if (!visible.length) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    visible.forEach((meta, index) => {
      const card = document.createElement('div');
      card.className = 'rule-card' +
        (meta.id === selectedId ? ' active' : '') +
        (meta.enabled === false ? ' off' : '');
      card.draggable = canReorder;
      card.dataset.ruleId = meta.id;

      // 拖拽排序
      card.addEventListener('dragstart', (e) => {
        if (!canReorder) { e.preventDefault(); return; }
        dragSourceId = meta.id;
        card.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        dragSourceId = null;
        card.classList.remove('dragging');
        for (const el of listEl.querySelectorAll('.drag-over')) {
          el.classList.remove('drag-over');
        }
      });
      card.addEventListener('dragover', (e) => {
        if (!canReorder || !dragSourceId || dragSourceId === meta.id) return;
        e.preventDefault();
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (!canReorder || !dragSourceId || dragSourceId === meta.id) return;
        const order = visible.map((r) => r.id);
        const from = order.indexOf(dragSourceId);
        const to = order.indexOf(meta.id);
        if (from === -1 || to === -1) return;
        order.splice(from, 1);
        order.splice(to, 0, dragSourceId);
        await reorderVisible(order);
      });

      // Top line: handle + name + switch + quick actions
      const top = document.createElement('div');
      top.className = 'card-top';

      const handle = document.createElement('span');
      handle.className = 'drag-handle' + (canReorder ? '' : ' disabled');
      handle.textContent = '⋮⋮';
      handle.title = canReorder ? '拖拽排序' : '搜索时不可排序';

      const nameEl = document.createElement('span');
      nameEl.className = 'card-name';
      nameEl.textContent = meta.name;

      const swLabel = document.createElement('label');
      swLabel.className = 'switch xs';
      swLabel.title = meta.enabled !== false ? '点击停用' : '点击启用';
      swLabel.addEventListener('click', (e) => e.stopPropagation());
      const swInput = document.createElement('input');
      swInput.type = 'checkbox';
      swInput.checked = meta.enabled !== false;
      swInput.addEventListener('change', async (e) => {
        e.stopPropagation();
        await toggleRuleEnabled(meta.id, swInput.checked);
        await ctx.onRuleMutated(ctx.getSelectedRuleId());
      });
      const track = document.createElement('span');
      track.className = 'track';
      const knob = document.createElement('span');
      knob.className = 'knob';
      track.appendChild(knob);
      swLabel.append(swInput, track);

      const actions = document.createElement('div');
      actions.className = 'card-actions';
      actions.addEventListener('click', (e) => e.stopPropagation());

      const btnUp = document.createElement('button');
      btnUp.className = 'mini-btn';
      btnUp.textContent = '↑';
      btnUp.title = '上移';
      btnUp.disabled = !canReorder || index === 0;
      btnUp.addEventListener('click', async () => {
        const order = visible.map((r) => r.id);
        [order[index - 1], order[index]] = [order[index], order[index - 1]];
        await reorderVisible(order);
      });

      const btnDown = document.createElement('button');
      btnDown.className = 'mini-btn';
      btnDown.textContent = '↓';
      btnDown.title = '下移';
      btnDown.disabled = !canReorder || index === visible.length - 1;
      btnDown.addEventListener('click', async () => {
        const order = visible.map((r) => r.id);
        [order[index], order[index + 1]] = [order[index + 1], order[index]];
        await reorderVisible(order);
      });

      const btnDup = document.createElement('button');
      btnDup.className = 'mini-btn';
      btnDup.textContent = '复制';
      btnDup.title = '复制规则';
      btnDup.addEventListener('click', async () => {
        const copy = await duplicateRule(meta.id);
        await ctx.onRuleMutated(copy ? copy.id : ctx.getSelectedRuleId());
      });

      const btnDel = document.createElement('button');
      btnDel.className = 'mini-btn danger';
      btnDel.textContent = '✕';
      btnDel.title = '删除规则';
      btnDel.addEventListener('click', async () => {
        await deleteRule(meta.id);
        const nextSel = selectedId === meta.id ? null : selectedId;
        await ctx.onRuleMutated(nextSel);
        if (selectedId === meta.id) ctx.exitDetailPane();
      });

      actions.append(btnUp, btnDown, btnDup, btnDel);
      top.append(handle, nameEl, swLabel, actions);

      // Middle line: Method + URL
      const mid = document.createElement('div');
      mid.className = 'card-mid';
      const mPill = document.createElement('span');
      mPill.className = `method-pill ${meta.method}`;
      mPill.textContent = meta.method === 'ANY' ? 'ANY' : meta.method;
      const urlSpan = document.createElement('span');
      urlSpan.className = 'card-url';
      urlSpan.textContent = meta.urlPattern || '（未填 URL）';
      mid.append(mPill, urlSpan);

      // Bottom line: meta chips
      const bottom = document.createElement('div');
      bottom.className = 'card-meta';

      const opChip = document.createElement('span');
      opChip.className = 'chip';
      opChip.textContent = URL_OP_LABELS[meta.urlOp] || meta.urlOp;
      bottom.appendChild(opChip);

      const stChip = document.createElement('span');
      stChip.className = 'chip ' + (meta.status >= 500 ? 'err' : (meta.status >= 400 ? 'warn' : 'ok'));
      stChip.textContent = String(meta.status || 200);
      bottom.appendChild(stChip);

      if (meta.delayMs > 0) {
        const dlChip = document.createElement('span');
        dlChip.className = 'chip';
        dlChip.textContent = `${meta.delayMs}ms`;
        bottom.appendChild(dlChip);
      }

      if (meta.conditions && meta.conditions.length) {
        const cChip = document.createElement('span');
        cChip.className = 'chip';
        cChip.textContent = `${meta.conditions.length} 条件`;
        bottom.appendChild(cChip);
      }

      const scopeChip = document.createElement('span');
      scopeChip.className = 'chip';
      scopeChip.textContent = meta.scope === '*' ? '全局' : meta.scope.replace(/^https?:\/\//, '');
      bottom.appendChild(scopeChip);

      card.append(top, mid, bottom);
      card.addEventListener('click', () => ctx.openRule(meta));
      listEl.appendChild(card);
    });
  }

  async function doExport(scopeMode) {
    const { ruleIds, rulesById } = ctx.getStoreState();
    const { bodiesById } = await loadRulesWithBodies(ruleIds);
    const filter = ctx.getSiteFilter();
    const targetOrigin = (filter !== 'follow' && filter !== 'all' && filter !== '*')
      ? filter
      : ctx.getActiveOrigin();

    const payload = exportRulesPayload({
      scope: scopeMode === 'origin' && targetOrigin ? 'origin' : 'all',
      origin: targetOrigin,
      ruleIds,
      rulesById,
      bodiesById
    });

    if (!payload.rules.length) {
      setIoMsg('当前范围没有可导出的规则', true);
      return;
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `mock-panel-rules-${date}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setIoMsg(`已导出 ${payload.rules.length} 条规则`);
  }

  async function doImport(file) {
    try {
      const text = await file.text();
      const parsed = parseImportPayload(text);
      if (!parsed.ok) {
        setIoMsg(parsed.error, true);
        return;
      }
      const modeEl = document.querySelector('input[name="importMode"]:checked');
      const mode = modeEl ? modeEl.value : 'merge';
      const stats = await applyImport(parsed.rules, mode);
      await ctx.onRuleMutated(null);
      setIoMsg(`导入成功：新增 ${stats.added} 条，更新 ${stats.updated} 条（共 ${stats.total} 条）`);
    } catch (err) {
      setIoMsg(`导入失败：${err.message}`, true);
    }
  }

  return {
    init,
    render
  };
}
