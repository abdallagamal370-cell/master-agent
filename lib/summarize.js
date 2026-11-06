// Builds the master-level study guide (summary + key concepts) for a document using Gemini.

import * as store from './store.js';
import { generateJson, withModelFallback } from './gemini.js';

const MAX_SOURCE_CHARS = 600_000; // ~150k tokens; keeps requests within free-tier limits
const MAX_INLINE_PDF_BYTES = 18 * 1024 * 1024;

const pagesSchema = { type: 'ARRAY', items: { type: 'INTEGER' } };

export const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    overview: { type: 'STRING' },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { heading: { type: 'STRING' }, pages: pagesSchema, summary: { type: 'STRING' } },
        required: ['heading', 'pages', 'summary'],
      },
    },
    keyConcepts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          term: { type: 'STRING' },
          definition: { type: 'STRING' },
          example: { type: 'STRING' },
          pages: pagesSchema,
        },
        required: ['term', 'definition', 'example', 'pages'],
      },
    },
    takeaways: { type: 'ARRAY', items: { type: 'STRING' } },
    prerequisites: { type: 'ARRAY', items: { type: 'STRING' } },
    goDeeper: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { topic: { type: 'STRING' }, why: { type: 'STRING' } },
        required: ['topic', 'why'],
      },
    },
  },
  required: ['title', 'overview', 'sections', 'keyConcepts', 'takeaways', 'prerequisites', 'goDeeper'],
  propertyOrdering: ['title', 'overview', 'sections', 'keyConcepts', 'takeaways', 'prerequisites', 'goDeeper'],
};

const SYSTEM = `You are a distinguished professor and expert tutor in Software Engineering and Computer Science, \
mentoring an ambitious master's student who wants to be the top of their class and to do original research. \
You turn course material (lecture slides and PDFs) into rigorous, insightful study guides. \
You explain the "why" behind ideas, connect concepts to each other and to real software engineering practice, \
and you are precise with terminology. You never fabricate content attributed to the source.`;

const LANG_RULES = {
  en: 'Write ALL text values in clear academic English.',
  ar:
    'Write ALL text values in Modern Standard Arabic (الفصحى). The first time a technical term appears, ' +
    'add the English term in parentheses, e.g. "الاقتران (Coupling)". In keyConcepts.term use the form ' +
    '"Arabic term (English term)". Keep code, formulas, acronyms, and proper names unchanged.',
};

export function buildSourceText(doc, pages) {
  const unit = doc.type === 'pptx' ? 'Slide' : 'Page';
  return pages
    .map((p) => {
      let s = `=== ${unit} ${p.n}${p.title ? `: ${p.title}` : ''} ===\n${p.text || '(no text on this ' + unit.toLowerCase() + ')'}`;
      if (p.notes) s += `\n[Speaker notes]\n${p.notes}`;
      return s;
    })
    .join('\n\n');
}

function buildPrompt({ course, doc, lang, unit, sourceNote }) {
  return `Course: ${course?.name || 'Unknown'}${course?.description ? `\nCourse description: ${course.description}` : ''}
Document: "${doc.name}" (${doc.pageCount} ${unit.toLowerCase()}s)

Create a master-level study guide for this document as JSON.

Fields:
- title: a short descriptive title for the material.
- overview: 2-4 Markdown paragraphs explaining what the document covers, its main storyline/argument, and how the parts connect.
- sections: split the material into logical sections that follow the document's order (typically 4-12). For each: a heading, the ${unit} numbers it covers, and a thorough Markdown summary (bullets allowed) that EXPLAINS the ideas rather than just listing them. Include formulas, algorithms, diagrams described in words, or code when present in the source.
- keyConcepts: the most important terms, principles, models, techniques, patterns, metrics or methods (typically 8-30). For each: a precise definition, a short concrete example (ideally from real software engineering practice), and the ${unit} numbers where it appears.
- takeaways: the 5-10 most important things to remember for exams and research.
- prerequisites: concepts the student should already know to understand this material well.
- goDeeper: 3-6 directions to explore beyond the document (advanced topics, seminal papers or books, open research questions), each with why it is worth exploring.

Rules:
- overview, sections, keyConcepts and takeaways must be grounded in the document. Slides are often terse: you may clarify and expand explanations with standard knowledge of the field, but never contradict the source or attribute invented claims to it.
- Reference locations ONLY with the numbers from the "=== ${unit} N ===" markers (integers between 1 and ${doc.pageCount}).
- Markdown is allowed inside overview and section summaries only.
- ${LANG_RULES[lang] || LANG_RULES.en}
${sourceNote}`;
}

