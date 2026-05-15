// lamejs has broken CommonJS requires in Node — load bundled version via global
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const allJs = fs.readFileSync(path.join(path.dirname(require.resolve('lamejs/package.json')), 'lame.all.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(allJs + '\nthis.Mp3Encoder = lamejs.Mp3Encoder;', ctx);
const Mp3Encoder = ctx.Mp3Encoder;

function pcmToMp3(pcmBuffer, sampleRate = 24000, bitRate = 64) {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2
  );

  const encoder = new Mp3Encoder(1, sampleRate, bitRate);
  const blockSize = 1152;
  const mp3Parts = [];

  for (let i = 0; i < samples.length; i += blockSize) {
    const chunk = samples.subarray(i, i + blockSize);
    const mp3buf = encoder.encodeBuffer(chunk);
    if (mp3buf.length > 0) mp3Parts.push(Buffer.from(mp3buf));
  }

  const end = encoder.flush();
  if (end.length > 0) mp3Parts.push(Buffer.from(end));

  return Buffer.concat(mp3Parts);
}

module.exports = { pcmToMp3 };
