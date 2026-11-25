/* 测试 src/inject.js：匹配引擎、优先级、XHR 混合回放、fetch 与抓包开关
 * 运行：node tools/test_inject.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

/* ---------- 最小 DOM / XHR / fetch 桩 ---------- */

const posted = [];
const realXhrCalls = [];
const realFetchCalls = [];
const createdBlobs = [];
const revokedBlobs = [];

class FakeEvent {
  constructor(type) { this.type = type; }
}

class FakeHeaders {
  constructor(init) {
    this._map = new Map();
    if (init && typeof init === 'object') {
      if (typeof init.forEach === 'function') {
        init.forEach((v, k) => this.append(k, v));
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) this.append(k, v);
      } else {
        for (const k of Object.keys(init)) this.append(k, init[k]);
      }
    }
  }
  append(k, v) {
    const lk = String(k).toLowerCase();
    const prev = this._map.get(lk);
    this._map.set(lk, prev ? `${prev}, ${v}` : String(v));
  }
  get(k) { return this._map.get(String(k).toLowerCase()) || null; }
  forEach(cb) { this._map.forEach((v, k) => cb(v, k)); }
}

class FakeResponse {
  constructor(body, init = {}) {
    const status = init.status ?? 200;
    if ((status === 204 || status === 205 || status === 304) && body !== null && body !== undefined) {
      throw new TypeError('Null body status must receive null body');
    }
    this.status = status;
    this.statusText = init.statusText || '';
    this.headers = init.headers instanceof FakeHeaders ? init.headers : new FakeHeaders(init.headers);
    this._body = body == null ? '' : String(body);
  }
  clone() {
    return new FakeResponse(
      (this.status === 204 || this.status === 205 || this.status === 304) ? null : this._body,
      { status: this.status, statusText: this.statusText, headers: this.headers }
    );
  }
  async text() { return this._body; }
  async json() { return JSON.parse(this._body); }
}

class FakeRequest {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method || 'GET';
    this.headers = new FakeHeaders(init.headers || {});
    this._body = typeof init.body === 'string' ? init.body : '';
  }
  clone() {
    return new FakeRequest(this.url, {
      method: this.method,
      headers: this.headers,
      body: this._body
    });
  }
  async text() { return this._body; }
}

class FakeBlob {
  constructor(parts, opts = {}) {
    this.parts = parts;
    this.type = opts.type || '';
    this.textContent = parts.join('');
  }
}

class FakeXHR {
  constructor() {
    this._listeners = {};
    this._reqHeaders = {};
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.responseType = '';
    this.response = '';
    this.responseText = '';
    this.responseURL = '';
  }
  addEventListener(type, fn, opts) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push({ fn, once: Boolean(opts && opts.once) });
  }
  dispatchEvent(evt) {
    const type = evt.type;
    const idl = this['on' + type];
    if (typeof idl === 'function') idl.call(this, evt);
    const list = (this._listeners[type] || []).slice();
    for (const item of list) {
      item.fn.call(this, evt);
      if (item.once) {
        this._listeners[type] = this._listeners[type].filter((x) => x !== item);
      }
    }
  }
  open(method, url, asyncFlag = true) {
    this._opened = { method, url, asyncFlag };
    this.readyState = 1;
  }
  setRequestHeader(k, v) {
    this._reqHeaders[String(k).toLowerCase()] = String(v);
  }
  abort() {
    this._nativeAborted = true;
  }
  getResponseHeader(name) {
    return (this._realResHeaders && this._realResHeaders[String(name).toLowerCase()]) || null;
  }
  getAllResponseHeaders() {
    return this._realRawHeaders || 'content-type: application/json\r\n';
  }
  send(body) {
    realXhrCalls.push({
      method: this._opened.method,
      url: this._opened.url,
      headers: { ...this._reqHeaders },
      body
    });
    if (this._opened.url.startsWith('blob:')) {
      const blob = createdBlobs.find((b) => b.url === this._opened.url);
      this.status = 200;
      this.statusText = 'OK';
      this.responseText = blob ? blob.blob.textContent : '';
      this.response = this.responseType === 'json'
        ? JSON.parse(this.responseText)
        : this.responseText;
      this.readyState = 4;
      setTimeout(() => {
        this.dispatchEvent(new FakeEvent('readystatechange'));
        this.dispatchEvent(new FakeEvent('load'));
        this.dispatchEvent(new FakeEvent('loadend'));
      }, 0);
      return;
    }
    this.status = 200;
    this.statusText = 'OK';
    this.responseText = '{"real":true}';
    this.response = this.responseText;
    this._realRawHeaders = 'content-type: application/json\r\nx-origin: server\r\n';
    this.readyState = 4;
    setTimeout(() => {
      this.dispatchEvent(new FakeEvent('readystatechange'));
      this.dispatchEvent(new FakeEvent('load'));
      this.dispatchEvent(new FakeEvent('loadend'));
    }, 0);
  }
}