function normalize(raw, doc) {
  const max = doc.pageCount || 0;
  const pages = (arr) =>
    [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= max))].sort(
      (a, b) => a - b
    );
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    title: str(raw.title) || doc.name,
    overview: str(raw.overview),
    sections: list(raw.sections)
      .map((s) => ({ heading: str(s?.heading), pages: pages(s?.pages), summary: str(s?.summary) }))
      .filter((s) => s.heading || s.summary),
    keyConcepts: list(raw.keyConcepts)
      .map((k) => ({ term: str(k?.term), definition: str(k?.definition), example: str(k?.example), pages: pages(k?.pages) }))
      .filter((k) => k.term),
    takeaways: list(raw.takeaways).map(str).filter(Boolean),
    prerequisites: list(raw.prerequisites).map(str).filter(Boolean),
    goDeeper: list(raw.goDeeper)
      .map((g) => ({ topic: str(g?.topic), why: str(g?.why) }))
      .filter((g) => g.topic),
  };
}

export async function summarizeDocument(doc, lang) {
  const cfg = await store.getEffectiveConfig();
  if (!cfg.apiKey) throw new Error('No Gemini API key configured. Add one in Settings.');

  const [pages, course] = await Promise.all([store.getPages(doc.id), store.getCourse(doc.courseId)]);
  const unit = doc.type === 'pptx' ? 'Slide' : 'Page';
  const textChars = pages.reduce((a, p) => a + (p.text?.length || 0) + (p.notes?.length || 0), 0);

  const parts = [];
  let sourceNote;
  let truncated = false;
  let mode = 'text';

  const looksScanned = textChars < Math.max(200, 40 * pages.length);
  if (doc.type === 'pdf' && looksScanned) {
    // Scanned/image PDF: let Gemini read the file itself (it supports PDF input with OCR).
    const file = await store.getUploadBuffer(doc);
    if (file.byteLength > MAX_INLINE_PDF_BYTES) {
      throw new Error('This PDF has almost no extractable text (scanned?) and is too large (>18 MB) to send for OCR.');
    }
    const data = file.toString('base64');
    parts.push({ inlineData: { mimeType: 'application/pdf', data } });
    sourceNote = '\nThe document is attached as a PDF file above (it may be scanned). Page numbers are the PDF page numbers.';
    mode = 'pdf';
  } else {
    if (textChars < 50) throw new Error('This document contains almost no text to summarize.');
    let source = buildSourceText(doc, pages);
    if (source.length > MAX_SOURCE_CHARS) {
      source = source.slice(0, MAX_SOURCE_CHARS);
      truncated = true;
    }
    sourceNote = `\nDocument content${truncated ? ' (truncated: the document was too long, only the first part is included)' : ''}:\n<<<\n${source}\n>>>`;
  }

  parts.push({ text: buildPrompt({ course, doc, lang, unit, sourceNote }) });

  const { result: raw, model, switchedFrom, reason } = await withModelFallback({
    apiKey: cfg.apiKey,
    model: cfg.model,
    run: (m) => generateJson({ apiKey: cfg.apiKey, model: m, system: SYSTEM, parts, schema: SUMMARY_SCHEMA }),
  });
  // Retired model: remember the replacement. Busy model: keep the user's choice for next time.
  if (switchedFrom && reason === 'unavailable') await store.saveConfig({ model });
  return {
    ...normalize(raw, doc),
    meta: { lang, model, generatedAt: new Date().toISOString(), truncated, mode },
  };
}
