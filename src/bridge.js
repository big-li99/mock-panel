/* MockPanel —— 隔离世界内容脚本（桥接层）
 *
 * 职责：
 *   1. 从 chrome.storage.local 读取当前 origin 与全局（*）的有效启用规则（保持 ruleIds 顺序），
 *      通过 window.postMessage 下发给页面世界（inject.js）；
 *   2. 接收页面世界上报的抓包事件（仅 captureOn 为真时转发给 background.js）；
 *   3. 监听 background.js 下发的 setCapture 开关，及时通知页面世界开启或停止抓包。
 */
(function () {
  'use strict';

  const CH_PAGE = 'mock-panel:page';
  const CH_EXT = 'mock-panel:ext';

  const K_ENABLED = 'mockPanel.enabled';
  const K_RULE_IDS = 'mockPanel.ruleIds';
  const P_RULE = 'rule:';
  const P_RULE_BODY = 'rulebody:';

  let enabled = true;
  let activeRules = [];
  let captureOn = false;
  let lastPushSig = '';
  let helloAnswered = false;

  function pageOrigin() {
    try {
      const o = typeof location !== 'undefined' && location && location.origin;
      return o && o !== 'null' ? o : '';
    } catch {
      return '';
    }
  }

  function isValidRegex(pat) {
    if (typeof pat !== 'string' || !pat) return false;
    try {
      new RegExp(pat);
      return true;
    } catch {
      return false;
    }
  }

  function isRuleRunnable(meta) {
    if (!meta || typeof meta !== 'object' || meta.enabled === false) return false;
    const pat = typeof meta.urlPattern === 'string' ? meta.urlPattern.trim() : '';
    if (!pat) return false;
    if (meta.urlOp === 'regex' && !isValidRegex(pat)) return false;
    return true;
  }

  function ruleMatchesOrigin(meta, origin) {
    if (!meta) return false;
    if (meta.scope === '*') return true;
    return Boolean(origin && meta.scope === origin);
  }

  function hashStr(s) {
    let h = 5381;
    let i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36);
  }

  function condSig(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return list.map((c) => `${c.source}=${c.path}:${c.op}:${c.value}`).join('\u0004');
  }

  function headersSig(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return list.map((h) => `${h.name}:${h.value}`).join('\u0005');
  }

  function computeSig() {
    const ruleParts = activeRules.map((r) => [
      r.id,
      r.name,
      r.method,
      r.urlOp,
      r.urlPattern,
      condSig(r.conditions),
      r.status,
      r.delayMs,
      headersSig(r.responseHeaders),
      r.contentType,
      r.body.length,
      hashStr(r.body)
    ].join('\u0002'));
    return `${enabled}|${captureOn}|${ruleParts.join('\u0003')}`;
  }

  function toPage(msg) {
    try {
      msg.__ch = CH_EXT;
      window.postMessage(msg, '*');
    } catch { /* ignore */ }
  }

  function pushSync(force) {
    const sig = computeSig();
    if (!force && sig === lastPushSig) return;
    lastPushSig = sig;
    toPage({
      type: 'sync',
      payload: {
        enabled,
        rules: activeRules,
        captureOn
      }
    });
  }

  function safeSendMessage(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        if (cb) cb(res);
      });
    } catch { /* ignore */ }
  }

  function loadActiveRules(cb) {
    const origin = pageOrigin();
    chrome.storage.local.get([K_ENABLED, K_RULE_IDS], (res) => {
      if (chrome.runtime && chrome.runtime.lastError) return;
      const data = res || {};
      enabled = data[K_ENABLED] !== false;
      const rawIds = Array.isArray(data[K_RULE_IDS]) ? data[K_RULE_IDS] : [];

      const uniqueIds = [];
      const seen = new Set();
      for (let i = 0; i < rawIds.length; i++) {
        const id = String(rawIds[i] == null ? '' : rawIds[i]).trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        uniqueIds.push(id);
      }

      if (!uniqueIds.length) {
        activeRules = [];
        cb && cb();
        return;
      }

      const metaKeys = uniqueIds.map((id) => P_RULE + id);
      chrome.storage.local.get(metaKeys, (metaMap) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        const metas = [];
        for (let i = 0; i < uniqueIds.length; i++) {
          const id = uniqueIds[i];
          const meta = metaMap && metaMap[P_RULE + id];
          if (isRuleRunnable(meta) && ruleMatchesOrigin(meta, origin)) {
            metas.push({ id, meta });
          }
        }

        if (!metas.length) {
          activeRules = [];
          cb && cb();
          return;
        }

        const bodyKeys = metas.map((item) => P_RULE_BODY + item.id);
        chrome.storage.local.get(bodyKeys, (bodyMap) => {
          if (chrome.runtime && chrome.runtime.lastError) return;
          const out = [];
          for (let i = 0; i < metas.length; i++) {
            const { id, meta } = metas[i];
            const rawBody = bodyMap && bodyMap[P_RULE_BODY + id];
            const body = typeof rawBody === 'string' ? rawBody : '';
            out.push({
              id,
              name: String(meta.name == null ? '' : meta.name),
              method: String(meta.method || 'ANY').toUpperCase(),
              urlOp: meta.urlOp || 'contains',
              urlPattern: String(meta.urlPattern).trim(),
              conditions: Array.isArray(meta.conditions) ? meta.conditions : [],
              status: Number.isFinite(Number(meta.status)) ? Number(meta.status) : 200,
              delayMs: Number.isFinite(Number(meta.delayMs)) ? Number(meta.delayMs) : 0,
              responseHeaders: Array.isArray(meta.responseHeaders) ? meta.responseHeaders : [],
              contentType: String(meta.contentType || 'application/json;charset=utf-8'),
              body
            });
          }
          activeRules = out;
          cb && cb();
        });
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 监听页面消息与扩展事件
   * ------------------------------------------------------------------ */

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ch !== CH_PAGE) return;

    if (d.type === 'hello') {
      pushSync(!helloAnswered);
      helloAnswered = true;
      return;
    }

    if (d.type === 'captured') {
      if (!captureOn || !d.entry) return;
      safeSendMessage({ type: 'captured', entry: d.entry });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes) return;
    let relevant = false;
    const keys = Object.keys(changes);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === K_ENABLED || k === K_RULE_IDS ||
          k.startsWith(P_RULE_BODY) || k.startsWith(P_RULE)) {
        relevant = true;
        break;
      }
    }
    if (!relevant) return;
    loadActiveRules(() => pushSync(false));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'setCapture') return;
    captureOn = Boolean(msg.enabled);
    pushSync(false);
    if (sendResponse) sendResponse({ ok: true });
  });

  /* ------------------------------------------------------------------ *
   * 初始化：查询抓包态 + 加载当前站点生效规则
   * ------------------------------------------------------------------ */

  safeSendMessage({ type: 'getCaptureState' }, (res) => {
    if (res && typeof res.captureOn === 'boolean' && res.captureOn !== captureOn) {
      captureOn = res.captureOn;
      pushSync(false);
    }
  });

  loadActiveRules(() => {
    pushSync(true);
  });
})();
