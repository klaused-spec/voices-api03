const pdfParse = require('pdf-parse');

async function extractText(pdfBuffer) {
  const data = await pdfParse(pdfBuffer);
  const text = data.text || '';
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.replace(/[ \t]+/g, ' ').trim())
    .filter(p => p.length > 0);

  return {
    text,
    paragraphs,
    pages: data.numpages,
    info: data.info,
  };
}

module.exports = { extractText };