let blobSeq = 0;
const FakeURL = class extends URL {};
FakeURL.createObjectURL = (blob) => {
  const u = `blob:http://localhost:3000/${++blobSeq}`;
  createdBlobs.push({ url: u, blob });
  return u;
};
FakeURL.revokeObjectURL = (u) => {
  revokedBlobs.push(u);
};

const winListeners = {};
const win = {
  XMLHttpRequest: FakeXHR,
  postMessage(msg) { posted.push(msg); },
  addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
  fetch(input, init) {
    realFetchCalls.push({ input, init });
    return Promise.resolve(new FakeResponse('{"realFetch":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
  }
};
const sandbox = {
  window: win,
  location: { href: 'http://localhost:3000/app/home', origin: 'http://localhost:3000' },
  document: { baseURI: 'http://localhost:3000/app/home' },
  XMLHttpRequest: FakeXHR,
  URL: FakeURL,
  URLSearchParams,
  Blob: FakeBlob,
  Headers: FakeHeaders,
  Response: FakeResponse,
  Request: FakeRequest,
  Event: FakeEvent,
  TextEncoder,
  Promise,
  setTimeout,
  clearTimeout,
  console,
  postMessage: win.postMessage,
  addEventListener: win.addEventListener,
  fetch: win.fetch
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'inject.js'), 'utf8'),
  sandbox
);

