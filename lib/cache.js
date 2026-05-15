const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const CACHE_DIR = process.env.CACHE_DIR || path.join(os.homedir(), '.gemini-tts-cache');
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL || String(86400 * 7)) * 1000;
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '500');

const memCache = new Map();

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function normalizeText(text) {
  return text
    .normalize('NFKC')
    .replace(/\u00AD/g, '')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

function makeKey(text, voice, model) {
  return crypto.createHash('md5').update(`${normalizeText(text)}|${voice}|${model}`).digest('hex');
}

function filePath(key) {
  const sub = path.join(CACHE_DIR, key.slice(0, 2));
  try { fs.mkdirSync(sub, { recursive: true }); } catch {}
  return path.join(sub, key + '.pcm');
}

function get(key) {
  const e = memCache.get(key);
  if (e) {
    if (Date.now() - e.ts > CACHE_TTL_MS) { memCache.delete(key); }
    else { memCache.delete(key); memCache.set(key, e); return e.pcm; }
  }
  const fp = filePath(key);
  try {
    const stat = fs.statSync(fp);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) { fs.unlinkSync(fp); return null; }
    const pcm = fs.readFileSync(fp);
    if (memCache.size >= MAX_CACHE_ENTRIES) memCache.delete(memCache.keys().next().value);
    memCache.set(key, { pcm, ts: stat.mtimeMs });
    return pcm;
  } catch { return null; }
}

function set(key, pcm) {
  if (memCache.size >= MAX_CACHE_ENTRIES) memCache.delete(memCache.keys().next().value);
  memCache.set(key, { pcm, ts: Date.now() });
  const fp = filePath(key);
  fs.writeFile(fp, pcm, () => {});
}

function has(key) {
  if (memCache.has(key)) return true;
  try { fs.accessSync(filePath(key)); return true; } catch { return false; }
}

module.exports = { normalizeText, makeKey, get, set, has, CACHE_DIR };
