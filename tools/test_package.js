/* 验证 tools/package.js 的产物：zip 结构、白名单与内容完整性。
 * 运行：node tools/test_package.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); }
  else { failures++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

function readZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录第 ' + i + ' 项签名不对');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);

    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(name + ' 的本地文件头签名不对');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    if (data.length !== usize) throw new Error(name + ' 解压后长度不符');
    entries.set(name, data);

    p += 46 + nlen + elen + clen;
  }
  return entries;
}

console.log('\n场景：运行 tools/package.js 并校验产物');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const zipPath = path.join(ROOT, 'dist', 'mock-panel-' + manifest.version + '.zip');

const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'package.js')], { encoding: 'utf8' });
check('打包命令执行成功并提示完成', out.includes('打包完成'), out.trim().split('\n')[0]);
check('产物路径带 manifest 版本号', fs.existsSync(zipPath), zipPath);

const entries = readZip(fs.readFileSync(zipPath));
const names = Array.from(entries.keys()).sort();

function collectFiles(rel, out) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      if (name === '.DS_Store') continue;
      collectFiles(path.join(rel, name), out);
    }
  } else if (st.isFile()) {
    out.push(rel.split(path.sep).join('/'));
  }
}
const expected = ['manifest.json'];
for (const dir of ['src', 'icons', 'vendor']) collectFiles(dir, expected);
check('zip 内文件与白名单完全一致（共 ' + expected.length + ' 个）',
  JSON.stringify(names) === JSON.stringify(expected.sort()), JSON.stringify(names));

check('manifest.json 位于包根目录', entries.has('manifest.json'));
check('不含开发文件（tools/、AGENTS.md、README.md、.gitignore）',
  names.every((n) => !n.startsWith('tools/') && n !== 'AGENTS.md' && n !== 'README.md' && n !== '.gitignore'));

let intact = 0;
let mismatch = '';
for (const [name, data] of entries) {
  if (Buffer.compare(fs.readFileSync(path.join(ROOT, name)), data) === 0) intact++;
  else if (!mismatch) mismatch = name;
}
check('所有条目 round-trip 与磁盘内容一致', intact === entries.size, mismatch);
check('zip 大小非零', fs.statSync(zipPath).size > 0);

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
process.exit(failures === 0 ? 0 : 1);
