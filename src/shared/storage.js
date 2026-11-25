/* chrome.storage.local 分层存储管理（元信息与响应体分离） */

import { K_ENABLED, K_RULE_IDS, P_RULE, P_RULE_BODY } from './constants.js';
import {
  isRuleRunnable,
  makeRuleId,
  ruleMatchesOrigin,
  sanitizeRuleMeta
} from './matcher.js';

function defaultArea(area) {
  if (area) return area;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  throw new Error('缺少 chrome.storage.local 实例');
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

export async function seedDefaults(area) {
  const store = defaultArea(area);
  const res = await getKeys(store, [K_ENABLED, K_RULE_IDS]);
  const patch = {};
  if (typeof res[K_ENABLED] !== 'boolean') patch[K_ENABLED] = true;
  if (!Array.isArray(res[K_RULE_IDS])) patch[K_RULE_IDS] = [];
  if (Object.keys(patch).length) await setKeys(store, patch);
}

/**
 * 读取全部规则元信息（不读 rulebody:* 大文本），保持 ruleIds 顺序并清洗悬空引用。
 */
export async function loadAllMeta(area) {
  const store = defaultArea(area);
  const res = await getKeys(store, [K_ENABLED, K_RULE_IDS]);
  const enabled = res[K_ENABLED] !== false;
  const rawIds = Array.isArray(res[K_RULE_IDS]) ? res[K_RULE_IDS] : [];

  if (!rawIds.length) {
    return { enabled, ruleIds: [], rulesById: {} };
  }

  const uniqueIds = [];
  const seen = new Set();
  for (const id of rawIds) {
    const s = String(id ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    uniqueIds.push(s);
  }

  const metaKeys = uniqueIds.map((id) => P_RULE + id);
  const metaMap = await getKeys(store, metaKeys);

  const ruleIds = [];
  const rulesById = {};
  for (const id of uniqueIds) {
    const rawMeta = metaMap[P_RULE + id];
    if (!rawMeta || typeof rawMeta !== 'object') continue;
    ruleIds.push(id);
    rulesById[id] = sanitizeRuleMeta(rawMeta, id);
  }

  return { enabled, ruleIds, rulesById };
}

export async function loadRuleBody(id, area) {
  const store = defaultArea(area);
  const key = P_RULE_BODY + id;
  const res = await getKeys(store, [key]);
  return typeof res[key] === 'string' ? res[key] : '';
}

export async function loadRulesWithBodies(ids, area) {
  const store = defaultArea(area);
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) return { rulesById: {}, bodiesById: {} };

  const keys = [];
  for (const id of list) {
    keys.push(P_RULE + id, P_RULE_BODY + id);
  }
  const res = await getKeys(store, keys);
  const rulesById = {};
  const bodiesById = {};
  for (const id of list) {
    if (res[P_RULE + id] && typeof res[P_RULE + id] === 'object') {
      rulesById[id] = sanitizeRuleMeta(res[P_RULE + id], id);
      bodiesById[id] = typeof res[P_RULE_BODY + id] === 'string' ? res[P_RULE_BODY + id] : '';
    }
  }
  return { rulesById, bodiesById };
}

export async function setGlobalEnabled(enabled, area) {
  const store = defaultArea(area);
  await setKeys(store, { [K_ENABLED]: Boolean(enabled) });
}

export async function saveRule(meta, body, { prepend = true } = {}, area) {
  const store = defaultArea(area);
  const cleanMeta = sanitizeRuleMeta(meta, meta && meta.id);
  const bodyText = typeof body === 'string' ? body : '';

  const res = await getKeys(store, [K_RULE_IDS]);
  const prevIds = Array.isArray(res[K_RULE_IDS]) ? res[K_RULE_IDS] : [];
  const exists = prevIds.includes(cleanMeta.id);

  let nextIds = prevIds;
  if (!exists) {
    nextIds = prepend ? [cleanMeta.id, ...prevIds] : [...prevIds, cleanMeta.id];
  }

  const patch = {
    [P_RULE + cleanMeta.id]: cleanMeta,
    [P_RULE_BODY + cleanMeta.id]: bodyText
  };
  if (!exists) patch[K_RULE_IDS] = nextIds;

  await setKeys(store, patch);
  return cleanMeta;
}

export async function toggleRuleEnabled(id, enabled, area) {
  const store = defaultArea(area);
  const key = P_RULE + id;
  const res = await getKeys(store, [key]);
  const raw = res[key];
  if (!raw || typeof raw !== 'object') return null;

  const updated = sanitizeRuleMeta({ ...raw, enabled: Boolean(enabled), updatedAt: Date.now() }, id);
  await setKeys(store, { [key]: updated });
  return updated;
}

export async function deleteRule(id, area) {
  const store = defaultArea(area);
  const res = await getKeys(store, [K_RULE_IDS]);
  const prevIds = Array.isArray(res[K_RULE_IDS]) ? res[K_RULE_IDS] : [];
  const nextIds = prevIds.filter((item) => item !== id);

  await setKeys(store, { [K_RULE_IDS]: nextIds });
  await removeKeys(store, [P_RULE + id, P_RULE_BODY + id]);
}

export async function reorderRuleIds(newIds, area) {
  const store = defaultArea(area);
  const clean = [];
  const seen = new Set();
  for (const id of Array.isArray(newIds) ? newIds : []) {
    const s = String(id ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
  }
  await setKeys(store, { [K_RULE_IDS]: clean });
  return clean;
}

export async function duplicateRule(id, area) {
  const store = defaultArea(area);
  const res = await getKeys(store, [K_RULE_IDS, P_RULE + id, P_RULE_BODY + id]);
  const raw = res[P_RULE + id];
  if (!raw || typeof raw !== 'object') return null;

  const body = typeof res[P_RULE_BODY + id] === 'string' ? res[P_RULE_BODY + id] : '';
  const newId = makeRuleId();
  const copyMeta = sanitizeRuleMeta({
    ...raw,
    id: newId,
    name: `${String(raw.name || '未命名规则').trim()} 副本`,
    enabled: false,
    updatedAt: Date.now()
  }, newId);

  const prevIds = Array.isArray(res[K_RULE_IDS]) ? res[K_RULE_IDS] : [];
  const idx = prevIds.indexOf(id);
  const nextIds = prevIds.slice();
  if (idx >= 0) nextIds.splice(idx + 1, 0, newId);
  else nextIds.unshift(newId);

  await setKeys(store, {
    [K_RULE_IDS]: nextIds,
    [P_RULE + newId]: copyMeta,
    [P_RULE_BODY + newId]: body
  });
  return copyMeta;
}

export function listKnownOrigins(rulesById) {
  const origins = new Set();
  if (!rulesById || typeof rulesById !== 'object') return [];
  for (const meta of Object.values(rulesById)) {
    if (meta && meta.scope && meta.scope !== '*') {
      origins.add(meta.scope);
    }
  }
  return Array.from(origins).sort();
}

export function countActiveRulesForOrigin(enabled, ruleIds, rulesById, origin) {
  if (!enabled) return 0;
  let count = 0;
  for (const id of Array.isArray(ruleIds) ? ruleIds : []) {
    const meta = rulesById && rulesById[id];
    if (isRuleRunnable(meta) && ruleMatchesOrigin(meta, origin)) {
      count++;
    }
  }
  return count;
}
