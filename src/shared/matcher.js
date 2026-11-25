/* 规则元信息规范化、匹配判定与抓包字段提取纯函数 */

import {
  COND_OPS,
  COND_SOURCES,
  MAX_BODY_CHARS,
  METHODS,
  URL_OPS
} from './constants.js';

const ROUTING_KEYS = new Set([
  'operationname',
  'action',
  'method',
  'service',
  'servicekey',
  'cmd',
  'type',
  'op',
  'event'
]);

const NOISE_HEADERS = new Set([
  'accept-encoding',
  'accept-language',
  'connection',
  'content-length',
  'host',
  'origin',
  'pragma',
  'cache-control',
  'referer',
  'user-agent',
  'cookie',
  'dnt',
  'upgrade-insecure-requests'
]);

const LOW_PRIORITY_HEADERS = new Set([
  'accept',
  'content-type'
]);

export function makeRuleId() {
  const rand = Math.floor(Math.random() * 0x100000).toString(36).padStart(4, '0').slice(0, 4);
  return `r_${Date.now().toString(36)}_${rand}`;
}

export function extractOrigin(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url));
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin && u.origin !== 'null') {
      return u.origin;
    }
  } catch { /* ignore */ }
  return '';
}

export function normalizeScope(scope) {
  const s = String(scope ?? '').trim();
  if (!s || s === '*') return '*';
  return extractOrigin(s);
}

export function isValidRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeConditions(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const source = COND_SOURCES.includes(c.source) ? c.source : '';
    if (!source) continue;

    const path = String(c.path ?? '').trim();
    if (!path) continue;

    const op = COND_OPS.includes(c.op) ? c.op : 'equals';
    const value = op === 'exists' ? '' : String(c.value ?? '');
    if (op !== 'exists' && value === '') continue;
    if (op === 'regex' && !isValidRegex(value)) continue;

    out.push({ source, path, op, value });
  }
  return out;
}

export function sanitizeHeaders(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const h of list) {
    if (!h || typeof h !== 'object') continue;
    const name = String(h.name ?? '').replace(/[\r\n]/g, '').trim();
    if (!name) continue;
    const value = String(h.value ?? '').replace(/[\r\n]+/g, ' ').trim();
    out.push({ name, value });
  }
  return out;
}

export function sanitizeRuleMeta(raw, fallbackId) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id || fallbackId || makeRuleId()).trim() || makeRuleId();
  const name = String(src.name ?? '').trim() || '未命名规则';
  const scope = normalizeScope(src.scope) || '*';

  const rawMethod = String(src.method || 'ANY').trim().toUpperCase();
  const method = METHODS.includes(rawMethod) ? rawMethod : 'ANY';
  const urlOp = URL_OPS.includes(src.urlOp) ? src.urlOp : 'contains';
  const urlPattern = String(src.urlPattern ?? '').trim();

  const statusNum = Number.parseInt(src.status, 10);
  const status = (Number.isFinite(statusNum) && statusNum >= 100 && statusNum <= 599) ? statusNum : 200;

  const delayNum = Number.parseInt(src.delayMs, 10);
  const delayMs = (Number.isFinite(delayNum) && delayNum >= 0) ? Math.min(60000, delayNum) : 0;

  const contentType = String(src.contentType ?? '').trim() || 'application/json;charset=utf-8';
  const updatedNum = Number(src.updatedAt);
  const updatedAt = (Number.isFinite(updatedNum) && updatedNum > 0) ? updatedNum : Date.now();

  return {
    id,
    name,
    scope,
    method,
    urlOp,
    urlPattern,
    conditions: sanitizeConditions(src.conditions),
    status,
    delayMs,
    responseHeaders: sanitizeHeaders(src.responseHeaders),
    contentType,
    enabled: src.enabled !== false,
    updatedAt
  };
}

export function isRuleRunnable(meta) {
  if (!meta || meta.enabled === false) return false;
  const pat = typeof meta.urlPattern === 'string' ? meta.urlPattern.trim() : '';
  if (!pat) return false;
  if (meta.urlOp === 'regex' && !isValidRegex(pat)) return false;
  return true;
}

export function ruleMatchesOrigin(meta, origin) {
  if (!meta) return false;
  if (meta.scope === '*') return true;
  return Boolean(origin && meta.scope === origin);
}

