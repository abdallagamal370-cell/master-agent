// Text extraction from course files.
// Returns pages as: [{ n, title, text, notes }] where n is the 1-based page/slide number.

import path from 'node:path';
import JSZip from 'jszip';
import { extractText, getDocumentProxy } from 'unpdf';

export const SUPPORTED = ['pdf', 'pptx'];

export class ExtractError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function cleanText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/(\S)[ \t]+/g, '$1 ') // collapse inner whitespace, keep leading indentation (bullet levels)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\s+$/g, '');
}

// ---------- Arabic / RTL repair for PDFs ----------
//
// Many PDF generators store Arabic in a different order than pdf.js expects, so the extracted
// text comes out reversed ("ليغشتلا مظن ميهافم" instead of "مفاهيم نظم التشغيل").
// We detect this per document with simple linguistic signals and re-apply bidi reordering
// (which is its own inverse for these cases). Presentation forms (U+FB50–U+FEFF) are normalized.

export const EXTRACT_VERSION = 2;

const AR = '\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFC';
const AR_LETTER = new RegExp(`[${AR}]`, 'g');
const AR_WORD = new RegExp(`[${AR}]+`, 'g');
// A run of Arabic text (may contain spaces, digits and punctuation between Arabic letters).
const AR_RUN = new RegExp(`[${AR}](?:[${AR}\\s\\d\\u0660-\\u0669.,:;!?\\u060C\\u061B()\\[\\]{}«»"'\\-\\u2013\\u2014/]*[${AR}])?`, 'g');
// A run of left-to-right text inside an RTL line (Latin words, numbers).
const LTR_RUN = /[A-Za-z0-9\u00C0-\u024F\u0660-\u0669](?:[A-Za-z0-9\u00C0-\u024F\u0660-\u0669\s.,:;'"\-_/+#&%=*]*[A-Za-z0-9\u00C0-\u024F\u0660-\u0669])?/g;
const NUM_RUN = /[\d\u0660-\u0669]+(?:[.,:/][\d\u0660-\u0669]+)*/g;
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '«': '»', '»': '«', '<': '>', '>': '<' };

const COMMON = ['في', 'من', 'على', 'إلى', 'الى', 'عن', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'مع', 'كل', 'ذلك', 'بين', 'عند', 'كان', 'وهو', 'وهي', 'أو'];
const COMMON_SET = new Set(COMMON);
const reverseStr = (s) => [...s].reverse().join('');
const COMMON_REVERSED = new Set(COMMON.map(reverseStr));
const mirror = (s) => s.replace(/[()[\]{}«»<>]/g, (c) => MIRROR[c]);

/** Positive score => Arabic looks reversed. */
export function arabicReversalScore(text) {
  let normal = 0;
  let reversed = 0;
  for (const raw of String(text).match(AR_WORD) || []) {
    const w = raw.normalize('NFKC');
    if (w.length > 3 && w.startsWith('ال')) normal++;
    if (w.length > 3 && w.endsWith('لا')) reversed++;
    if (w.length > 1 && /[ةى]$/.test(w)) normal++;
    if (w.length > 1 && /^[ةى]/.test(w)) reversed++;
    if (COMMON_SET.has(w)) normal++;
    if (COMMON_REVERSED.has(w)) reversed++;
  }
  return reversed - normal;
}

/** Re-apply bidi reordering to one line. */
export function reorderLine(line) {
  const arCount = (line.match(AR_LETTER) || []).length;
  if (!arCount) return line;
  const [, lead, body, trail] = line.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const latCount = (body.match(/[A-Za-z]/g) || []).length;
  let out;
  if (arCount > latCount) {
    // Mostly Arabic line: reverse the whole line, then restore the inner order of LTR runs.
    out = mirror(reverseStr(body)).replace(LTR_RUN, reverseStr);
  } else {
    // Mostly LTR line with embedded Arabic: reverse each Arabic run, keep numbers LTR.
    out = body.replace(AR_RUN, (run) => mirror(reverseStr(run)).replace(NUM_RUN, reverseStr));
  }
  return lead + out + trail;
}

const normalizeArabicForms = (s) => s.replace(/[\uFB50-\uFDFF\uFE70-\uFEFC]+/g, (m) => m.normalize('NFKC'));

/** Fix reversed Arabic (decided once per document) and normalize presentation forms. */
export function repairArabic(pages) {
  const all = pages.map((p) => `${p.text}\n${p.notes || ''}`).join('\n');
  if (!AR_LETTER.test(all)) return pages;
  AR_LETTER.lastIndex = 0;
  const reversed = arabicReversalScore(all) > 0;
  const fix = (s) => {
    if (!s) return s;
    const t = reversed ? s.split('\n').map(reorderLine).join('\n') : s;
    return normalizeArabicForms(t);
  };
  return pages.map((p) => ({ ...p, title: fix(p.title), text: fix(p.text), notes: fix(p.notes) }));
}

// ---------- PDF ----------

export async function extractPdf(buffer) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    throw new ExtractError(`Could not read PDF: ${err.message}`);
  }
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((t, i) => ({
    n: i + 1,
    title: '',
    text: cleanText(t),
    notes: '',
  }));
  await pdf.destroy?.();
  return repairArabic(pages);
}

