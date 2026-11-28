'use strict';
// server/game/json.js — SQLite BLOB 里的 JSON 编解码（存档、快照、征战共用）

function encode(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }

// node:sqlite 的 BLOB 读回来是 Uint8Array（不是 Buffer）——统一成 Buffer 再解码，
// 否则 `String(blob)` 会得到 "123,34,..." 这种字节列表，JSON.parse 直接炸。
function toBuffer(blob) {
  if (blob == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(blob)) return blob;
  if (blob instanceof Uint8Array) return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (typeof blob === 'string') return Buffer.from(blob, 'utf8');
  return Buffer.from(String(blob), 'utf8');
}

function decode(blob) {
  return JSON.parse(toBuffer(blob).toString('utf8'));
}
function tryDecode(blob) {
  try { return decode(blob); } catch (_) { return null; }
}

module.exports = { encode, toBuffer, decode, tryDecode };
