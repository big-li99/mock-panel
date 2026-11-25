/* 使用 Chrome Web Store API v2 自动上传发布扩展包（纯 Node 零第三方依赖）。
 *
 * 用法：
 *   node tools/publish_cws.mjs [--check-optional] <zipPath>
 *
 * 必需环境变量：
 *   CWS_PUBLISHER_ID     Chrome Web Store Publisher ID
 *   CWS_EXTENSION_ID     扩展 ID（32 位字符）
 *   CWS_CLIENT_ID        Google OAuth2 Client ID
 *   CWS_CLIENT_SECRET    Google OAuth2 Client Secret
 *   CWS_REFRESH_TOKEN    Google OAuth2 Refresh Token
 *
 * 可选环境变量：
 *   CWS_PUBLISH_TYPE     如 DEFAULT_PUBLISH 或 STAGED_PUBLISH
 *   CWS_SKIP_PUBLISH     设为 'true' 时只上传包，不提交审核
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_ENV_KEYS = [
  'CWS_PUBLISHER_ID',
  'CWS_EXTENSION_ID',
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN'
];

const SUCCESS_STATES = new Set(['SUCCEEDED', 'SUCCESS', 'UPLOAD_STATE_SUCCEEDED']);
const FAILURE_STATES = new Set(['FAILED', 'FAILURE', 'NOT_FOUND', 'UPLOAD_STATE_FAILED']);

export function readConfig(env = process.env) {
  const missing = REQUIRED_ENV_KEYS.filter((k) => !env[k] || !String(env[k]).trim());
  return {
    publisherId: String(env.CWS_PUBLISHER_ID || '').trim(),
    extensionId: String(env.CWS_EXTENSION_ID || '').trim(),
    clientId: String(env.CWS_CLIENT_ID || '').trim(),
    clientSecret: String(env.CWS_CLIENT_SECRET || '').trim(),
    refreshToken: String(env.CWS_REFRESH_TOKEN || '').trim(),
    publishType: String(env.CWS_PUBLISH_TYPE || '').trim(),
    skipPublish: String(env.CWS_SKIP_PUBLISH || '').trim().toLowerCase() === 'true',
    missing
  };
}

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function exchangeAccessToken(cfg, fetchImpl = globalThis.fetch) {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await readJsonSafe(res);
  if (!res.ok || !data.access_token) {
    throw new Error(`获取 OAuth access_token 失败 (${res.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

export async function uploadPackage(cfg, accessToken, zipBuffer, fetchImpl = globalThis.fetch) {
  const url = `https://chromewebstore.googleapis.com/upload/v2/publishers/${encodeURIComponent(cfg.publisherId)}/items/${encodeURIComponent(cfg.extensionId)}:upload`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip'
    },
    body: zipBuffer
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(`上传扩展包失败 (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export async function waitForUpload(cfg, accessToken, fetchImpl = globalThis.fetch, opts = {}) {
  const {
    initialResult = {},
    intervalMs = 5000,
    maxAttempts = 24,
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms))
  } = opts;

  const initialState = initialResult.uploadState || initialResult.lastAsyncUploadState || '';
  if (SUCCESS_STATES.has(initialState)) return initialResult;
  if (FAILURE_STATES.has(initialState)) {
    throw new Error(`上传处理失败 (${initialState}): ${JSON.stringify(initialResult)}`);
  }
  if (!initialState || initialState !== 'IN_PROGRESS') {
    return initialResult;
  }

  const statusUrl = `https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(cfg.publisherId)}/items/${encodeURIComponent(cfg.extensionId)}:fetchStatus`;
  for (let i = 0; i < maxAttempts; i++) {
    if (intervalMs > 0) await sleepImpl(intervalMs);
    const res = await fetchImpl(statusUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      throw new Error(`查询上传状态失败 (${res.status}): ${JSON.stringify(data)}`);
    }
    const state = data.lastAsyncUploadState || data.uploadState || '';
    if (SUCCESS_STATES.has(state)) return data;
    if (FAILURE_STATES.has(state)) {
      throw new Error(`上传处理失败 (${state}): ${JSON.stringify(data)}`);
    }
  }
  throw new Error(`等待 Chrome Web Store 上传处理超时（共轮询 ${maxAttempts} 次）`);
}

export async function publishItem(cfg, accessToken, fetchImpl = globalThis.fetch) {
  const url = `https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(cfg.publisherId)}/items/${encodeURIComponent(cfg.extensionId)}:publish`;
  const payload = cfg.publishType ? { publishType: cfg.publishType } : {};
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(`提交 Chrome Web Store 审核失败 (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export async function runPublish(args, env = process.env, fetchImpl = globalThis.fetch, opts = {}) {
  const checkOptional = args.includes('--check-optional');
  const zipArg = args.find((a) => a && !a.startsWith('-'));
  const cfg = readConfig(env);

  if (cfg.missing.length > 0) {
    const msg = `缺少 Chrome Web Store 凭据 (${cfg.missing.join(', ')})`;
    if (checkOptional) {
      console.log(`跳过 Chrome Web Store 自动发布：${msg}`);
      return { skipped: true, missing: cfg.missing };
    }
    throw new Error(msg);
  }

  if (!zipArg) {
    throw new Error('请提供要上传的 .zip 文件路径');
  }
  const zipPath = path.resolve(zipArg);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`找不到发布包文件: ${zipPath}`);
  }

  const zipBuffer = fs.readFileSync(zipPath);
  const accessToken = await exchangeAccessToken(cfg, fetchImpl);
  const uploadResult = await uploadPackage(cfg, accessToken, zipBuffer, fetchImpl);
  const finalStatus = await waitForUpload(cfg, accessToken, fetchImpl, {
    ...opts,
    initialResult: uploadResult
  });

  let publishResult = null;
  if (!cfg.skipPublish) {
    publishResult = await publishItem(cfg, accessToken, fetchImpl);
  }

  return {
    skipped: false,
    uploadResult,
    finalStatus,
    publishResult
  };
}

const isCliEntry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCliEntry) {
  runPublish(process.argv.slice(2))
    .then((res) => {
      if (!res.skipped) {
        console.log('Chrome Web Store 上传完成 ✅', JSON.stringify({
          uploadState: res.finalStatus.lastAsyncUploadState || res.finalStatus.uploadState || 'OK',
          published: Boolean(res.publishResult)
        }));
      }
    })
    .catch((err) => {
      console.error('Chrome Web Store 发布失败 ❌', err && err.message ? err.message : err);
      process.exit(1);
    });
}
