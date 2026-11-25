/* 测试 src/bridge.js：origin+全局过滤、保序下发、签名去重与抓包开关转发
 * 运行：node tools/test_bridge.js
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

const ORIGIN_A = 'http://localhost:3000';
const ORIGIN_B = 'http://localhost:8080';

const store = {
  'mockPanel.enabled': true,
  'mockPanel.ruleIds': ['r_other', 'r_second', 'r_disabled', 'r_empty_url', 'r_bad_regex', 'r_first_global', 'r_204'],
  'rule:r_other': {
    id: 'r_other', name: '其他站点', scope: ORIGIN_B, method: 'GET',
    urlOp: 'contains', urlPattern: '/api/other', conditions: [], status: 200, enabled: true
  },
  'rulebody:r_other': '{"shouldNotRead":true}',
  'rule:r_second': {
    id: 'r_second', name: '本站规则', scope: ORIGIN_A, method: 'POST',
    urlOp: 'equals', urlPattern: '/api/save',
    conditions: [{ source: 'body', path: 'op', op: 'equals', value: 'create' }],
    status: 201, delayMs: 25, responseHeaders: [{ name: 'X-Tag', value: 'v1' }], enabled: true
  },
  'rulebody:r_second': '{"saved":1}',
  'rule:r_disabled': {
    id: 'r_disabled', name: '停用规则', scope: ORIGIN_A, method: 'GET',
    urlOp: 'contains', urlPattern: '/api/off', enabled: false
  },
  'rulebody:r_disabled': '{"off":true}',
  'rule:r_empty_url': {
    id: 'r_empty_url', name: '空URL草稿', scope: ORIGIN_A, method: 'GET',
    urlOp: 'contains', urlPattern: '   ', enabled: true
  },
  'rulebody:r_empty_url': '{"draft":true}',
  'rule:r_bad_regex': {
    id: 'r_bad_regex', name: '非法正则', scope: ORIGIN_A, method: 'GET',
    urlOp: 'regex', urlPattern: '[bad', enabled: true
  },
  'rulebody:r_bad_regex': '{"bad":true}',
  'rule:r_first_global': {
    id: 'r_first_global', name: '全局规则', scope: '*', method: 'GET',
    urlOp: 'contains', urlPattern: '/api/flags', conditions: [], status: 200, enabled: true
  },
  'rulebody:r_first_global': '{"global":true}',
  'rule:r_204': {
    id: 'r_204', name: '空响应体204', scope: ORIGIN_A, method: 'DELETE',
    urlOp: 'equals', urlPattern: '/api/item', conditions: [], status: 204, enabled: true
  },
  'rulebody:r_204': ''
};

const getCalls = [];
const postedToPage = [];
const sentToBg = [];
const winListeners = {};
let storageListener = null;
let runtimeMessageListener = null;
let captureStateResponse = { captureOn: false };

const win = {
  addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
  postMessage(msg) { postedToPage.push(msg); }
};

const sandbox = {
  window: win,
  location: { origin: ORIGIN_A, href: ORIGIN_A + '/index.html' },
  chrome: {
    storage: {
      local: {
        get(keys, cb) {
          getCalls.push(keys);
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) {
            if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          }
          cb(out);
        }
      },
      onChanged: {
        addListener(fn) { storageListener = fn; }
      }
    },
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        sentToBg.push(msg);
        if (msg && msg.type === 'getCaptureState') {
          cb && cb(captureStateResponse);
        } else {
          cb && cb({ ok: true });
        }
      },
      onMessage: {
        addListener(fn) { runtimeMessageListener = fn; }
      }
    }
  }
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8'),
  sandbox
);

function emitPage(msg) {
  for (const fn of winListeners.message || []) {
    fn({ source: win, data: { __ch: 'mock-panel:page', ...msg } });
  }
}

/* ---------- 场景 1：按 origin + 全局过滤与保序下发 ---------- */
console.log('\n场景：按站点过滤、保序下发与无效规则过滤');
check('启动时主动查询 getCaptureState 并向页面下发 sync',
  sentToBg.some((m) => m.type === 'getCaptureState') &&
  postedToPage.length === 1 && postedToPage[0].type === 'sync');

