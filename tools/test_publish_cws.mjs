/* 验证 tools/publish_cws.mjs：可选跳过、OAuth 换票、异步上传轮询与发布流程。
 * 运行：node tools/test_publish_cws.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exchangeAccessToken,
  publishItem,
  readConfig,
  runPublish,
  uploadPackage,
  waitForUpload
} from './publish_cws.mjs';

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failures++;
    console.log('  ✗ ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function mockRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

const BASE_ENV = {
  CWS_PUBLISHER_ID: 'pub-123',
  CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
  CWS_CLIENT_ID: 'client-id',
  CWS_CLIENT_SECRET: 'client-secret',
  CWS_REFRESH_TOKEN: 'refresh-token'
};

async function runTests() {
  const tmpZip = path.join(os.tmpdir(), `mock-panel-test-${Date.now()}.zip`);
  fs.writeFileSync(tmpZip, Buffer.from('PK_MOCK_ZIP'));

  try {
    console.log('\n场景：环境变量校验与 --check-optional 降级');
    const partialCfg = readConfig({ CWS_PUBLISHER_ID: 'pub-123' });
    check('缺失凭据时列出所有缺失变量名', partialCfg.missing.length === 4 && partialCfg.missing.includes('CWS_EXTENSION_ID'));

    const skipRes = await runPublish(['--check-optional', tmpZip], {});
    check('--check-optional 缺凭据时正常跳过而不抛错', skipRes.skipped === true && skipRes.missing.length === 5);

    let strictErr = '';
    try {
      await runPublish([tmpZip], {});
    } catch (err) {
      strictErr = err.message;
    }
    check('非 --check-optional 模式缺凭据时抛出明确错误', strictErr.includes('CWS_PUBLISHER_ID'));

    console.log('\n场景：OAuth 2.0 Token 换取与错误处理');
    let tokenCall = null;
    const token = await exchangeAccessToken(readConfig(BASE_ENV), async (url, init) => {
      tokenCall = { url, init };
      return mockRes(200, { access_token: 'tok-abc' });
    });
    check('OAuth 接口地址与 refresh_token 参数正确',
      token === 'tok-abc' &&
      tokenCall.url === 'https://oauth2.googleapis.com/token' &&
      tokenCall.init.body.includes('grant_type=refresh_token') &&
      tokenCall.init.body.includes('refresh_token=refresh-token'));

    let tokenFail = '';
    try {
      await exchangeAccessToken(readConfig(BASE_ENV), async () => mockRes(401, { error: 'invalid_grant' }));
    } catch (err) {
      tokenFail = err.message;
    }
    check('OAuth 返回非 200 时抛出包含状态码的错误', tokenFail.includes('401'));

    console.log('\n场景：直接 SUCCEEDED 上传并触发 :publish');
    const calls = [];
    const directRes = await runPublish([tmpZip], BASE_ENV, async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (url.includes('oauth2.googleapis.com')) return mockRes(200, { access_token: 'tok-1' });
      if (url.endsWith(':upload')) return mockRes(200, { uploadState: 'SUCCEEDED' });
      if (url.endsWith(':publish')) return mockRes(200, { state: 'PENDING_REVIEW' });
      return mockRes(404, {});
    }, { intervalMs: 0 });
    check('upload 直接成功时依次调用 token -> :upload -> :publish',
      calls.length === 3 &&
      calls[1].url === 'https://chromewebstore.googleapis.com/upload/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:upload' &&
      calls[2].url === 'https://chromewebstore.googleapis.com/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:publish' &&
      directRes.publishResult.state === 'PENDING_REVIEW');

    console.log('\n场景：异步 IN_PROGRESS 上传轮询直至成功');
    let pollCount = 0;
    const asyncCalls = [];
    const asyncRes = await runPublish([tmpZip], { ...BASE_ENV, CWS_PUBLISH_TYPE: 'STAGED_PUBLISH' }, async (url, init) => {
      asyncCalls.push({ url, body: init.body });
      if (url.includes('oauth2.googleapis.com')) return mockRes(200, { access_token: 'tok-2' });
      if (url.endsWith(':upload')) return mockRes(200, { uploadState: 'IN_PROGRESS' });
      if (url.endsWith(':fetchStatus')) {
        pollCount++;
        return mockRes(200, {
          lastAsyncUploadState: pollCount >= 2 ? 'SUCCEEDED' : 'IN_PROGRESS'
        });
      }
      if (url.endsWith(':publish')) return mockRes(200, { state: 'STAGED' });
      return mockRes(404, {});
    }, { intervalMs: 0, maxAttempts: 5, sleepImpl: async () => {} });
    check('IN_PROGRESS 时轮询 :fetchStatus 直至 SUCCEEDED 并传递 publishType',
      pollCount === 2 &&
      asyncRes.finalStatus.lastAsyncUploadState === 'SUCCEEDED' &&
      JSON.parse(asyncCalls[asyncCalls.length - 1].body).publishType === 'STAGED_PUBLISH');

    console.log('\n场景：上传处理失败中断与 CWS_SKIP_PUBLISH');
    let failPublishCalled = false;
    let failMsg = '';
    try {
      await runPublish([tmpZip], BASE_ENV, async (url) => {
        if (url.includes('oauth2.googleapis.com')) return mockRes(200, { access_token: 'tok-3' });
        if (url.endsWith(':upload')) return mockRes(200, { uploadState: 'IN_PROGRESS' });
        if (url.endsWith(':fetchStatus')) return mockRes(200, { lastAsyncUploadState: 'FAILED' });
        if (url.endsWith(':publish')) failPublishCalled = true;
        return mockRes(404, {});
      }, { intervalMs: 0, maxAttempts: 3, sleepImpl: async () => {} });
    } catch (err) {
      failMsg = err.message;
    }
    check('fetchStatus 返回 FAILED 时中断且不触发 :publish', failMsg.includes('FAILED') && !failPublishCalled);

    let skipPubCalled = false;
    const draftRes = await runPublish([tmpZip], { ...BASE_ENV, CWS_SKIP_PUBLISH: 'true' }, async (url) => {
      if (url.includes('oauth2.googleapis.com')) return mockRes(200, { access_token: 'tok-4' });
      if (url.endsWith(':upload')) return mockRes(200, { uploadState: 'SUCCEEDED' });
      if (url.endsWith(':publish')) skipPubCalled = true;
      return mockRes(404, {});
    }, { intervalMs: 0 });
    check('CWS_SKIP_PUBLISH=true 时只上传不调用 :publish', !skipPubCalled && draftRes.publishResult === null);

    // 单独验证导出函数 uploadPackage / waitForUpload / publishItem 可直接调用
    const up = await uploadPackage(readConfig(BASE_ENV), 't', Buffer.from('x'), async () => mockRes(200, { uploadState: 'SUCCEEDED' }));
    const wt = await waitForUpload(readConfig(BASE_ENV), 't', async () => mockRes(200, {}), { initialResult: up });
    const pb = await publishItem(readConfig(BASE_ENV), 't', async () => mockRes(200, { ok: true }));
    check('导出的uploadPackage / waitForUpload / publishItem 独立调用正常', wt.uploadState === 'SUCCEEDED' && pb.ok === true);
  } finally {
    fs.rmSync(tmpZip, { force: true });
  }

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
  process.exit(failures === 0 ? 0 : 1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
