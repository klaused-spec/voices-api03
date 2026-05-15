const lamejs = require('lamejs');

function pcmToMp3(pcmBuffer, sampleRate = 24000, bitRate = 64) {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2
  );

  const encoder = new lamejs.Mp3Encoder(1, sampleRate, bitRate);
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
