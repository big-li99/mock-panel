/* 测试 src/shared/{matcher,storage,import_export}.js
 * 运行：node tools/test_storage_io.mjs
 */

import {
  extractSelectableFields,
  isRuleRunnable,
  sanitizeConditions,
  sanitizeRuleMeta
} from '../src/shared/matcher.js';
import {
  countActiveRulesForOrigin,
  deleteRule,
  duplicateRule,
  listKnownOrigins,
  loadAllMeta,
  loadRuleBody,
  reorderRuleIds,
  saveRule,
  seedDefaults,
  setGlobalEnabled,
  toggleRuleEnabled
} from '../src/shared/storage.js';
import {
  applyImport,
  exportRulesPayload,
  parseImportPayload
} from '../src/shared/import_export.js';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

function createMemoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(keys, cb) {
      if (keys === null) {
        cb({ ...data });
        return;
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) {
        if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
      }
      cb(out);
    },
    set(patch, cb) {
      Object.assign(data, patch);
      cb && cb();
    },
    remove(keys, cb) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete data[k];
      cb && cb();
    }
  };
}

async function run() {
  /* ---------- 场景 1：matcher 规则清洗与抓包字段提取 ---------- */
  console.log('\n场景：matcher 规则清洗与抓包点选字段提取');
  const cleanConds = sanitizeConditions([
    { source: 'query', path: 'flag', op: 'equals', value: '0' },
    { source: 'header', path: 'x-ok', op: 'exists', value: '' },
    { source: 'body', path: 'emptyVal', op: 'equals', value: '' },
    { source: 'body', path: 'badRx', op: 'regex', value: '[' }
  ]);
  check('sanitizeConditions 允许 0 和 exists 空值，过滤空等值与非法正则',
    cleanConds.length === 2 && cleanConds[0].value === '0' && cleanConds[1].op === 'exists');

  const metaBadRx = sanitizeRuleMeta({ id: 'r1', urlOp: 'regex', urlPattern: '[abc', enabled: true });
  check('isRuleRunnable 拦截非法正则规则', isRuleRunnable(metaBadRx) === false);

  const fields = extractSelectableFields({
    url: 'http://localhost:3000/graphql?tab=active&page=2',
    reqHeaders: {
      'user-agent': 'Mozilla/5.0',
      'sec-ch-ua': '"Chromium"',
      'x-tenant': 'acme',
      'content-type': 'application/json'
    },
    reqBody: JSON.stringify({
      variables: { filter: { status: 'OPEN' }, tags: ['a', 'b'] },
      operationName: 'FetchOrders'
    })
  });
  check('extractSelectableFields 跳过浏览器噪声头并让 operationName 排在最前',
    fields[0].source === 'body' && fields[0].path === 'operationName' && fields[0].value === 'FetchOrders',
    JSON.stringify(fields));
  check('extractSelectableFields 提取 Query、业务头、嵌套 JSON 与数组下标路径',
    fields.some((f) => f.source === 'query' && f.path === 'tab' && f.value === 'active') &&
    fields.some((f) => f.source === 'header' && f.path === 'x-tenant' && f.value === 'acme') &&
    !fields.some((f) => f.source === 'header' && f.path === 'user-agent') &&
    fields.some((f) => f.source === 'body' && f.path === 'variables.filter.status' && f.value === 'OPEN') &&
    fields.some((f) => f.source === 'body' && f.path === 'variables.tags.1' && f.value === 'b'));

  const formFields = extractSelectableFields({
    url: 'http://localhost:3000/rpc',
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    reqBody: 'serviceKey=OrderQuery&page=1'
  });
  check('extractSelectableFields 支持 x-www-form-urlencoded 并优先路由键 serviceKey',
    formFields[0].source === 'body' && formFields[0].path === 'serviceKey' && formFields[0].value === 'OrderQuery');

  /* ---------- 场景 2：storage 分层读写与 CRUD ---------- */
  console.log('\n场景：storage 分层读写、排序、复制与按站点统计');
  const area = createMemoryStorage();
  await seedDefaults(area);
  check('seedDefaults 初始化默认总开关和空 ruleIds',
    area.data['mockPanel.enabled'] === true && Array.isArray(area.data['mockPanel.ruleIds']));

  const r1 = await saveRule({
    id: 'r1', name: '规则1', scope: 'http://localhost:3000',
    method: 'GET', urlOp: 'equals', urlPattern: '/api/a', status: 200
  }, '{"a":1}', { prepend: true }, area);
  const r2 = await saveRule({
    id: 'r2', name: '规则2', scope: '*',
    method: 'POST', urlOp: 'contains', urlPattern: '/api/b', status: 500
  }, '{"err":true}', { prepend: true }, area);
  await saveRule({
    id: 'r3', name: '其他站点', scope: 'http://localhost:8080',
    method: 'GET', urlOp: 'contains', urlPattern: '/api/c', status: 200
  }, '{"c":1}', { prepend: true }, area);

  let loaded = await loadAllMeta(area);
  check('新保存的规则默认置顶，且元信息不包含 body 大字段',
    JSON.stringify(loaded.ruleIds) === JSON.stringify(['r3', 'r2', 'r1']) &&
    !('body' in loaded.rulesById.r1));
  check('loadRuleBody 按需读取单条响应体', (await loadRuleBody('r2', area)) === '{"err":true}');

  check('countActiveRulesForOrigin 统计当前站点 + 全局生效规则数',
    countActiveRulesForOrigin(loaded.enabled, loaded.ruleIds, loaded.rulesById, 'http://localhost:3000') === 2);

  await toggleRuleEnabled('r2', false, area);
  loaded = await loadAllMeta(area);
  check('停用单条规则后生效数减少且不触发错误',
    loaded.rulesById.r2.enabled === false &&
    countActiveRulesForOrigin(loaded.enabled, loaded.ruleIds, loaded.rulesById, 'http://localhost:3000') === 1);

  const dup = await duplicateRule('r1', area);
  loaded = await loadAllMeta(area);
  check('duplicateRule 生成停用副本并插在原规则下方且复制响应体',
    dup && dup.enabled === false && dup.name === '规则1 副本' &&
    loaded.ruleIds[loaded.ruleIds.indexOf('r1') + 1] === dup.id &&
    (await loadRuleBody(dup.id, area)) === '{"a":1}');

  await reorderRuleIds(['r1', 'r2', 'r3', dup.id], area);
  loaded = await loadAllMeta(area);
  check('reorderRuleIds 保存新排序', JSON.stringify(loaded.ruleIds) === JSON.stringify(['r1', 'r2', 'r3', dup.id]));

  check('listKnownOrigins 返回去重排序后的非全局站点',
    JSON.stringify(listKnownOrigins(loaded.rulesById)) === JSON.stringify(['http://localhost:3000', 'http://localhost:8080']));

  await setGlobalEnabled(false, area);
  loaded = await loadAllMeta(area);
  check('总开关关闭后 countActiveRulesForOrigin 返回 0',
    countActiveRulesForOrigin(loaded.enabled, loaded.ruleIds, loaded.rulesById, 'http://localhost:3000') === 0);

  await deleteRule(dup.id, area);
  check('deleteRule 同步清理 rule: 与 rulebody: 及 ruleIds',
    !('rule:' + dup.id in area.data) && !('rulebody:' + dup.id in area.data) &&
    !area.data['mockPanel.ruleIds'].includes(dup.id));

  /* ---------- 场景 3：import_export 导入与导出 ---------- */
  console.log('\n场景：规则导入导出（单站/全部、合并/覆盖与校验）');
  const exportAll = exportRulesPayload({
    scope: 'all',
    ruleIds: ['r1', 'r2', 'r3'],
    rulesById: loaded.rulesById,
    bodiesById: { r1: '{"a":1}', r2: '{"err":true}', r3: '{"c":1}' }
  });
  check('导出全部规则包含 schemaVersion=1 与完整 body',
    exportAll.schemaVersion === 1 && exportAll.rules.length === 3 && exportAll.rules[1].body === '{"err":true}');

  const exportSite = exportRulesPayload({
    scope: 'origin',
    origin: 'http://localhost:3000',
    ruleIds: ['r1', 'r2', 'r3'],
    rulesById: loaded.rulesById,
    bodiesById: { r1: '{"a":1}', r2: '{"err":true}', r3: '{"c":1}' }
  });
  check('单站导出只包含匹配该站点 scope 的规则',
    exportSite.rules.length === 1 && exportSite.rules[0].id === 'r1');

  check('非法 JSON 导入被拒绝', parseImportPayload('{bad').ok === false);
  check('错误 schemaVersion 导入被拒绝',
    parseImportPayload(JSON.stringify({ schemaVersion: 99, rules: [] })).ok === false);

  const parsedMerge = parseImportPayload(JSON.stringify({
    schemaVersion: 1,
    rules: [
      { id: 'r1', name: '规则1-更新', scope: 'http://localhost:3000', urlPattern: '/api/a2', body: '{"updated":true}' },
      { id: 'r_new', name: '新导入规则', scope: '*', urlPattern: '/api/new', body: '{"new":1}' }
    ]
  }));
  check('合法导入 JSON 解析成功', parsedMerge.ok === true && parsedMerge.rules.length === 2);

  const mergeRes = await applyImport(parsedMerge.rules, 'merge', area);
  const afterMerge = await loadAllMeta(area);
  check('merge 模式同 ID 覆盖更新、新 ID 置顶合并',
    mergeRes.added === 1 && mergeRes.updated === 1 &&
    afterMerge.ruleIds[0] === 'r_new' &&
    afterMerge.rulesById.r1.name === '规则1-更新' &&
    (await loadRuleBody('r1', area)) === '{"updated":true}');

  const replaceRes = await applyImport([parsedMerge.rules[1]], 'replace', area);
  const afterReplace = await loadAllMeta(area);
  check('replace 模式清空旧规则并仅保留导入规则',
    replaceRes.total === 1 &&
    JSON.stringify(afterReplace.ruleIds) === JSON.stringify(['r_new']) &&
    !('rule:r1' in area.data) && !('rulebody:r1' in area.data));

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
