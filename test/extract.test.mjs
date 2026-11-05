// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractDocument, detectType } from '../lib/extract.js';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const sp = (phType, paras) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="x"/><p:cNvSpPr/><p:nvPr>${phType ? `<p:ph type="${phType}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras
    .map(([text, lvl]) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`;

const slide = (shapes) => `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

async function makePptx() {
  const zip = new JSZip();
  // Presentation order deliberately differs from file numbering: slide2.xml is shown first.
  zip.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`);
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
      <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
    </Relationships>`
  );
  zip.file('ppt/slides/slide2.xml', slide([sp('ctrTitle', [['Software Design Principles']]), sp(null, [['SOLID &amp; DRY'], ['Single Responsibility', 1]])]));
  zip.file('ppt/slides/slide1.xml', slide([sp('title', [['Coupling and Cohesion']]), sp(null, [['Low coupling, high cohesion'], ['التماسك العالي']])]));
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`
  );
  zip.file(
    'ppt/notesSlides/notesSlide1.xml',
    `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${sp('body', [['Mention Parnas 1972']])}${sp('sldNum', [['2']])}</p:spTree></p:cSld></p:notes>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makePdf(pageTexts) {
  const objs = [];
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pageTexts.forEach((txt, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${txt}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PPTX: slide order, titles, entities, nesting, notes', async () => {
  const { type, pages } = await extractDocument(await makePptx(), 'lecture.pptx');
  assert.equal(type, 'pptx');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].title, 'Software Design Principles');
  assert.match(pages[0].text, /SOLID & DRY/);
  assert.match(pages[0].text, /\n {2}Single Responsibility/);
  assert.equal(pages[0].notes, '');
  assert.equal(pages[1].n, 2);
  assert.equal(pages[1].title, 'Coupling and Cohesion');
  assert.match(pages[1].text, /التماسك العالي/);
  assert.equal(pages[1].notes, 'Mention Parnas 1972');
});

test('PDF: per-page text', async () => {
  const { type, pages } = await extractDocument(makePdf(['Requirements Engineering', 'Agile Methods']), 'notes.pdf');
  assert.equal(type, 'pdf');
  assert.equal(pages.length, 2);
  assert.match(pages[0].text, /Requirements Engineering/);
  assert.match(pages[1].text, /Agile Methods/);
});

test('rejects unsupported files', () => {
  assert.throws(() => detectType(Buffer.from('hello'), 'a.docx'), /Unsupported/);
  assert.throws(() => detectType(Buffer.from('hello'), 'a.ppt'), /Save As/);
  assert.throws(() => detectType(Buffer.from('hello'), 'a.pdf'), /valid/);
});
