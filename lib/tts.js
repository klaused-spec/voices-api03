const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocket = require('ws');
const cache = require('./cache');

const DEFAULT_VOICE = process.env.DEFAULT_VOICE || 'Kore';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gemini-2.5-flash-preview-tts';

const apiKeys = [];
if (process.env.GEMINI_API_KEY) apiKeys.push(process.env.GEMINI_API_KEY);
for (let i = 1; i <= 10; i++) {
  const k = process.env[`GEMINI_KEY_${i}`];
  if (k) apiKeys.push(k);
}
const keys = [...new Set(apiKeys)];

const agent = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30000,
  maxSockets: 20, maxFreeSockets: 5,
});

const FALLBACK_MODELS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-pro-preview-tts',
];

const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const edgeVoiceMap = {
  Kore: 'pt-BR-FranciscaNeural',
  Aoede: 'pt-BR-ThalitaNeural',
  Leda: 'pt-BR-LeticiaNeural',
  Zephyr: 'pt-BR-FranciscaNeural',
  Sulafat: 'pt-BR-ThalitaNeural',
  Puck: 'pt-BR-AntonioNeural',
  Charon: 'pt-BR-AntonioNeural',
  Fenrir: 'pt-BR-AntonioNeural',
  Orus: 'pt-BR-AntonioNeural',
  Enceladus: 'pt-BR-AntonioNeural',
};

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function synthesizeStream(text, voice, model, apiKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    );
    const payload = Buffer.from(JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    }), 'utf8');

    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      agent, timeout: 60000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => reject({ code: res.statusCode, body }));
        return;
      }
      const chunks = [];
      let sseBuf = '';

      res.on('data', (raw) => {
        sseBuf += raw.toString();
        const parts = sseBuf.split('\n\n');
        sseBuf = parts.pop();
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const b64 = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
              if (b64) chunks.push(Buffer.from(b64, 'base64'));
            } catch {}
          }
        }
      });

      res.on('end', () => {
        if (sseBuf.trim()) {
          for (const line of sseBuf.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const j = JSON.parse(line.slice(6).trim());
              const b64 = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
              if (b64) chunks.push(Buffer.from(b64, 'base64'));
            } catch {}
          }
        }
        if (chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject({ code: 502, body: 'No audio in response' });
      });
      res.on('error', e => reject({ code: 500, body: e.message }));
    });

    req.on('error', e => reject({ code: 500, body: e.message }));
    req.on('timeout', () => { req.destroy(); reject({ code: 504, body: 'Timeout' }); });
    req.write(payload);
    req.end();
  });
}

function synthesizeEdgeTTS(text, voice) {
  return new Promise((resolve, reject) => {
    const reqId = crypto.randomBytes(16).toString('hex');
    const edgeVoice = edgeVoiceMap[voice] || 'pt-BR-FranciscaNeural';
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TTS_TOKEN}&ConnectionId=${reqId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': 'chrome-extension://jdiccldimpdaibmpdmdber',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    });

    const chunks = [];
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; try { ws.close(); } catch {} reject({ code: 504, body: 'Edge TTS timeout' }); }
    }, 30000);

    ws.on('open', () => {
      ws.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"raw-24khz-16bit-mono-pcm"}}}}`);
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'><voice name='${edgeVoice}'><prosody rate='+0%' pitch='+0Hz'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary && Buffer.isBuffer(data)) {
        const headerLen = data.readUInt16BE(0);
        const pcm = data.slice(2 + headerLen);
        if (pcm.length > 0) chunks.push(pcm);
      } else {
        if (data.toString().includes('Path:turn.end')) {
          resolved = true; clearTimeout(timeout);
          try { ws.close(); } catch {}
          if (chunks.length > 0) resolve(Buffer.concat(chunks));
          else reject({ code: 502, body: 'Edge TTS: no audio' });
        }
      }
    });

    ws.on('error', (err) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject({ code: 500, body: err.message }); }
    });
    ws.on('close', () => {
      if (!resolved) {
        resolved = true; clearTimeout(timeout);
        if (chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject({ code: 502, body: 'Edge TTS: closed without audio' });
      }
    });
  });
}

async function tryModel(text, voice, model) {
  const start = hashCode(text) % keys.length;
  let lastErr = '';
  const preview = text.substring(0, 40);

  for (let retry = 0; retry <= 1; retry++) {
    let all429 = true;
    for (let i = 0; i < keys.length; i++) {
      const idx = (start + i) % keys.length;
      try {
        const pcm = await synthesizeStream(text, voice, model, keys[idx]);
        return pcm;
      } catch (err) {
        lastErr = err.body || err.message || String(err);
        console.error(`[tts] ${model} key${idx} retry${retry} err=${err.code}: ${(lastErr || '').substring(0, 80)} | "${preview}"`);
        if (err.code === 429) continue;
        if (err.code === 403) { all429 = false; continue; }
        all429 = false;
      }
    }
    if (all429 && retry < 1) {
      console.log(`[tts] All 429 on ${model}, waiting 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    } else break;
  }
  throw { code: 429, body: lastErr };
}

async function synthesize(text, voice, model) {
  const norm = cache.normalizeText(text);
  const effectiveModel = model || DEFAULT_MODEL;

  const key1 = cache.makeKey(text, voice, effectiveModel);
  const cached1 = cache.get(key1);
  if (cached1) return { pcm: cached1, model: effectiveModel, fromCache: true };

  for (const fb of [...FALLBACK_MODELS, 'edge-tts']) {
    if (fb === effectiveModel) continue;
    const key2 = cache.makeKey(text, voice, fb);
    const cached2 = cache.get(key2);
    if (cached2) return { pcm: cached2, model: fb, fromCache: true };
  }

  const modelsToTry = [effectiveModel, ...FALLBACK_MODELS.filter(m => m !== effectiveModel)];
  let pcm, usedModel;

  for (const m of modelsToTry) {
    try {
      pcm = await tryModel(text, voice, m);
      usedModel = m;
      break;
    } catch (err) {
      console.error(`[tts] Model ${m} failed, trying next...`);
    }
  }

  if (!pcm) {
    try {
      pcm = await synthesizeEdgeTTS(text, voice);
      usedModel = 'edge-tts';
    } catch (err) {
      throw new Error(`All models failed: ${err.body || err.message}`);
    }
  }

  cache.set(cache.makeKey(text, voice, usedModel), pcm);
  return { pcm, model: usedModel, fromCache: false };
}

const VOICES = [
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede',
  'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba',
  'Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat',
  'Vindemiatrix','Sadachbia','Sadaltager','Schedar','Zubenelgenubi',
  'Zubeneschamali','Achernar','Rasalgethi','Alnilam','Sirius',
];

module.exports = { synthesize, VOICES, DEFAULT_VOICE, DEFAULT_MODEL, keys };
