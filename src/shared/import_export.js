/* 规则 JSON 导入与导出 */

import { K_RULE_IDS, P_RULE, P_RULE_BODY, SCHEMA_VERSION } from './constants.js';
import { sanitizeRuleMeta } from './matcher.js';

function defaultArea(area) {
  if (area) return area;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  throw new Error('缺少 chrome.storage.local 实例');
}

function getAllKeys(area) {
  return new Promise((resolve, reject) => {
    area.get(null, (res) => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res || {});
    });
  });
}

function getKeys(area, keys) {
  return new Promise((resolve, reject) => {
    area.get(keys, (res) => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res || {});
    });
  });
}

function setKeys(area, patch) {
  return new Promise((resolve, reject) => {
    area.set(patch, () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function removeKeys(area, keys) {
  if (!keys.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    area.remove(keys, () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * 导出规则列表（保持 ruleIds 顺序）
 * scope: 'all' | 'origin'
 */
export function exportRulesPayload({ scope = 'all', origin = '', ruleIds = [], rulesById = {}, bodiesById = {} }) {
  const rules = [];
  for (const id of ruleIds) {
    const meta = rulesById[id];
    if (!meta) continue;
    if (scope === 'origin' && origin && meta.scope !== origin) continue;
    const clean = sanitizeRuleMeta(meta, id);
    const body = typeof bodiesById[id] === 'string' ? bodiesById[id] : '';
    rules.push({ ...clean, body });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    app: 'MockPanel',
    exportedAt: new Date().toISOString(),
    scopeFilter: scope === 'origin' ? (origin || '*') : 'all',
    rules
  };
}

/**
 * 解析并清洗导入的 JSON 文本
 */
export function parseImportPayload(jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.trim()) {
    return { ok: false, error: '导入内容为空' };
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err.message}` };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '导入文件格式不正确：顶层必须是 JSON 对象' };
  }

  if (data.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: `不支持的 schemaVersion：${String(data.schemaVersion)}（仅支持版本 ${SCHEMA_VERSION}）`
    };
  }

  if (!Array.isArray(data.rules)) {
    return { ok: false, error: '导入文件缺少 rules 数组' };
  }

  const rules = [];
  const seenIds = new Set();
  for (const raw of data.rules) {
    if (!raw || typeof raw !== 'object') continue;
    const meta = sanitizeRuleMeta(raw);
    while (seenIds.has(meta.id)) {
      meta.id = sanitizeRuleMeta({ ...meta, id: undefined }).id;
    }
    seenIds.add(meta.id);
    const body = typeof raw.body === 'string' ? raw.body : '';
    rules.push({ meta, body });
  }

  return { ok: true, rules };
}

/**
 * 将解析后的规则写入存储
 * mode: 'merge'（同 ID 覆盖更新，新 ID 置顶合并）| 'replace'（清空现有全部规则后写入）
 */
export async function applyImport(parsedRules, mode = 'merge', area) {
  const store = defaultArea(area);
  const list = Array.isArray(parsedRules) ? parsedRules : [];

  if (mode === 'replace') {
    const all = await getAllKeys(store);
    const oldRuleKeys = Object.keys(all).filter(
      (k) => k.startsWith(P_RULE_BODY) || k.startsWith(P_RULE)
    );
    await removeKeys(store, oldRuleKeys);

    const nextIds = [];
    const patch = {};
    for (const item of list) {
      const meta = sanitizeRuleMeta(item.meta || item, item.meta && item.meta.id);
      const body = typeof item.body === 'string' ? item.body : '';
      nextIds.push(meta.id);
      patch[P_RULE + meta.id] = meta;
      patch[P_RULE_BODY + meta.id] = body;
    }
    patch[K_RULE_IDS] = nextIds;
    await setKeys(store, patch);
    return { added: nextIds.length, updated: 0, total: nextIds.length };
  }

  // merge 模式：同 ID 覆盖更新，新 ID 按导入顺序置顶
  const existing = await getKeys(store, [K_RULE_IDS]);
  const prevIds = Array.isArray(existing[K_RULE_IDS]) ? existing[K_RULE_IDS] : [];
  const prevSet = new Set(prevIds);

  const newIds = [];
  const patch = {};
  let added = 0;
  let updated = 0;

  for (const item of list) {
    const meta = sanitizeRuleMeta(item.meta || item, item.meta && item.meta.id);
    const body = typeof item.body === 'string' ? item.body : '';
    patch[P_RULE + meta.id] = meta;
    patch[P_RULE_BODY + meta.id] = body;
    if (prevSet.has(meta.id)) {
      updated++;
    } else {
      added++;
      newIds.push(meta.id);
      prevSet.add(meta.id);
    }
  }

  const mergedIds = [...newIds, ...prevIds];
  patch[K_RULE_IDS] = mergedIds;
  await setKeys(store, patch);
  return { added, updated, total: mergedIds.length };
}