function isNoiseHeader(lowerName) {
  return NOISE_HEADERS.has(lowerName) ||
    lowerName.startsWith('sec-') ||
    lowerName.startsWith('proxy-');
}

function flattenJsonLeaves(node, prefix, depth, out, limit) {
  if (out.length >= limit || node == null) return;

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    if (!prefix) return;
    const strVal = String(node);
    const leafKey = prefix.split('.').pop().toLowerCase();
    let priority = 20;
    if (ROUTING_KEYS.has(leafKey)) {
      priority = 100;
    } else if (depth <= 1) {
      priority = 50;
    } else {
      priority = Math.max(10, 42 - depth * 4);
    }
    out.push({ source: 'body', path: prefix, value: strVal, priority });
    return;
  }

  if (typeof node !== 'object' || depth >= 6) return;

  if (Array.isArray(node)) {
    const cap = Math.min(node.length, 10);
    for (let i = 0; i < cap && out.length < limit; i++) {
      const nextPath = prefix ? `${prefix}.${i}` : String(i);
      flattenJsonLeaves(node[i], nextPath, depth + 1, out, limit);
    }
    return;
  }

  for (const key of Object.keys(node)) {
    if (out.length >= limit) break;
    const nextPath = prefix ? `${prefix}.${key}` : key;
    flattenJsonLeaves(node[key], nextPath, depth + 1, out, limit);
  }
}

/**
 * 从一条抓包记录中提取可一键点选的匹配条件候选项
 * 返回按优先级排序的 [{ source, path, value, priority }]
 */
export function extractSelectableFields(capture) {
  if (!capture || typeof capture !== 'object') return [];
  const items = [];
  const seen = new Set();

  const pushUnique = (item) => {
    if (!item.path) return;
    const key = `${item.source}\u0000${item.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  // 1. Query 参数
  if (capture.url) {
    try {
      const u = new URL(String(capture.url), 'http://localhost');
      for (const [k, v] of u.searchParams.entries()) {
        pushUnique({ source: 'query', path: k, value: v, priority: 70 });
      }
    } catch { /* ignore */ }
  }

  // 2. 请求头（业务头优先，过滤纯浏览器噪声头）
  let reqContentType = '';
  const headers = capture.reqHeaders;
  if (headers && typeof headers === 'object') {
    const entries = Array.isArray(headers)
      ? headers.map((h) => [h && h.name, h && h.value])
      : Object.entries(headers);
    for (const [rawName, rawVal] of entries) {
      const name = String(rawName ?? '').trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      const val = String(rawVal ?? '');
      if (lower === 'content-type') reqContentType = val.toLowerCase();
      if (isNoiseHeader(lower)) continue;
      const priority = LOW_PRIORITY_HEADERS.has(lower) ? 15 : 60;
      pushUnique({ source: 'header', path: lower, value: val, priority });
    }
  }

  // 3. 请求体（JSON 点号展平 / x-www-form-urlencoded）
  const bodyText = typeof capture.reqBody === 'string' ? capture.reqBody : '';
  if (bodyText && bodyText.length <= MAX_BODY_CHARS) {
    let parsedJson = null;
    try {
      const candidate = JSON.parse(bodyText);
      if (candidate && typeof candidate === 'object') parsedJson = candidate;
    } catch { /* ignore */ }

    const bodyItems = [];
    if (parsedJson) {
      flattenJsonLeaves(parsedJson, '', 0, bodyItems, 40);
    } else {
      const trimmed = bodyText.trim();
      const looksForm = reqContentType.includes('x-www-form-urlencoded') ||
        (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('<') && trimmed.includes('='));
      if (looksForm) {
        try {
          const sp = new URLSearchParams(trimmed);
          for (const [k, v] of sp.entries()) {
            if (bodyItems.length >= 40) break;
            const priority = ROUTING_KEYS.has(k.toLowerCase()) ? 100 : 45;
            bodyItems.push({ source: 'body', path: k, value: v, priority });
          }
        } catch { /* ignore */ }
      }
    }
    for (const item of bodyItems) pushUnique(item);
  }

  items.sort((a, b) => b.priority - a.priority);
  return items;
}