const T = win.__mockPanelTest;
T.resetState();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  /* ---------- 场景 1：URL 匹配与归一化 ---------- */
  console.log('\n场景：URL 匹配模式与相对路径归一化');
  check('相对路径按 baseURI 归一化为绝对地址',
    T.absoluteUrl('../api/users?a=1') === 'http://localhost:3000/api/users?a=1');
  check('contains 模式命中子串',
    T.matchUrl('contains', '/api/user', 'http://localhost:3000/api/users/1') === true);
  check('equals 不带 query 时匹配 pathname（忽略请求 query）',
    T.matchUrl('equals', '/api/users', 'http://localhost:3000/api/users?_t=123') === true);
  check('equals 带 query 时精确匹配 pathname + search',
    T.matchUrl('equals', '/api/users?id=2', 'http://localhost:3000/api/users?id=1') === false &&
    T.matchUrl('equals', '/api/users?id=2', 'http://localhost:3000/api/users?id=2') === true);
  check('wildcard 通配符匹配路径与完整 URL',
    T.matchUrl('wildcard', '/api/*/detail', 'http://localhost:3000/api/42/detail?x=1') === true &&
    T.matchUrl('wildcard', 'https://*.test.com/v1/*', 'https://api.test.com/v1/orders') === true &&
    T.matchUrl('wildcard', '/api/*/detail', 'http://localhost:3000/api/42/edit') === false);
  check('regex 模式命中并安全处理非法正则',
    T.matchUrl('regex', '/api/users/\\d+$', 'http://localhost:3000/api/users/99') === true &&
    T.matchUrl('regex', '[unclosed', 'http://localhost:3000/api/users') === false);
  check('空 urlPattern 恒不命中',
    T.matchUrl('contains', '   ', 'http://localhost:3000/api/users') === false);

  /* ---------- 场景 2：Method、Query、Header、Body 与运算符 ---------- */
  console.log('\n场景：Method / Query / Header / Body 与五种运算符');
  const jsonCtx = T.buildContext(
    'POST',
    'http://localhost:3000/graphql?tab=orders&empty=',
    { 'X-Env': 'staging', 'Content-Type': 'application/json' },
    JSON.stringify({ operationName: 'GetOrders', filter: { items: [{ id: 101 }, { id: 202 }], active: true } })
  );

  check('Method 区分与 ANY 通配',
    T.matchRule({ method: 'GET', urlOp: 'contains', urlPattern: '/graphql', conditions: [] }, jsonCtx) === false &&
    T.matchRule({ method: 'ANY', urlOp: 'contains', urlPattern: '/graphql', conditions: [] }, jsonCtx) === true);
  check('Query 参数 equals / exists 命中与缺失拒绝',
    T.matchCond({ source: 'query', path: 'tab', op: 'equals', value: 'orders' }, jsonCtx) === true &&
    T.matchCond({ source: 'query', path: 'empty', op: 'exists', value: '' }, jsonCtx) === false &&
    T.matchCond({ source: 'query', path: 'missing', op: 'notEquals', value: 'x' }, jsonCtx) === false);
  check('Header 大小写无关匹配',
    T.matchCond({ source: 'header', path: 'X-ENV', op: 'equals', value: 'staging' }, jsonCtx) === true);
  check('JSON 请求体点号路径与数组下标匹配',
    T.matchCond({ source: 'body', path: 'filter.items.1.id', op: 'equals', value: '202' }, jsonCtx) === true &&
    T.matchCond({ source: 'body', path: 'filter.active', op: 'equals', value: 'true' }, jsonCtx) === true);
  check('请求体 $raw 与 contains / notEquals / regex 运算符',
    T.matchCond({ source: 'body', path: '$raw', op: 'contains', value: 'GetOrders' }, jsonCtx) === true &&
    T.matchCond({ source: 'body', path: 'operationName', op: 'notEquals', value: 'DeleteOrder' }, jsonCtx) === true &&
    T.matchCond({ source: 'body', path: 'operationName', op: 'regex', value: '^Get[A-Z]+' }, jsonCtx) === true &&
    T.matchCond({ source: 'body', path: 'operationName', op: 'regex', value: '[' }, jsonCtx) === false);

  const formCtx = T.buildContext(
    'POST',
    'http://localhost:3000/login',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    'username=alice&role=admin'
  );
  check('x-www-form-urlencoded 请求体字段匹配',
    T.matchCond({ source: 'body', path: 'username', op: 'equals', value: 'alice' }, formCtx) === true);

  const hugeCtx = T.buildContext('POST', 'http://localhost:3000/big', {}, 'a'.repeat(2 * 1024 * 1024 + 5));
  check('超 2MB 请求体不解析，含 body 条件的规则不命中',
    T.matchCond({ source: 'body', path: '$raw', op: 'exists', value: '' }, hugeCtx) === false);

  const nonStrCtx = T.buildContext('POST', 'http://localhost:3000/upload', {}, null);
  check('拿不到请求体文本时含 body 条件不命中',
    T.matchCond({ source: 'body', path: 'a', op: 'notEquals', value: 'b' }, nonStrCtx) === false);

  /* ---------- 场景 3：列表从上而下优先级与总开关 ---------- */
  console.log('\n场景：列表自上而下顺序优先级与总开关');
  T.applySync({
    enabled: true,
    captureOn: false,
    rules: [
      { id: 'r1', name: '首条规则', method: 'GET', urlOp: 'contains', urlPattern: '/api/items', conditions: [], status: 200, body: '{"from":"r1"}' },
      { id: 'r2', name: '次条更具体规则', method: 'GET', urlOp: 'equals', urlPattern: '/api/items', conditions: [{ source: 'query', path: 'a', op: 'equals', value: '1' }], status: 200, body: '{"from":"r2"}' }
    ]
  });
  const hitFirst = T.resolveMock('GET', 'http://localhost:3000/api/items?a=1', {}, null);
  check('按列表顺序命中第一条（不因第二条条件多而抢占）', hitFirst && hitFirst.id === 'r1');

  T.applySync({ enabled: false, captureOn: false, rules: [{ id: 'r1', urlPattern: '/api/items', body: '{}' }] });
  check('总开关关闭时不命中任何规则', T.resolveMock('GET', 'http://localhost:3000/api/items', {}, null) === null);

  /* ---------- 场景 4：抓包关闭且无规则时极速透传 ---------- */
  console.log('\n场景：极速透传与抓包开关');
  T.applySync({ enabled: true, captureOn: false, rules: [] });
  check('无规则且未开抓包时 shouldIntercept() 为 false', T.shouldIntercept() === false);

  posted.length = 0;
  realXhrCalls.length = 0;
  const passXhr = new win.XMLHttpRequest();
  passXhr.open('GET', '/api/ping');
  passXhr.send();
  await sleep(20);
  check('极速透传直接进入原生 XHR 且不上报抓包', realXhrCalls.length === 1 && posted.length === 0);

  /* ---------- 场景 5：XHR 混合回放（blob / 覆写 / 延迟 / abort） ---------- */
  console.log('\n场景：XHR 混合回放策略');
  createdBlobs.length = 0;
  revokedBlobs.length = 0;
  realXhrCalls.length = 0;
  posted.length = 0;

  T.applySync({
    enabled: true,
    captureOn: true,
    rules: [
      {
        id: 'blob_rule',
        name: 'Blob200',
        method: 'GET',
        urlOp: 'equals',
        urlPattern: '/api/blob',
        conditions: [],
        status: 200,
        delayMs: 0,
        responseHeaders: [],
        contentType: 'application/json;charset=utf-8',
        body: '{"blobOk":true}'
      },
      {
        id: 'err_rule',
        name: 'Err500',
        method: 'POST',
        urlOp: 'equals',
        urlPattern: '/api/err',
        conditions: [],
        status: 500,
        delayMs: 10,
        responseHeaders: [{ name: 'X-Trace', value: 't-99' }],
        contentType: 'application/json;charset=utf-8',
        body: '{"error":"boom"}'
      },
      {
        id: 'slow_rule',
        name: 'SlowAbort',
        method: 'GET',
        urlOp: 'equals',
        urlPattern: '/api/slow',
        conditions: [],
        status: 404,
        delayMs: 80,
        responseHeaders: [],
        body: 'not found'
      }
    ]
  });

  // 5.1 200 无自定义头 -> blob: URL
  const x1 = new win.XMLHttpRequest();
  let x1Done = false;
  x1.addEventListener('loadend', () => { x1Done = true; });
  x1.open('GET', '/api/blob');
  x1.send();
  await sleep(30);
  check('200 无自定义头走 blob: URL 原生回放', x1Done && createdBlobs.length === 1 && realXhrCalls[0].url.startsWith('blob:'));
  check('blob: 请求结束后自动 revokeObjectURL', revokedBlobs.length === 1);
  check('开启抓包时 Mock 请求也上报且带命中规则信息',
    posted.some((m) => m.type === 'captured' && m.entry.mocked && m.entry.matchedRuleId === 'blob_rule'));

  // 5.2 500 + 自定义响应头 + responseType=json -> 实例覆写
  const x2 = new win.XMLHttpRequest();
  const states2 = [];
  let loaded2 = false;
  x2.responseType = 'json';
  x2.onreadystatechange = () => states2.push(x2.readyState);
  x2.onload = () => { loaded2 = true; };
  x2.open('POST', '/api/err');
  x2.send('{"a":1}');
  await sleep(40);
  check('非 200 + 自定义响应头走实例覆写且未走真实请求', realXhrCalls.length === 1 && loaded2);
  check('实例覆写状态机依次推进 2 -> 3 -> 4', JSON.stringify(states2) === JSON.stringify([2, 3, 4]), JSON.stringify(states2));
  check('实例覆写 status=500、response 解析为 JSON 对象、响应头可读',
    x2.status === 500 && x2.response && x2.response.error === 'boom' &&
    x2.getResponseHeader('x-trace') === 't-99' &&
    x2.getAllResponseHeaders().includes('x-trace: t-99'));

  // 5.3 delayMs 期间 abort()
  const x3 = new win.XMLHttpRequest();
  let aborted3 = false;
  let loaded3 = false;
  x3.onabort = () => { aborted3 = true; };
  x3.onload = () => { loaded3 = true; };
  x3.open('GET', '/api/slow');
  x3.send();
  await sleep(15);
  x3.abort();
  await sleep(90);
  check('延迟期间调用 abort() 中断 Mock 并触发 abort 且不再触发 load', aborted3 && !loaded3 && x3.status === 0);

  /* ---------- 场景 6：fetch 拦截（含 204、Request 对象与未命中抓包） ---------- */
  console.log('\n场景：fetch 自定义状态码、204 空响应体与 Request 对象');
  realFetchCalls.length = 0;
  posted.length = 0;

  T.applySync({
    enabled: true,
    captureOn: true,
    rules: [
      {
        id: 'f204',
        name: 'NoContent204',
        method: 'DELETE',
        urlOp: 'equals',
        urlPattern: '/api/item/1',
        conditions: [],
        status: 204,
        delayMs: 0,
        responseHeaders: [{ name: 'X-Deleted', value: 'yes' }],
        body: 'ignored-by-204'
      },
      {
        id: 'freq',
        name: 'ReqObj401',
        method: 'POST',
        urlOp: 'contains',
        urlPattern: '/api/auth',
        conditions: [{ source: 'body', path: 'token', op: 'equals', value: 'bad' }],
        status: 401,
        delayMs: 0,
        responseHeaders: [{ name: 'X-Auth', value: 'denied' }],
        contentType: 'text/plain;charset=utf-8',
        body: 'Unauthorized token'
      }
    ]
  });

  const r204 = await win.fetch('/api/item/1', { method: 'DELETE' });
  check('fetch 命中 204 状态码时不抛异常且返回自定义响应头',
    r204.status === 204 && r204.headers.get('x-deleted') === 'yes' && (await r204.text()) === '');

  const reqObj = new FakeRequest('http://localhost:3000/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"token":"bad"}'
  });
  const r401 = await win.fetch(reqObj);
  check('fetch 传入 Request 对象时能提取请求体匹配并返回 401 非 JSON 响应',
    r401.status === 401 && r401.headers.get('x-auth') === 'denied' && (await r401.text()) === 'Unauthorized token');

  const rReal = await win.fetch('/api/unmatched');
  await sleep(10);
  check('fetch 未命中规则时放行真实请求且在抓包开启时上报',
    realFetchCalls.length === 1 && (await rReal.text()) === '{"realFetch":true}' &&
    posted.some((m) => m.type === 'captured' && !m.entry.mocked && m.entry.path === '/api/unmatched'));

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
