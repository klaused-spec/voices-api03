const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOOKS_DIR = path.join(__dirname, '..', 'books');
try { fs.mkdirSync(BOOKS_DIR, { recursive: true }); } catch {}

function bookDir(id) {
  const dir = path.join(BOOKS_DIR, id);
  try { fs.mkdirSync(path.join(dir, 'audio'), { recursive: true }); } catch {}
  return dir;
}

function manifestPath(id) {
  return path.join(bookDir(id), 'manifest.json');
}

function list() {
  try {
    const dirs = fs.readdirSync(BOOKS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
    const books = [];
    for (const d of dirs) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, d.name, 'manifest.json'), 'utf8'));
        books.push({
          id: m.id,
          title: m.title,
          voice: m.voice,
          totalChunks: m.totalChunks,
          generatedChunks: m.generatedChunks,
          status: m.status,
          createdAt: m.createdAt,
        });
      } catch {}
    }
    return books.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch { return []; }
}

function get(id) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(id), 'utf8'));
  } catch { return null; }
}

function create(title, voice, model, chunks) {
  const id = crypto.randomUUID();
  const manifest = {
    id,
    title,
    voice,
    model,
    createdAt: new Date().toISOString(),
    totalChunks: chunks.length,
    generatedChunks: 0,
    status: 'pending',
    chunks: chunks.map((text, i) => ({
      id: i + 1,
      text,
      audioFile: String(i + 1).padStart(4, '0') + '.mp3',
      generated: false,
    })),
  };
  bookDir(id);
  fs.writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2));
  return manifest;
}

function update(id, data) {
  const manifest = get(id);
  if (!manifest) return null;
  Object.assign(manifest, data);
  fs.writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2));
  return manifest;
}

function updateChunk(id, chunkId, data) {
  const manifest = get(id);
  if (!manifest) return null;
  const chunk = manifest.chunks.find(c => c.id === chunkId);
  if (!chunk) return null;
  Object.assign(chunk, data);
  manifest.generatedChunks = manifest.chunks.filter(c => c.generated).length;
  if (manifest.generatedChunks === manifest.totalChunks) manifest.status = 'ready';
  fs.writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2));
  return manifest;
}

function audioPath(id, chunkFile) {
  return path.join(bookDir(id), 'audio', chunkFile);
}

function remove(id) {
  const dir = path.join(BOOKS_DIR, id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

module.exports = { list, get, create, update, updateChunk, audioPath, remove, BOOKS_DIR };
