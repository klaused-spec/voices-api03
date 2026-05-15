require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');
const tts = require('./lib/tts');
const pdf = require('./lib/pdf');
const mp3 = require('./lib/mp3');
const books = require('./lib/books');
const cache = require('./lib/cache');

const PORT = parseInt(process.env.PORT || '3100');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const bufs = [];
    req.on('data', c => bufs.push(c));
    req.on('end', () => resolve(Buffer.concat(bufs)));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parsePdfUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });
    const bufs = [];
    let filename = '';
    bb.on('file', (name, file, info) => {
      filename = info.filename || 'upload.pdf';
      file.on('data', d => bufs.push(d));
    });
    bb.on('close', () => resolve({ buffer: Buffer.concat(bufs), filename }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

const activeJobs = new Map();

async function generateBook(bookId) {
  const manifest = books.get(bookId);
  if (!manifest) return;

  books.update(bookId, { status: 'generating' });
  const concurrency = 2;
  const queue = manifest.chunks.filter(c => !c.generated).map(c => c.id);
  let errors = 0;

  const chunkStatus = {};
  manifest.chunks.forEach(c => { chunkStatus[c.id] = c.generated ? 'done' : 'pending'; });
  const progress = { done: manifest.generatedChunks, total: manifest.totalChunks, errors: 0, chunkStatus };
  activeJobs.set(bookId, progress);

  async function worker() {
    while (queue.length > 0) {
      const chunkId = queue.shift();
      const chunk = manifest.chunks.find(c => c.id === chunkId);
      if (!chunk) continue;

      try {
        chunkStatus[chunkId] = 'generating';
        const result = await tts.synthesize(chunk.text, manifest.voice, manifest.model);
        const mp3Buf = mp3.pcmToMp3(result.pcm);
        const audioFile = chunk.audioFile;
        fs.writeFileSync(books.audioPath(bookId, audioFile), mp3Buf);
        books.updateChunk(bookId, chunkId, { generated: true });
        chunkStatus[chunkId] = 'done';
        progress.done++;
      } catch (err) {
        chunkStatus[chunkId] = 'error';
        progress.errors++;
        errors++;
        console.error(`[gen] book=${bookId} chunk=${chunkId} err: ${err.message || err}`);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const final = books.get(bookId);
  if (final && final.generatedChunks === final.totalChunks) {
    books.update(bookId, { status: 'ready' });
  } else if (errors > 0) {
    books.update(bookId, { status: 'error' });
  }
  activeJobs.delete(bookId);
}

function serveStatic(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // Static files
  if (req.method === 'GET' && (p === '/' || p === '/ui')) {
    return serveStatic(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p.startsWith('/sw.js')) {
    return serveStatic(res, path.join(__dirname, 'public', 'sw.js'), 'application/javascript');
  }
  if (req.method === 'GET' && p === '/manifest.json') {
    return serveStatic(res, path.join(__dirname, 'public', 'manifest.json'), 'application/json');
  }

  // Health
  if (req.method === 'GET' && p === '/health') {
    return json(res, 200, { status: 'ok', keys: tts.keys.length, books: books.list().length });
  }

  // Voices
  if (req.method === 'GET' && p === '/v1/voices') {
    return json(res, 200, { voices: tts.VOICES.map(v => ({ name: v, voice_id: v })) });
  }

  // Auth check for API routes
  if (AUTH_TOKEN && p.startsWith('/api/')) {
    const hdr = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const qry = url.searchParams.get('token') || '';
    if (hdr !== AUTH_TOKEN && qry !== AUTH_TOKEN) {
      return json(res, 401, { error: 'Token inválido' });
    }
  }

  try {
    // PDF Upload
    if (req.method === 'POST' && p === '/api/upload-pdf') {
      const { buffer, filename } = await parsePdfUpload(req);
      const result = await pdf.extractText(buffer);
      return json(res, 200, {
        filename,
        pages: result.pages,
        paragraphs: result.paragraphs,
        totalParagraphs: result.paragraphs.length,
      });
    }

    // List books
    if (req.method === 'GET' && p === '/api/books') {
      return json(res, 200, { books: books.list() });
    }

    // Create book
    if (req.method === 'POST' && p === '/api/books') {
      const body = JSON.parse((await readBody(req)).toString());
      const { title, voice, model, chunks } = body;
      if (!title || !chunks || !chunks.length) {
        return json(res, 400, { error: 'title and chunks required' });
      }
      const manifest = books.create(
        title,
        voice || tts.DEFAULT_VOICE,
        model || tts.DEFAULT_MODEL,
        chunks
      );
      return json(res, 201, manifest);
    }

    // Book routes: /api/books/:id[/...]
    const bookMatch = p.match(/^\/api\/books\/([^/]+)(\/.*)?$/);
    if (bookMatch) {
      const id = bookMatch[1];
      const sub = bookMatch[2] || '';

      // Get book
      if (req.method === 'GET' && sub === '') {
        const manifest = books.get(id);
        if (!manifest) return json(res, 404, { error: 'Book not found' });
        return json(res, 200, manifest);
      }

      // Delete book
      if (req.method === 'DELETE' && sub === '') {
        books.remove(id);
        return json(res, 200, { ok: true });
      }

      // Generate
      if (req.method === 'POST' && sub === '/generate') {
        const manifest = books.get(id);
        if (!manifest) return json(res, 404, { error: 'Book not found' });
        if (activeJobs.has(id)) return json(res, 409, { error: 'Already generating' });
        generateBook(id);
        return json(res, 202, { status: 'generating' });
      }

      // Progress (SSE)
      if (req.method === 'GET' && sub === '/progress') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const interval = setInterval(() => {
          const manifest = books.get(id);
          if (!manifest) { clearInterval(interval); res.end(); return; }
          const progress = activeJobs.get(id) || {
            done: manifest.generatedChunks,
            total: manifest.totalChunks,
            errors: 0,
            chunkStatus: null,
          };
          const cs = progress.chunkStatus ? manifest.chunks.map(c => progress.chunkStatus[c.id] || (c.generated ? 'done' : 'pending')) : manifest.chunks.map(c => c.generated ? 'done' : 'pending');
          res.write(`data: ${JSON.stringify({ done: progress.done, total: progress.total, errors: progress.errors, status: manifest.status, cs })}\n\n`);
          if (manifest.status === 'ready' || manifest.status === 'error') {
            clearInterval(interval);
            setTimeout(() => res.end(), 500);
          }
        }, 1000);

        req.on('close', () => clearInterval(interval));
        return;
      }

      // Audio file
      const audioMatch = sub.match(/^\/audio\/(.+\.mp3)$/);
      if (req.method === 'GET' && audioMatch) {
        const filePath = books.audioPath(id, audioMatch[1]);
        try {
          const stat = fs.statSync(filePath);
          const range = req.headers.range;
          if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
              'Content-Type': 'audio/mpeg',
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
          } else {
            res.writeHead(200, {
              'Content-Type': 'audio/mpeg',
              'Content-Length': stat.size,
              'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(filePath).pipe(res);
          }
          return;
        } catch {
          return json(res, 404, { error: 'Audio not found' });
        }
      }

      // Update book (for editing chunks)
      if (req.method === 'PUT' && sub === '') {
        const body = JSON.parse((await readBody(req)).toString());
        const updated = books.update(id, body);
        if (!updated) return json(res, 404, { error: 'Book not found' });
        return json(res, 200, updated);
      }
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`[init] Audiobook Studio em http://localhost:${PORT}`);
  console.log(`[init] ${tts.keys.length} API key(s) | Cache: ${cache.CACHE_DIR}`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => { server.close(); process.exit(0); });