// ---------- PPTX ----------

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** Extract paragraphs (one line each) from a chunk of DrawingML XML. */
function paragraphs(xml) {
  const out = [];
  for (const p of xml.split(/<\/a:p>/)) {
    const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\s*\/>/g)].map((m) =>
      m[0].startsWith('<a:br') ? '\n' : decodeXml(m[1])
    );
    const line = runs.join('').trim();
    if (line) {
      const level = Number(attr(p.match(/<a:pPr\b[^>]*>/)?.[0] || '', 'lvl') || 0);
      out.push(`${'  '.repeat(level)}${line}`);
    }
  }
  return out;
}

function shapes(xml) {
  return xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) || [];
}

function parseSlideXml(xml) {
  let title = '';
  for (const sp of shapes(xml)) {
    if (/<p:ph\b[^>]*type="(title|ctrTitle)"/.test(sp)) {
      title = paragraphs(sp).join(' ').trim();
      break;
    }
  }
  return { title: cleanText(title), text: cleanText(paragraphs(xml).join('\n')) };
}

function parseNotesXml(xml) {
  const lines = [];
  for (const sp of shapes(xml)) {
    if (/<p:ph\b[^>]*type="(sldNum|sldImg|hdr|ftr|dt)"/.test(sp)) continue;
    lines.push(...paragraphs(sp));
  }
  return cleanText(lines.join('\n'));
}

function parseRels(xml) {
  const rels = [];
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    rels.push({ id: attr(m[0], 'Id'), type: attr(m[0], 'Type') || '', target: attr(m[0], 'Target') || '' });
  }
  return rels;
}

function resolveTarget(baseFile, target) {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), target));
}

async function slideOrder(zip) {
  const pres = await zip.file('ppt/presentation.xml')?.async('string');
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (pres && relsXml) {
    const rels = new Map(parseRels(relsXml).map((r) => [r.id, r]));
    const order = [];
    for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
      const rel = rels.get(attr(m[0], 'r:id'));
      if (rel) order.push(resolveTarget('ppt/presentation.xml', rel.target));
    }
    if (order.length) return order;
  }
  // Fallback: numeric file order
  return Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

async function slideNotes(zip, slidePath) {
  const relsPath = `${path.posix.dirname(slidePath)}/_rels/${path.posix.basename(slidePath)}.rels`;
  const relsXml = await zip.file(relsPath)?.async('string');
  if (!relsXml) return '';
  const rel = parseRels(relsXml).find((r) => r.type.endsWith('/notesSlide'));
  if (!rel) return '';
  const xml = await zip.file(resolveTarget(slidePath, rel.target))?.async('string');
  return xml ? parseNotesXml(xml) : '';
}

export async function extractPptx(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ExtractError(`Could not read PPTX: ${err.message}`);
  }
  const order = await slideOrder(zip);
  if (!order.length) throw new ExtractError('No slides found in this PPTX file.');
  const pages = [];
  for (const slidePath of order) {
    const xml = await zip.file(slidePath)?.async('string');
    if (!xml) continue;
    const { title, text } = parseSlideXml(xml);
    pages.push({ n: pages.length + 1, title, text, notes: await slideNotes(zip, slidePath) });
  }
  return pages;
}

// ---------- Dispatcher ----------

export function detectType(buffer, filename) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK') && ext === 'pptx') return 'pptx';
  if (ext === 'ppt') throw new ExtractError('Old .ppt format is not supported. Open it in PowerPoint and "Save As" .pptx.');
  if (SUPPORTED.includes(ext)) throw new ExtractError(`File content does not look like a valid .${ext} file.`);
  throw new ExtractError(`Unsupported file type ".${ext || '?'}". Supported: ${SUPPORTED.map((s) => '.' + s).join(', ')}`);
}

export async function extractDocument(buffer, filename) {
  const type = detectType(buffer, filename);
  const pages = type === 'pdf' ? await extractPdf(buffer) : await extractPptx(buffer);
  return { type, pages };
}
