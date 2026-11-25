/* 把 MockPanel 扩展打成可分发的 zip（纯 Node 标准库，无第三方依赖）。
 *
 * 运行：
 *   node tools/package.js               # 输出 dist/mock-panel-<版本>.zip
 *   node tools/package.js --out x.zip   # 指定输出路径
 *
 * 采用白名单：只打包运行时文件（manifest.json、src/、icons/、vendor/），
 * tools/、文档、.gitignore 等一律不进包，避免误发布开发文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const INCLUDE = ['manifest.json', 'src', 'icons', 'vendor'];

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function dosDateTime(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  };
}

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      if (name === '.DS_Store') continue;
      walk(path.join(rel, name), out);
    }
  } else if (st.isFile()) {
    out.push(rel);
  }
}

function buildZip(files, now) {
  const { time, date } = dosDateTime(now);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(path.join(ROOT, file));
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const name = Buffer.from(file.split(path.sep).join('/'), 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat(parts.concat([cdBuf, eocd]));
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  if (outIdx !== -1 && !args[outIdx + 1]) {
    console.error('--out 后面需要跟一个输出路径');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  if (!manifest.version) {
    console.error('manifest.json 缺少 version，无法生成带版本号的包名');
    process.exit(1);
  }

  const files = [];
  for (const item of INCLUDE) walk(item, files);

  const out = path.resolve(outIdx !== -1
    ? args[outIdx + 1]
    : path.join(ROOT, 'dist', 'mock-panel-' + manifest.version + '.zip'));

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildZip(files, new Date()));

  const size = fs.statSync(out).size;
  console.log('打包完成 ✅ ' + out);
  console.log('版本 ' + manifest.version + '，' + files.length + ' 个文件，' + (size / 1024).toFixed(1) + ' KB');
  for (const f of files) console.log('  ' + f.split(path.sep).join('/'));
}

if (require.main === module) main();

module.exports = { buildZip };
