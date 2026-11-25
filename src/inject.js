/* MockPanel —— 页面世界（MAIN world）注入脚本
 *
 * 职责：
 *   1. 按 bridge 下发的有序规则拦截 XHR / fetch，命中第一条满足条件的规则后返回 Mock 响应；
 *   2. 响应模拟采用混合策略：
 *      - fetch 统一用原生 Response 构造（支持任意状态码、响应头与延迟）；
 *      - XHR 在 200 且无自定义响应头时用 blob: URL 原生回放；
 *      - XHR 在非 200 状态码或存在自定义响应头时，切换为实例属性覆写并派发原生状态事件；
 *   3. 侧边栏开启抓包时（captureOn = true）上报请求/响应详情；
 *      未开启抓包且当前站点无生效规则时极速透传，不解析请求体、不克隆响应、不发 postMessage。
 */
(function () {
  'use strict';

  if (window.__mockPanelInstalled) return;
  window.__mockPanelInstalled = true;

  const CH_PAGE = 'mock-panel:page';
  const CH_EXT = 'mock-panel:ext';
  const MAX_BODY_CHARS = 2 * 1024 * 1024;
  const RULES_WAIT_MS = 800;

  const NULL_BODY_STATUSES = { 204: 1, 205: 1, 304: 1 };
  const STATUS_TEXT = {
    100: 'Continue',
    101: 'Switching Protocols',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    206: 'Partial Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Content',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  };

  let state = { enabled: true, rules: [], captureOn: false };
  let rulesLoaded = false;
  let waiters = [];
  let waitTimer = null;
  let captureSeq = 0;
  const stats = { matched: 0, mocked: 0, captured: 0 };

  /* ------------------------------------------------------------------ *
   * 与隔离世界通信
   * ------------------------------------------------------------------ */

  function post(msg) {
    try {
      msg.__ch = CH_PAGE;
      window.postMessage(msg, '*');
    } catch { /* ignore */ }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ch !== CH_EXT || d.type !== 'sync') return;
    applySync(d.payload || {});
  });

  function normalizeRules(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r !== 'object') continue;
      const urlPattern = String(r.urlPattern == null ? '' : r.urlPattern).trim();
      if (!urlPattern) continue;
      const urlOp = r.urlOp || 'contains';
      if (urlOp === 'regex') {
        try { new RegExp(urlPattern); } catch { continue; }
      }
      const st = parseInt(r.status, 10);
      const status = Number.isFinite(st) && st >= 100 && st <= 599 ? st : 200;
      const dl = parseInt(r.delayMs, 10);
      const delayMs = Number.isFinite(dl) && dl >= 0 ? Math.min(60000, dl) : 0;

      out.push({
        id: String(r.id == null ? '' : r.id),
        name: String(r.name == null ? '' : r.name),
        method: String(r.method || 'ANY').toUpperCase(),
        urlOp,
        urlPattern,
        conditions: Array.isArray(r.conditions) ? r.conditions : [],
        status,
        delayMs,
        responseHeaders: Array.isArray(r.responseHeaders) ? r.responseHeaders : [],
        contentType: String(r.contentType || 'application/json;charset=utf-8'),
        body: typeof r.body === 'string' ? r.body : ''
      });
    }
    return out;
  }

  function applySync(payload) {
    state = {
      enabled: payload.enabled !== false,
      rules: normalizeRules(payload.rules),
      captureOn: Boolean(payload.captureOn)
    };
    rulesLoaded = true;
    flushWaiters();
  }

  function flushWaiters() {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
    const list = waiters;
    waiters = [];
    for (let i = 0; i < list.length; i++) {
      try { list[i](); } catch { /* ignore */ }
    }
  }

  function whenReady(cb) {
    if (rulesLoaded) { cb(); return; }
    waiters.push(cb);
    if (!waitTimer) waitTimer = setTimeout(flushWaiters, RULES_WAIT_MS);
  }

  function shouldIntercept() {
    if (!rulesLoaded) return true;
    return (state.enabled && state.rules.length > 0) || state.captureOn;
  }

  (function hello(tries) {
    if (rulesLoaded || tries > 50) return;
    post({ type: 'hello' });
    setTimeout(() => { hello(tries + 1); }, 80);
  })(0);

  /* ------------------------------------------------------------------ *
   * URL 归一化与匹配引擎
   * ------------------------------------------------------------------ */

  function absoluteUrl(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s) return s;
    try {
      const base = (typeof document !== 'undefined' && document && document.baseURI) ||
        (typeof location !== 'undefined' && location && location.href) || '';
      if (base) return new URL(s, base).href;
    } catch { /* ignore */ }
    return s;
  }

  function parseUrlParts(fullUrl) {
    try {
      const base = (typeof location !== 'undefined' && location && location.href) || 'http://localhost';
      const u = new URL(fullUrl, base);
      return {
        href: u.href,
        origin: u.origin === 'null' ? '' : u.origin,
        originPath: (u.origin === 'null' ? '' : u.origin) + u.pathname,
        pathname: u.pathname,
        pathSearch: u.pathname + u.search,
        searchParams: u.searchParams
      };
    } catch {
      const q = fullUrl.indexOf('?');
      const path = q === -1 ? fullUrl : fullUrl.slice(0, q);
      const search = q === -1 ? '' : fullUrl.slice(q);
      return {
        href: fullUrl,
        origin: '',
        originPath: path,
        pathname: path,
        pathSearch: fullUrl,
        searchParams: new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      };
    }
  }

  function matchUrl(urlOp, pattern, fullUrl) {
    const pat = String(pattern == null ? '' : pattern).trim();
    if (!pat) return false;

    const op = urlOp || 'contains';
    if (op === 'contains') return fullUrl.indexOf(pat) !== -1;

    if (op === 'regex') {
      try {
        return new RegExp(pat).test(fullUrl);
      } catch {
        return false;
      }
    }

    const parts = parseUrlParts(fullUrl);
    const hasScheme = /^https?:\/\//i.test(pat);
    const hasQuery = pat.indexOf('?') !== -1;

    if (op === 'equals') {
      if (hasScheme) {
        return hasQuery ? parts.href === pat : (parts.href === pat || parts.originPath === pat);
      }
      return hasQuery ? parts.pathSearch === pat : parts.pathname === pat;
    }

    if (op === 'wildcard') {
      const reStr = '^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      const re = new RegExp(reStr);
      if (hasScheme) {
        return hasQuery ? re.test(parts.href) : (re.test(parts.href) || re.test(parts.originPath));
      }
      return hasQuery ? re.test(parts.pathSearch) : re.test(parts.pathname);
    }

    return false;
  }

  function matchOp(op, actual, expect) {
    const a = String(actual == null ? '' : actual);
    const e = String(expect == null ? '' : expect);
    if (op === 'equals') return a === e;
    if (op === 'notEquals') return a !== e;
    if (op === 'contains') return a.indexOf(e) !== -1;
    if (op === 'exists') return a !== '';
    if (op === 'regex') {
      try { return new RegExp(e).test(a); } catch { return false; }
    }
    return false;
  }

  function getByPath(obj, path) {
    if (!obj || !path) return undefined;
    const parts = String(path).split('.');
    let node = obj;
    for (let i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  function parseBodyForMatch(bodyText, contentType) {
    if (typeof bodyText !== 'string' || !bodyText || bodyText.length > MAX_BODY_CHARS) {
      return { bodyJson: null, bodyForm: null, bodyRaw: null };
    }
    let bodyJson = null;
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === 'object') bodyJson = parsed;
    } catch { /* ignore */ }

    let bodyForm = null;
    if (!bodyJson) {
      const ct = String(contentType || '').toLowerCase();
      const trimmed = bodyText.trim();
      const looksForm = ct.indexOf('x-www-form-urlencoded') !== -1 ||
        (trimmed && trimmed[0] !== '{' && trimmed[0] !== '[' && trimmed[0] !== '<' && trimmed.indexOf('=') !== -1);
      if (looksForm) {
        try { bodyForm = new URLSearchParams(trimmed); } catch { /* ignore */ }
      }
    }
    return { bodyJson, bodyForm, bodyRaw: bodyText };
  }

  function normalizeHeaderMap(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    const keys = Object.keys(headers);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      out[String(k).toLowerCase()] = String(headers[k]);
    }
    return out;
  }

  function matchCond(cond, ctx) {
    if (!cond || !cond.path) return false;
    let actual;
    if (cond.source === 'query') {
      if (!ctx.searchParams || !ctx.searchParams.has(cond.path)) return false;
      actual = ctx.searchParams.get(cond.path);
    } else if (cond.source === 'header') {
      const name = String(cond.path).toLowerCase();
      if (!ctx.headers || ctx.headers[name] == null) return false;
      actual = String(ctx.headers[name]);
    } else if (cond.source === 'body') {
      if (cond.path === '$raw') {
        if (typeof ctx.bodyRaw !== 'string') return false;
        actual = ctx.bodyRaw;
      } else if (ctx.bodyJson && typeof ctx.bodyJson === 'object') {
        const v = getByPath(ctx.bodyJson, cond.path);
        if (v == null) return false;
        actual = typeof v === 'string' ? v : String(v);
      } else if (ctx.bodyForm) {
        if (!ctx.bodyForm.has(cond.path)) return false;
        actual = ctx.bodyForm.get(cond.path);
      } else {
        return false;
      }
    } else {
      return false;
    }
    return matchOp(cond.op, actual, cond.value);
  }

  function matchRule(rule, ctx) {
    if (!rule || !rule.urlPattern || !String(rule.urlPattern).trim()) return false;
    const rm = String(rule.method || 'ANY').toUpperCase();
    if (rm !== 'ANY' && rm !== ctx.method) return false;
    if (!matchUrl(rule.urlOp, rule.urlPattern, ctx.url)) return false;
    const conds = rule.conditions;
    if (Array.isArray(conds) && conds.length) {
      for (let i = 0; i < conds.length; i++) {
        if (!matchCond(conds[i], ctx)) return false;
      }
    }
    return true;
  }

  function buildContext(method, url, headers, bodyText) {
    const absUrl = absoluteUrl(url);
    const parts = parseUrlParts(absUrl);
    const normHeaders = normalizeHeaderMap(headers);
    const parsed = parseBodyForMatch(bodyText, normHeaders['content-type']);
    return {
      method: String(method || 'GET').toUpperCase(),
      url: absUrl,
      searchParams: parts.searchParams,
      headers: normHeaders,
      bodyJson: parsed.bodyJson,
      bodyForm: parsed.bodyForm,
      bodyRaw: parsed.bodyRaw
    };
  }

  function resolveMock(method, url, headers, bodyText) {
    if (!state.enabled || !state.rules.length) return null;
    const ctx = buildContext(method, url, headers, bodyText);
    for (let i = 0; i < state.rules.length; i++) {
      if (matchRule(state.rules[i], ctx)) return state.rules[i];
    }
    return null;
  }

  function rulesNeedBody() {
    if (!state.enabled || !state.rules.length) return false;
    for (let i = 0; i < state.rules.length; i++) {
      const conds = state.rules[i].conditions || [];
      for (let j = 0; j < conds.length; j++) {
        if (conds[j] && conds[j].source === 'body') return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 抓包上报（仅 captureOn 时触发）
   * ------------------------------------------------------------------ */

  function truncateStr(text) {
    if (typeof text !== 'string') return '';
    return text.length <= MAX_BODY_CHARS ? text : text.slice(0, MAX_BODY_CHARS);
  }

  function parseRawHeaders(raw) {
    const out = {};
    if (typeof raw !== 'string' || !raw) return out;
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      out[name] = out[name] ? (out[name] + ', ' + val) : val;
    }
    return out;
  }

  function headerListToMap(list) {
    const out = {};
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (!h || !h.name) continue;
      const k = String(h.name).toLowerCase();
      const v = String(h.value == null ? '' : h.value);
      out[k] = out[k] ? (out[k] + ', ' + v) : v;
    }
    return out;
  }

  function reportCapture(info, status, resHeaders, resBody, mockRule, startedAt) {
    if (!state.captureOn) return;
    stats.captured++;
    const bodyStr = truncateStr(typeof resBody === 'string' ? resBody : '');
    const parts = parseUrlParts(info.url);
    post({
      type: 'captured',
      entry: {
        id: 'c_' + Date.now().toString(36) + '_' + (++captureSeq),
        origin: parts.origin,
        url: info.url,
        path: parts.pathSearch,
        method: info.method,
        status: Number(status) || 0,
        durationMs: Math.max(0, Date.now() - startedAt),
        size: bodyStr.length,
        reqHeaders: info.headers || {},
        reqBody: truncateStr(info.reqBodyText),
        resHeaders: resHeaders || {},
        resBody: bodyStr,
        mocked: Boolean(mockRule),
        matchedRuleId: mockRule ? mockRule.id : '',
        matchedRuleName: mockRule ? mockRule.name : '',
        ts: Date.now()
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 响应头组装与 XHR 混合回放
   * ------------------------------------------------------------------ */

  function buildFinalHeaders(rule) {
    const list = [];
    let hasContentType = false;
    const custom = Array.isArray(rule.responseHeaders) ? rule.responseHeaders : [];
    for (let i = 0; i < custom.length; i++) {
      const h = custom[i];
      if (!h || !h.name) continue;
      const name = String(h.name).trim();
      const value = String(h.value == null ? '' : h.value);
      if (name.toLowerCase() === 'content-type') hasContentType = true;
      list.push({ name, value });
    }
    if (!hasContentType && !NULL_BODY_STATUSES[rule.status]) {
      list.push({ name: 'content-type', value: rule.contentType || 'application/json;charset=utf-8' });
    }
    return list;
  }

  function contentTypeFromList(list, fallback) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].name.toLowerCase() === 'content-type') return list[i].value;
    }
    return fallback;
  }

  function buildTypedResponse(xhr, bodyStr, ct) {
    const rt = xhr.responseType || '';
    if (rt === '' || rt === 'text') return bodyStr;
    if (rt === 'json') {
      try { return JSON.parse(bodyStr); } catch { return null; }
    }
    if (rt === 'blob') {
      return typeof Blob === 'function' ? new Blob([bodyStr], { type: ct }) : bodyStr;
    }
    if (rt === 'arraybuffer') {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(bodyStr).buffer;
      return bodyStr;
    }
    return bodyStr;
  }

  function dispatchXhrEvent(xhr, type) {
    let evt;
    try {
      evt = typeof Event === 'function' ? new Event(type) : { type };
    } catch {
      evt = { type };
    }
    if (typeof xhr.dispatchEvent === 'function') {
      try {
        xhr.dispatchEvent(evt);
        return;
      } catch { /* fallback below */ }
    }
    const handler = xhr['on' + type];
    if (typeof handler === 'function') {
      try { handler.call(xhr, evt); } catch { /* ignore */ }
    }
  }

  function attachOverrideProps(xhr, stateBox) {
    const define = (prop, getter) => {
      try {
        Object.defineProperty(xhr, prop, { configurable: true, get: getter });
      } catch { /* ignore */ }
    };
    define('readyState', () => stateBox.readyState);
    define('status', () => stateBox.status);
    define('statusText', () => stateBox.statusText);
    define('response', () => stateBox.response);
    define('responseText', () => stateBox.responseText);
    define('responseURL', () => stateBox.responseURL);

    xhr.getResponseHeader = function (name) {
      if (stateBox.readyState < 2 || !name) return null;
      const target = String(name).toLowerCase();
      const matched = [];
      for (let i = 0; i < stateBox.headersList.length; i++) {
        if (stateBox.headersList[i].name.toLowerCase() === target) {
          matched.push(stateBox.headersList[i].value);
        }
      }
      return matched.length ? matched.join(', ') : null;
    };

    xhr.getAllResponseHeaders = function () {
      if (stateBox.readyState < 2 || !stateBox.headersList.length) return '';
      let out = '';
      for (let i = 0; i < stateBox.headersList.length; i++) {
        out += stateBox.headersList[i].name.toLowerCase() + ': ' + stateBox.headersList[i].value + '\r\n';
      }
      return out;
    };
  }

  function extractReqBodyText(body) {
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams === 'function' && body instanceof URLSearchParams) {
      return body.toString();
    }
    return null;
  }

  const XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (!XHRProto) return;

  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const origSetRequestHeader = XHRProto.setRequestHeader;
  const origAbort = XHRProto.abort;

  XHRProto.open = function (method, url, asyncFlag) {
    try {
      this.__mockPanelReq = {
        method: String(method == null ? 'GET' : method).toUpperCase(),
        url: absoluteUrl(url),
        async: arguments.length >= 3 ? asyncFlag !== false : true,
        headers: {},
        aborted: false,
        pendingMock: false,
        mockDone: false,
        timer: null
      };
    } catch { /* ignore */ }
    return origOpen.apply(this, arguments);
  };

  XHRProto.setRequestHeader = function (name, value) {
    try {
      const req = this.__mockPanelReq;
      if (req && name) {
        const k = String(name).toLowerCase();
        const v = String(value == null ? '' : value);
        req.headers[k] = req.headers[k] ? (req.headers[k] + ', ' + v) : v;
      }
    } catch { /* ignore */ }
    return origSetRequestHeader.apply(this, arguments);
  };

  XHRProto.abort = function () {
    const req = this.__mockPanelReq;
    if (req) {
      req.aborted = true;
      if (req.timer) {
        clearTimeout(req.timer);
        req.timer = null;
      }
      if (req.pendingMock && !req.mockDone) {
        req.pendingMock = false;
        const box = {
          readyState: 4,
          status: 0,
          statusText: '',
          response: '',
          responseText: '',
          responseURL: req.url,
          headersList: []
        };
        attachOverrideProps(this, box);
        dispatchXhrEvent(this, 'readystatechange');
        dispatchXhrEvent(this, 'abort');
        dispatchXhrEvent(this, 'loadend');
        return;
      }
    }
    if (typeof origAbort === 'function') return origAbort.apply(this, arguments);
  };

  XHRProto.send = function (body) {
    const req = this.__mockPanelReq;
    if (!req || !shouldIntercept()) {
      return origSend.apply(this, arguments);
    }
    const xhr = this;
    const startedAt = Date.now();
    stats.matched++;
    whenReady(() => {
      if (req.aborted) return;
      handleXhrSend(xhr, req, body, startedAt);
    });
  };

  function handleXhrSend(xhr, req, body, startedAt) {
    const reqBodyText = extractReqBodyText(body);
    const info = { method: req.method, url: req.url, headers: req.headers, reqBodyText };
    const hitRule = resolveMock(req.method, req.url, req.headers, reqBodyText);

    if (hitRule) {
      stats.mocked++;
      serveXhrMock(xhr, req, info, hitRule, startedAt);
      return;
    }

    if (state.captureOn) {
      try {
        xhr.addEventListener('loadend', () => {
          let text = '';
          try {
            if (xhr.responseType === '' || xhr.responseType === 'text') {
              text = xhr.responseText || '';
            } else if (xhr.responseType === 'json' && xhr.response != null) {
              text = JSON.stringify(xhr.response);
            } else if (typeof xhr.response === 'string') {
              text = xhr.response;
            }
          } catch { /* ignore */ }
          let rawHeaders = '';
          try { rawHeaders = xhr.getAllResponseHeaders() || ''; } catch { /* ignore */ }
          reportCapture(info, xhr.status, parseRawHeaders(rawHeaders), text, null, startedAt);
        });
      } catch { /* ignore */ }
    }

    return origSend.call(xhr, body);
  }

  function serveXhrMock(xhr, req, info, rule, startedAt) {
    const status = rule.status || 200;
    const customHeaders = Array.isArray(rule.responseHeaders) ? rule.responseHeaders : [];
    const bodyStr = NULL_BODY_STATUSES[status] ? '' : String(rule.body || '');
    const delayMs = Math.max(0, rule.delayMs || 0);
    const canUseBlob = status === 200 &&
      customHeaders.length === 0 &&
      xhr.responseType !== 'document' &&
      typeof Blob === 'function' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function';

    if (canUseBlob) {
      const mime = rule.contentType || 'application/json;charset=utf-8';
      const sendBlob = () => {
        if (req.aborted) return;
        req.pendingMock = false;
        req.timer = null;
        let blobUrl = null;
        try {
          blobUrl = URL.createObjectURL(new Blob([bodyStr], { type: mime }));
        } catch {
          serveXhrOverride(xhr, req, info, rule, startedAt);
          return;
        }
        const revoke = () => {
          try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
        };
        try {
          xhr.addEventListener('loadend', revoke, { once: true });
          origOpen.call(xhr, 'GET', blobUrl, req.async);
          req.mockDone = true;
          reportCapture(info, 200, { 'content-type': mime }, bodyStr, rule, startedAt);
          origSend.call(xhr, null);
        } catch {
          revoke();
          serveXhrOverride(xhr, req, info, rule, startedAt);
        }
      };

      if (delayMs > 0 && req.async) {
        req.pendingMock = true;
        req.timer = setTimeout(sendBlob, delayMs);
      } else {
        sendBlob();
      }
      return;
    }

    serveXhrOverride(xhr, req, info, rule, startedAt);
  }

  function serveXhrOverride(xhr, req, info, rule, startedAt) {
    const status = rule.status || 200;
    const statusText = STATUS_TEXT[status] || '';
    const bodyStr = NULL_BODY_STATUSES[status] ? '' : String(rule.body || '');
    const headersList = buildFinalHeaders(rule);
    const ct = contentTypeFromList(headersList, rule.contentType || 'application/json;charset=utf-8');
    const delayMs = Math.max(0, rule.delayMs || 0);

    const stateBox = {
      readyState: xhr.readyState || 1,
      status: 0,
      statusText: '',
      response: '',
      responseText: '',
      responseURL: req.url,
      headersList
    };
    attachOverrideProps(xhr, stateBox);

    const deliver = () => {
      if (req.aborted) return;
      req.pendingMock = false;
      req.mockDone = true;
      req.timer = null;

      stateBox.status = status;
      stateBox.statusText = statusText;
      stateBox.readyState = 2;
      dispatchXhrEvent(xhr, 'readystatechange');
      if (req.aborted) return;

      const typed = buildTypedResponse(xhr, bodyStr, ct);
      const textAllowed = !xhr.responseType || xhr.responseType === 'text';
      stateBox.readyState = 3;
      stateBox.response = typed;
      stateBox.responseText = textAllowed ? bodyStr : '';
      dispatchXhrEvent(xhr, 'readystatechange');
      dispatchXhrEvent(xhr, 'progress');
      if (req.aborted) return;

      stateBox.readyState = 4;
      reportCapture(info, status, headerListToMap(headersList), bodyStr, rule, startedAt);
      dispatchXhrEvent(xhr, 'readystatechange');
      dispatchXhrEvent(xhr, 'load');
      dispatchXhrEvent(xhr, 'loadend');
    };

    if (!req.async && delayMs === 0) {
      deliver();
    } else {
      req.pendingMock = true;
      req.timer = setTimeout(deliver, delayMs);
    }
  }

  /* ------------------------------------------------------------------ *
   * fetch 拦截
   * ------------------------------------------------------------------ */

  function headersFrom(init, input) {
    const out = {};
    const collect = (h) => {
      if (!h) return;
      try {
        if (typeof h.forEach === 'function' && typeof h.get === 'function') {
          h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
        } else if (Array.isArray(h)) {
          for (let i = 0; i < h.length; i++) {
            out[String(h[i][0]).toLowerCase()] = String(h[i][1]);
          }
        } else if (typeof h === 'object') {
          const keys = Object.keys(h);
          for (let i = 0; i < keys.length; i++) {
            out[String(keys[i]).toLowerCase()] = String(h[keys[i]]);
          }
        }
      } catch { /* ignore */ }
    };
    if (input && typeof input !== 'string' && input.headers) collect(input.headers);
    if (init && init.headers) collect(init.headers);
    return out;
  }

  function fetchResponseHeaders(list) {
    if (typeof Headers === 'function') {
      const h = new Headers();
      for (let i = 0; i < list.length; i++) {
        try { h.append(list[i].name, list[i].value); } catch { /* ignore */ }
      }
      return h;
    }
    return headerListToMap(list);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      if (!shouldIntercept()) {
        return origFetch.apply(this, arguments);
      }

      let url = '';
      let method = 'GET';
      try {
        if (typeof input === 'string') {
          url = input;
        } else if (typeof URL === 'function' && input instanceof URL) {
          url = input.href;
        } else if (input && typeof input.url === 'string') {
          url = input.url;
          method = input.method || 'GET';
        }
        if (init && init.method) method = init.method;
      } catch { /* ignore */ }

      const absUrl = absoluteUrl(url);
      if (!absUrl) return origFetch.apply(this, arguments);

      const self = this;
      const args = arguments;
      const startedAt = Date.now();
      const syncBody = init && init.body !== undefined ? extractReqBodyText(init.body) : null;
      stats.matched++;

      return new Promise((resolve, reject) => {
        whenReady(() => {
          if (!shouldIntercept()) {
            origFetch.apply(self, args).then(resolve, reject);
            return;
          }

          const readRequestBody = () => {
            if (syncBody !== null) return Promise.resolve(syncBody);
            const hasRequestObj = input && typeof input !== 'string' && !(typeof URL === 'function' && input instanceof URL);
            const needBody = state.captureOn || rulesNeedBody();
            if (hasRequestObj && needBody && typeof input.clone === 'function') {
              try {
                return input.clone().text().catch(() => null);
              } catch {
                return Promise.resolve(null);
              }
            }
            return Promise.resolve(null);
          };

          readRequestBody().then((reqBodyText) => {
            const info = {
              method: String(method).toUpperCase(),
              url: absUrl,
              headers: headersFrom(init, input),
              reqBodyText
            };
            const hitRule = resolveMock(info.method, absUrl, info.headers, reqBodyText);

            if (hitRule) {
              stats.mocked++;
              const status = hitRule.status || 200;
              const statusText = STATUS_TEXT[status] || '';
              const isNullBody = Boolean(NULL_BODY_STATUSES[status]);
              const bodyStr = isNullBody ? '' : String(hitRule.body || '');
              const headersList = buildFinalHeaders(hitRule);

              const sendMock = () => {
                reportCapture(info, status, headerListToMap(headersList), bodyStr, hitRule, startedAt);
                resolve(new Response(isNullBody ? null : bodyStr, {
                  status,
                  statusText,
                  headers: fetchResponseHeaders(headersList)
                }));
              };

              const delay = Math.max(0, hitRule.delayMs || 0);
              if (delay > 0) setTimeout(sendMock, delay);
              else sendMock();
              return;
            }

            origFetch.apply(self, args).then((res) => {
              if (state.captureOn) {
                try {
                  const resHdrs = {};
                  if (res.headers && typeof res.headers.forEach === 'function') {
                    res.headers.forEach((v, k) => { resHdrs[String(k).toLowerCase()] = String(v); });
                  }
                  if (typeof res.clone === 'function') {
                    res.clone().text().then((t) => {
                      reportCapture(info, res.status, resHdrs, t, null, startedAt);
                    }).catch(() => {
                      reportCapture(info, res.status, resHdrs, '', null, startedAt);
                    });
                  } else {
                    reportCapture(info, res.status, resHdrs, '', null, startedAt);
                  }
                } catch { /* ignore */ }
              }
              resolve(res);
            }, reject);
          });
        });
      });
    };
  }

  /* ------------------------------------------------------------------ *
   * 调试与单元测试入口
   * ------------------------------------------------------------------ */

  window.__mockPanelInfo = function () {
    return {
      installed: true,
      rulesLoaded,
      enabled: state.enabled,
      captureOn: state.captureOn,
      ruleCount: state.rules.length,
      ruleIds: state.rules.map((r) => r.id),
      stats: { matched: stats.matched, mocked: stats.mocked, captured: stats.captured }
    };
  };

  window.__mockPanelTest = {
    absoluteUrl,
    matchUrl,
    matchOp,
    getByPath,
    parseBodyForMatch,
    matchCond,
    matchRule,
    buildContext,
    resolveMock,
    applySync,
    shouldIntercept,
    resetState() {
      state = { enabled: true, rules: [], captureOn: false };
      rulesLoaded = true;
      stats.matched = 0;
      stats.mocked = 0;
      stats.captured = 0;
    }
  };
})();