const sync1 = postedToPage[0].payload;
check('只下发当前 origin 与全局规则，过滤其他站点/停用/空 URL/非法正则',
  JSON.stringify(sync1.rules.map((r) => r.id)) === JSON.stringify(['r_second', 'r_first_global', 'r_204']),
  JSON.stringify(sync1.rules.map((r) => r.id)));

check('允许 204 等空响应体规则被下发',
  sync1.rules.some((r) => r.id === 'r_204' && r.body === '' && r.status === 204));

const bodyReads = getCalls.flat().filter((k) => typeof k === 'string' && k.startsWith('rulebody:'));
check('不读取其他站点或停用规则的 rulebody 大文本',
  !bodyReads.includes('rulebody:r_other') && !bodyReads.includes('rulebody:r_disabled'),
  JSON.stringify(bodyReads));

/* ---------- 场景 2：hello 握手去重 ---------- */
console.log('\n场景：hello 握手首次必推与后续签名去重');
postedToPage.length = 0;
emitPage({ type: 'hello' });
check('首次收到页面 hello 时忽略签名强制推送一次', postedToPage.length === 1);
postedToPage.length = 0;
emitPage({ type: 'hello' });
check('第二次收到页面 hello 且配置未变时去重不推送', postedToPage.length === 0);

/* ---------- 场景 3：修改条件/顺序/状态码/响应头穿透签名重推 ---------- */
console.log('\n场景：规则细节修改触发重新下发');
postedToPage.length = 0;
store['rule:r_second'] = {
  ...store['rule:r_second'],
  conditions: [{ source: 'body', path: 'op', op: 'equals', value: 'update' }]
};
storageListener({ 'rule:r_second': { newValue: store['rule:r_second'] } }, 'local');
check('只改匹配条件时签名变化并重新下发',
  postedToPage.length === 1 &&
  postedToPage[0].payload.rules[0].conditions[0].value === 'update');

postedToPage.length = 0;
store['mockPanel.ruleIds'] = ['r_first_global', 'r_second', 'r_204'];
storageListener({ 'mockPanel.ruleIds': { newValue: store['mockPanel.ruleIds'] } }, 'local');
check('调整 ruleIds 顺序时重新下发并保持新顺序',
  postedToPage.length === 1 &&
  JSON.stringify(postedToPage[0].payload.rules.map((r) => r.id)) === JSON.stringify(['r_first_global', 'r_second', 'r_204']));

postedToPage.length = 0;
store['rule:r_second'] = { ...store['rule:r_second'], status: 503, delayMs: 200 };
storageListener({ 'rule:r_second': { newValue: store['rule:r_second'] } }, 'local');
check('修改状态码或延迟时重新下发',
  postedToPage.length === 1 &&
  postedToPage[0].payload.rules[1].status === 503 &&
  postedToPage[0].payload.rules[1].delayMs === 200);

/* ---------- 场景 4：抓包开关与转发控制 ---------- */
console.log('\n场景：setCapture 控制与 captured 上报转发');
sentToBg.length = 0;
emitPage({ type: 'captured', entry: { id: 'c1', url: ORIGIN_A + '/a' } });
check('captureOn 为 false 时忽略页面上报的 captured 消息', sentToBg.length === 0);

postedToPage.length = 0;
let resp = null;
runtimeMessageListener({ type: 'setCapture', enabled: true }, {}, (r) => { resp = r; });
check('收到 setCapture=true 时更新状态并向页面推送 captureOn=true',
  resp && resp.ok && postedToPage.length === 1 && postedToPage[0].payload.captureOn === true);

emitPage({ type: 'captured', entry: { id: 'c2', url: ORIGIN_A + '/b' } });
check('captureOn 为 true 时正常将 captured 转发给 background',
  sentToBg.length === 1 && sentToBg[0].type === 'captured' && sentToBg[0].entry.id === 'c2');

/* ---------- 场景 5：页面刷新时若后台处于抓包态自动开启抓包 ---------- */
console.log('\n场景：启动查询 getCaptureState 自动恢复抓包态');
captureStateResponse = { captureOn: true };
const posted2 = [];
const win2 = { addEventListener() {}, postMessage(m) { posted2.push(m); } };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8'),
  { ...sandbox, window: win2 }
);
check('getCaptureState 返回 true 时同步抓包态到页面',
  posted2.some((m) => m.type === 'sync' && m.payload && m.payload.captureOn === true));

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
process.exit(failures === 0 ? 0 : 1);
