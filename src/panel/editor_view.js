/* 侧边栏规则编辑视图（支持 CodeMirror 5 与查找替换浮层） */

import {
  COND_OPS,
  COND_SOURCES,
  METHODS,
  NULL_BODY_STATUSES
} from '../shared/constants.js';
import {
  extractSelectableFields,
  isValidRegex,
  makeRuleId,
  sanitizeRuleMeta
} from '../shared/matcher.js';
import {
  deleteRule,
  duplicateRule,
  loadRuleBody,
  saveRule
} from '../shared/storage.js';

const SOURCE_LABELS = { query: 'Query', header: '请求头', body: '请求体' };
const OP_LABELS = {
  equals: '等于',
  notEquals: '不等于',
  contains: '包含',
  exists: '存在',
  regex: '正则'
};

const $ = (id) => document.getElementById(id);

export function createEditorView(ctx) {
  let currentRule = null;
  let isNewDraft = false;
  let sourceCapture = null;
  let cm = null;
  let findCaseSensitive = false;
  let findMarks = [];
  const FIND_MARK_LIMIT = 500;

  function init() {
    const methodSel = $('fMethod');
    methodSel.textContent = '';
    for (const m of METHODS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m === 'ANY' ? '全部' : m;
      methodSel.appendChild(opt);
    }

    if (typeof CodeMirror !== 'undefined' && typeof CodeMirror.fromTextArea === 'function') {
      cm = CodeMirror.fromTextArea($('fBody'), {
        mode: { name: 'javascript', json: true },
        lineNumbers: true,
        tabSize: 2,
        indentUnit: 2,
        smartIndent: true,
        lineWrapping: false,
        styleActiveLine: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        viewportMargin: 40,
        spellcheck: false
      });

      cm.on('keydown', (_editor, e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault();
          openFindBar(false);
        } else if (e.key === 'Escape' && !$('findBar').hidden) {
          closeFindBar();
        }
      });

      cm.on('change', () => {
        if (!$('findBar').hidden) refreshFind();
      });
    }

    bindEvents();
  }

  function getBodyValue() {
    return cm ? cm.getValue() : $('fBody').value;
  }

  function setBodyValue(val) {
    const text = typeof val === 'string' ? val : '';
    if (cm) {
      cm.setValue(text);
    } else {
      $('fBody').value = text;
    }
  }

  function updateEditorSyntaxMode() {
    if (!cm) return;
    const ct = $('fContentType').value.toLowerCase();
    const isJson = !ct || ct.includes('json');
    cm.setOption('mode', isJson ? { name: 'javascript', json: true } : null);
  }

  function refresh() {
    if (cm) cm.refresh();
  }

  function setMsg(text, kind = '') {
    const el = $('editorMsg');
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function populateScopeSelect(selectedScope) {
    const sel = $('fScope');
    sel.textContent = '';

    const options = [];
    const curOrigin = ctx.getActiveOrigin();
    if (curOrigin) {
      options.push({ value: curOrigin, label: `当前站点 (${curOrigin})` });
    }
    options.push({ value: '*', label: '全局生效 (*)' });

    for (const org of ctx.getKnownOrigins()) {
      if (org !== curOrigin) {
        options.push({ value: org, label: org });
      }
    }
    if (selectedScope && !options.some((o) => o.value === selectedScope)) {
      options.push({ value: selectedScope, label: selectedScope });
    }

    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }

    sel.value = selectedScope || curOrigin || '*';
  }

  function updateCondCount() {
    const rows = $('fCondList').querySelectorAll('.cond-row');
    $('fCondCount').textContent = String(rows.length);
    if (!rows.length) {
      if (!$('fCondList').querySelector('.cond-empty')) {
        const tip = document.createElement('div');
        tip.className = 'cond-empty';
        tip.textContent = '无附加条件：仅按 Method 和 URL 匹配。';
        $('fCondList').appendChild(tip);
      }
    }
  }

  function buildCondRow(cond) {
    const row = document.createElement('div');
    row.className = 'cond-row';

    const selSrc = document.createElement('select');
    selSrc.className = 'c-source';
    for (const s of COND_SOURCES) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = SOURCE_LABELS[s] || s;
      selSrc.appendChild(opt);
    }
    selSrc.value = COND_SOURCES.includes(cond.source) ? cond.source : 'body';

    const inpPath = document.createElement('input');
    inpPath.className = 'c-path mono';
    inpPath.type = 'text';
    inpPath.spellcheck = false;
    inpPath.value = cond.path || '';

    const selOp = document.createElement('select');
    selOp.className = 'c-op';
    for (const op of COND_OPS) {
      const opt = document.createElement('option');
      opt.value = op;
      opt.textContent = OP_LABELS[op] || op;
      selOp.appendChild(opt);
    }
    selOp.value = COND_OPS.includes(cond.op) ? cond.op : 'equals';

    const inpVal = document.createElement('input');
    inpVal.className = 'c-value mono';
    inpVal.type = 'text';
    inpVal.spellcheck = false;
    inpVal.placeholder = '期望值';
    inpVal.value = cond.value || '';

    const del = document.createElement('button');
    del.className = 'c-del';
    del.type = 'button';
    del.textContent = '✕';
    del.title = '删除此条件';

    const syncRow = () => {
      const s = selSrc.value;
      inpPath.placeholder = s === 'query'
        ? '参数名，如 page'
        : (s === 'header' ? '头名，如 x-env' : '字段路径，如 a.b.c 或 $raw');
      const isExists = selOp.value === 'exists';
      inpVal.disabled = isExists;
      if (isExists) inpVal.placeholder = '（存在即命中）';
      else inpVal.placeholder = selOp.value === 'regex' ? '正则表达式' : '期望值';
    };

    selSrc.addEventListener('change', syncRow);
    selOp.addEventListener('change', syncRow);
    syncRow();

    del.addEventListener('click', () => {
      row.remove();
      updateCondCount();
    });

    row.append(selSrc, inpPath, selOp, inpVal, del);
    return row;
  }

  function appendCond(cond) {
    const list = $('fCondList');
    const empty = list.querySelector('.cond-empty');
    if (empty) empty.remove();
    const row = buildCondRow(cond);
    list.appendChild(row);
    updateCondCount();
    return row;
  }

  function renderConditions(conds) {
    const list = $('fCondList');
    list.textContent = '';
    for (const c of Array.isArray(conds) ? conds : []) {
      list.appendChild(buildCondRow(c));
    }
    updateCondCount();
  }

  function readConditions() {
    const rows = $('fCondList').querySelectorAll('.cond-row');
    const out = [];
    for (const r of rows) {
      const source = r.querySelector('.c-source').value;
      const path = r.querySelector('.c-path').value.trim();
      const op = r.querySelector('.c-op').value;
      const value = r.querySelector('.c-value').value;
      if (!path) continue;
      if (op !== 'exists' && value === '') continue;
      out.push({ source, path, op, value });
    }
    return out;
  }

  function updateResHeaderCount() {
    const rows = $('fResHeaderList').querySelectorAll('.cond-row');
    $('fResHeaderCount').textContent = String(rows.length);
  }

  function buildResHeaderRow(h) {
    const row = document.createElement('div');
    row.className = 'cond-row';

    const nameInp = document.createElement('input');
    nameInp.className = 'c-path mono';
    nameInp.type = 'text';
    nameInp.spellcheck = false;
    nameInp.placeholder = '响应头名，如 X-Mock';
    nameInp.value = h.name || '';

    const valInp = document.createElement('input');
    valInp.className = 'c-value mono';
    valInp.type = 'text';
    valInp.spellcheck = false;
    valInp.placeholder = '响应头值';
    valInp.value = h.value || '';

    const del = document.createElement('button');
    del.className = 'c-del';
    del.type = 'button';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      row.remove();
      updateResHeaderCount();
    });

    row.append(nameInp, valInp, del);
    return row;
  }

  function renderResHeaders(headers, autoOpen = false) {
    const list = $('fResHeaderList');
    list.textContent = '';
    const arr = Array.isArray(headers) ? headers : [];
    for (const h of arr) {
      list.appendChild(buildResHeaderRow(h));
    }
    updateResHeaderCount();
    const shouldOpen = autoOpen || arr.length > 0;
    setResHeadersOpen(shouldOpen);
  }

  function setResHeadersOpen(open) {
    $('fResHeaderList').hidden = !open;
    $('btnAddResHeader').hidden = !open;
    const count = $('fResHeaderList').querySelectorAll('.cond-row').length;
    $('btnToggleResHeaders').innerHTML = `${open ? '▾' : '▸'} 自定义响应头 (<b id="fResHeaderCount">${count}</b>)`;
  }

  function readResHeaders() {
    const rows = $('fResHeaderList').querySelectorAll('.cond-row');
    const out = [];
    for (const r of rows) {
      const inputs = r.querySelectorAll('input');
      const name = inputs[0].value.trim();
      const value = inputs[1].value.trim();
      if (!name) continue;
      out.push({ name, value });
    }
    return out;
  }

  function validateUrlInput() {
    const op = $('fUrlOp').value;
    const pat = $('fUrlPattern').value.trim();
    const errEl = $('fUrlErr');
    if (!pat) {
      errEl.textContent = 'URL 匹配串不能为空（为空的规则不会生效）';
      errEl.hidden = false;
      return false;
    }
    if (op === 'regex' && !isValidRegex(pat)) {
      errEl.textContent = '正则表达式语法不合法';
      errEl.hidden = false;
      return false;
    }
    errEl.hidden = true;
    errEl.textContent = '';
    return true;
  }

  function renderCapPicker() {
    const picker = $('editorCapPicker');
    const btn = $('btnToggleCapPicker');
    picker.textContent = '';
    if (!sourceCapture) {
      btn.hidden = true;
      picker.hidden = true;
      return;
    }
    const fields = extractSelectableFields(sourceCapture);
    if (!fields.length) {
      btn.hidden = true;
      picker.hidden = true;
      return;
    }
    btn.hidden = false;
    for (const f of fields) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'pick-chip';
      chip.title = `点击添加到附加条件：${SOURCE_LABELS[f.source]} ${f.path} = ${f.value}`;
      chip.textContent = `[${SOURCE_LABELS[f.source]}] ${f.path} = ${f.value}`;
      chip.addEventListener('click', () => {
        appendCond({ source: f.source, path: f.path, op: 'equals', value: f.value });
      });
      picker.appendChild(chip);
    }
  }

  function fillForm(meta, bodyText) {
    $('editorHeading').textContent = isNewDraft ? '新建规则' : '编辑规则';
    const badge = $('editorBadge');
    if (isNewDraft) {
      badge.className = 'badge';
      badge.textContent = '未保存草稿';
    } else if (meta.enabled !== false) {
      badge.className = 'badge on';
      badge.textContent = '生效中';
    } else {
      badge.className = 'badge';
      badge.textContent = '已停用';
    }

    $('btnDuplicateRule').hidden = isNewDraft;
    $('btnDeleteRule').hidden = isNewDraft;

    $('fName').value = meta.name || '';
    populateScopeSelect(meta.scope);
    $('fEnabled').checked = meta.enabled !== false;
    $('fMethod').value = meta.method || 'ANY';
    $('fUrlOp').value = meta.urlOp || 'contains';
    $('fUrlPattern').value = meta.urlPattern || '';
    $('fStatus').value = String(meta.status || 200);
    $('fDelay').value = String(meta.delayMs || 0);
    $('fContentType').value = meta.contentType || 'application/json;charset=utf-8';

    renderConditions(meta.conditions);
    renderResHeaders(meta.responseHeaders, false);
    renderCapPicker();
    $('editorCapPicker').hidden = true;

    updateEditorSyntaxMode();
    setBodyValue(bodyText);
    if (cm) cm.clearHistory();
    validateUrlInput();
    closeFindBar(false);
    setMsg('');
  }

  async function openExisting(ruleMeta) {
    currentRule = { ...ruleMeta };
    isNewDraft = false;
    sourceCapture = null;
    ctx.showEditorPane();
    fillForm(currentRule, '');
    refresh();
    setMsg('读取响应体…');
    const body = await loadRuleBody(ruleMeta.id);
    if (!currentRule || currentRule.id !== ruleMeta.id) return;
    setBodyValue(body);
    if (cm) cm.clearHistory();
    setMsg('');
    refresh();
  }

  function openNewDraft(initialMeta = {}, initialBody = '{\n  \n}', captureRef = null) {
    const draft = sanitizeRuleMeta({
      id: makeRuleId(),
      name: initialMeta.name || '新 Mock 规则',
      scope: initialMeta.scope || ctx.getPreferredScopeForNew(),
      method: initialMeta.method || 'ANY',
      urlOp: initialMeta.urlOp || 'contains',
      urlPattern: initialMeta.urlPattern || '',
      conditions: initialMeta.conditions || [],
      status: initialMeta.status || 200,
      delayMs: initialMeta.delayMs || 0,
      responseHeaders: initialMeta.responseHeaders || [],
      contentType: initialMeta.contentType || 'application/json;charset=utf-8',
      enabled: initialMeta.enabled !== false
    });
    currentRule = draft;
    isNewDraft = true;
    sourceCapture = captureRef;
    ctx.showEditorPane();
    fillForm(draft, initialBody);
    refresh();
    if (!draft.urlPattern) $('fUrlPattern').focus();
  }

  async function persistRule(forceEnable) {
    if (!currentRule) return;
    if (!validateUrlInput()) {
      setMsg('请先填写合法的 URL 匹配规则', true);
      $('fUrlPattern').focus();
      return;
    }

    const enabled = forceEnable !== undefined ? forceEnable : $('fEnabled').checked;
    $('fEnabled').checked = enabled;

    const status = parseInt($('fStatus').value, 10);
    const delayMs = parseInt($('fDelay').value, 10);
    const contentType = $('fContentType').value.trim() || 'application/json;charset=utf-8';
    const bodyText = getBodyValue();

    const meta = sanitizeRuleMeta({
      id: currentRule.id,
      name: $('fName').value.trim() || $('fUrlPattern').value.trim(),
      scope: $('fScope').value,
      method: $('fMethod').value,
      urlOp: $('fUrlOp').value,
      urlPattern: $('fUrlPattern').value.trim(),
      conditions: readConditions(),
      status: Number.isFinite(status) ? status : 200,
      delayMs: Number.isFinite(delayMs) ? delayMs : 0,
      responseHeaders: readResHeaders(),
      contentType,
      enabled,
      updatedAt: Date.now()
    }, currentRule.id);

    const saved = await saveRule(meta, bodyText, { prepend: true });
    currentRule = saved;
    isNewDraft = false;

    const ctLower = contentType.toLowerCase();
    let jsonWarn = false;
    if (ctLower.includes('json') && bodyText.trim() && !NULL_BODY_STATUSES.has(saved.status)) {
      try { JSON.parse(bodyText); } catch { jsonWarn = true; }
    }

    await ctx.onRuleMutated(saved.id);
    const badge = $('editorBadge');
    badge.className = saved.enabled ? 'badge on' : 'badge';
    badge.textContent = saved.enabled ? '生效中' : '已停用';
    $('editorHeading').textContent = '编辑规则';
    $('btnDuplicateRule').hidden = false;
    $('btnDeleteRule').hidden = false;

    if (jsonWarn) {
      setMsg('已保存（提示：内容不是合法 JSON，将按原文返回）', 'warn');
    } else {
      setMsg(saved.enabled ? '已保存并启用' : '已保存（当前停用）');
    }
  }

  /* ---------- 查找与替换 ---------- */

  function buildFindRe(needle, global) {
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(esc, (global ? 'g' : '') + (findCaseSensitive ? '' : 'i'));
  }

  function findMatches(text, needle) {
    const re = buildFindRe(needle, true);
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  function clearFindMarks() {
    for (const m of findMarks) m.clear();
    findMarks = [];
  }

  function refreshFind() {
    clearFindMarks();
    const needle = $('findText').value;
    if (!needle || $('findBar').hidden || !cm) {
      $('findInfo').textContent = '';
      return;
    }
    const starts = findMatches(cm.getValue(), needle);
    if (!starts.length) {
      $('findInfo').textContent = '未找到';
      return;
    }
    $('findInfo').textContent = `共 ${starts.length} 处`;
    const limit = Math.min(starts.length, FIND_MARK_LIMIT);
    for (let i = 0; i < limit; i++) {
      findMarks.push(cm.markText(
        cm.posFromIndex(starts[i]),
        cm.posFromIndex(starts[i] + needle.length),
        { className: 'cm-find-match' }
      ));
    }
  }

  function setReplaceRow(open) {
    $('replaceRow').hidden = !open;
    $('btnFindToggleReplace').className = 'find-toggle' + (open ? ' open' : '');
  }

  function openFindBar(expandReplace) {
    const wasOpen = !$('findBar').hidden;
    $('findBar').hidden = false;
    if (!wasOpen) setReplaceRow(Boolean(expandReplace));
    const input = $('findText');
    input.focus();
    if (input.value) input.select();
    refreshFind();
  }

  function closeFindBar(refocus = true) {
    $('findBar').hidden = true;
    setReplaceRow(false);
    clearFindMarks();
    $('findInfo').textContent = '';
    if (refocus && cm) cm.focus();
  }

  function findStep(dir) {
    if (!cm) return false;
    const needle = $('findText').value;
    if (!needle) { refreshFind(); return false; }
    const starts = findMatches(cm.getValue(), needle);
    if (!starts.length) {
      $('findInfo').textContent = '未找到';
      return false;
    }
    const selStart = cm.indexFromPos(cm.getCursor('from'));
    const selEnd = cm.indexFromPos(cm.getCursor('to'));
    let target = -1;
    if (dir > 0) {
      for (let i = 0; i < starts.length; i++) {
        if (starts[i] >= selEnd) { target = i; break; }
      }
      if (target === -1) target = 0;
    } else {
      for (let i = starts.length - 1; i >= 0; i--) {
        if (starts[i] + needle.length <= selStart) { target = i; break; }
      }
      if (target === -1) target = starts.length - 1;
    }
    const s = starts[target];
    cm.setSelection(cm.posFromIndex(s), cm.posFromIndex(s + needle.length), { scroll: true });
    $('findInfo').textContent = `${target + 1} / ${starts.length}`;
    return true;
  }

  function replaceOne() {
    if (!cm) return;
    const needle = $('findText').value;
    if (!needle) return;
    const sel = cm.getSelection();
    const isMatch = sel.length === needle.length &&
      (findCaseSensitive ? sel === needle : sel.toLowerCase() === needle.toLowerCase());
    if (!isMatch && !findStep(1)) return;

    const rep = $('replaceText').value;
    const s = cm.indexFromPos(cm.getCursor('from'));
    const e = cm.indexFromPos(cm.getCursor('to'));
    cm.replaceRange(rep, cm.posFromIndex(s), cm.posFromIndex(e), '+find-replace');
    cm.setSelection(cm.posFromIndex(s + rep.length), cm.posFromIndex(s + rep.length));
    if (findMatches(cm.getValue(), needle).length) findStep(1);
    else $('findInfo').textContent = '未找到';
  }

  function replaceAll() {
    if (!cm) return;
    const needle = $('findText').value;
    if (!needle) return;
    const rep = $('replaceText').value;
    const text = cm.getValue();
    let count = 0;
    const out = text.replace(buildFindRe(needle, true), () => { count++; return rep; });
    if (!count) { setMsg('没有可替换的匹配', 'err'); return; }
    cm.replaceRange(out, cm.posFromIndex(0), cm.posFromIndex(text.length), '+find-replace-all');
    setMsg(`已替换 ${count} 处`);
    refreshFind();
  }

  function bindEvents() {
    $('btnBackFromEditor').addEventListener('click', () => ctx.exitDetailPane());

    $('fUrlOp').addEventListener('change', validateUrlInput);
    $('fUrlPattern').addEventListener('input', validateUrlInput);
    $('fContentType').addEventListener('input', updateEditorSyntaxMode);

    $('btnAddCond').addEventListener('click', () => {
      const row = appendCond({ source: 'body', path: '', op: 'equals', value: '' });
      row.querySelector('.c-path').focus();
    });

    $('btnToggleCapPicker').addEventListener('click', () => {
      $('editorCapPicker').hidden = !$('editorCapPicker').hidden;
    });

    $('btnToggleResHeaders').addEventListener('click', () => {
      setResHeadersOpen($('fResHeaderList').hidden);
    });

    $('btnAddResHeader').addEventListener('click', () => {
      setResHeadersOpen(true);
      const row = buildResHeaderRow({ name: '', value: '' });
      $('fResHeaderList').appendChild(row);
      updateResHeaderCount();
      row.querySelector('input').focus();
    });

    $('btnFormatJson').addEventListener('click', () => {
      try {
        const parsed = JSON.parse(getBodyValue());
        setBodyValue(JSON.stringify(parsed, null, 2));
        setMsg('已格式化 JSON');
      } catch (err) {
        setMsg(`JSON 解析失败：${err.message}`, 'err');
      }
    });

    $('btnCopyBody').addEventListener('click', () => {
      const v = getBodyValue();
      if (!v || !navigator.clipboard) return;
      navigator.clipboard.writeText(v).then(
        () => setMsg('已复制到剪贴板'),
        () => setMsg('复制失败', 'err')
      );
    });

    $('btnSaveEnable').addEventListener('click', () => persistRule(true));
    $('btnSaveDraft').addEventListener('click', () => persistRule());

    $('btnDuplicateRule').addEventListener('click', async () => {
      if (!currentRule || isNewDraft) return;
      const copy = await duplicateRule(currentRule.id);
      if (!copy) return;
      await ctx.onRuleMutated(copy.id);
      openExisting(copy);
      setMsg('已复制为停用副本');
    });

    $('btnDeleteRule').addEventListener('click', async () => {
      if (!currentRule || isNewDraft) return;
      const id = currentRule.id;
      await deleteRule(id);
      currentRule = null;
      await ctx.onRuleMutated(null);
      ctx.exitDetailPane();
    });

    $('btnFindToggle').addEventListener('click', () => {
      if ($('findBar').hidden) openFindBar(true); else closeFindBar();
    });
    $('btnFindClose').addEventListener('click', () => closeFindBar());
    $('btnFindToggleReplace').addEventListener('click', () => {
      setReplaceRow($('replaceRow').hidden);
    });
    $('btnFindCase').addEventListener('click', () => {
      findCaseSensitive = !findCaseSensitive;
      $('btnFindCase').className = findCaseSensitive ? 'on' : '';
      refreshFind();
    });
    $('btnFindNext').addEventListener('click', () => findStep(1));
    $('btnFindPrev').addEventListener('click', () => findStep(-1));
    $('btnReplaceOne').addEventListener('click', replaceOne);
    $('btnReplaceAll').addEventListener('click', replaceAll);
    $('findText').addEventListener('input', refreshFind);
    $('findText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') closeFindBar();
    });
    $('replaceText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
      else if (e.key === 'Escape') closeFindBar();
    });
  }

  return {
    init,
    openExisting,
    openNewDraft,
    refresh,
    clearCurrent() {
      currentRule = null;
      isNewDraft = false;
      sourceCapture = null;
    },
    getCurrentRuleId: () => (currentRule && !isNewDraft ? currentRule.id : null)
  };
}
