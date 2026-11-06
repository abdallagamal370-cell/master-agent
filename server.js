// Master Study Hub - local web server.
// Run: npm start   (then open http://localhost:3210)

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { extractDocument } from './lib/extract.js';
import { testConnection, listModels, pickRecommendedModel, withModelFallback } from './lib/gemini.js';
import * as queue from './lib/queue.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LANGS = ['en', 'ar'];
const MAX_FILE_MB = process.env.VERCEL ? 4 : 150;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/marked', express.static(path.join(ROOT, 'node_modules', 'marked', 'lib')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 30 },
});

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const pickLang = (v) => (LANGS.includes(v) ? v : 'en');

// Browsers send multipart filenames as UTF-8 but busboy decodes them as latin1.
function fixFilename(name) {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

function cleanName(v, max = 120) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// ---------- Settings ----------

async function publicSettings() {
  const cfg = await store.getEffectiveConfig();
  const k = cfg.apiKey;
  return {
    hasKey: Boolean(k),
    keySource: cfg.keySource,
    keyPreview: k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '',
    model: cfg.model,
    defaultModel: store.DEFAULT_MODEL,
  };
}

app.get('/api/settings', async (req, res) => res.json(await publicSettings()));

app.put('/api/settings', async (req, res) => {
  const patch = {};
  if (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) patch.apiKey = req.body.apiKey.trim();
  if (req.body.clearKey) patch.apiKey = null;
  if (typeof req.body.model === 'string') patch.model = req.body.model.trim() || null;
  await store.saveConfig(patch);
  res.json(await publicSettings());
});

app.post('/api/settings/test', async (req, res) => {
  const cfg = await store.getEffectiveConfig();
  const apiKey = (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) || cfg.apiKey;
  const requested = (typeof req.body.model === 'string' && req.body.model.trim()) || cfg.model;
  if (!apiKey) throw httpError(400, 'No API key provided.');
  const { result: reply, model, switchedFrom, reason } = await withModelFallback({
    apiKey,
    model: requested,
    run: (m) => testConnection({ apiKey, model: m }),
  });
  res.json({ ok: true, reply, model, switchedFrom, reason });
});

app.get('/api/models', async (req, res) => {
  const cfg = await store.getEffectiveConfig();
  const apiKey = (typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'].trim()) || cfg.apiKey;
  const models = await listModels(apiKey);
  res.json({ models, recommended: pickRecommendedModel(models) });
});

// ---------- Courses ----------

app.get('/api/courses', async (req, res) => res.json(await store.listCourses()));

app.post('/api/courses', async (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) throw httpError(400, 'Course name is required.');
  res.status(201).json(await store.createCourse({ name, description: cleanName(req.body.description, 1000) }));
});

app.get('/api/courses/:id', async (req, res) => {
  const course = await store.getCourse(req.params.id);
  if (!course) throw httpError(404, 'Course not found.');
  res.json({ ...course, documents: await store.listDocuments(course.id) });
});

app.patch('/api/courses/:id', async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) {
    patch.name = cleanName(req.body.name);
    if (!patch.name) throw httpError(400, 'Course name is required.');
  }
  if (req.body.description !== undefined) patch.description = cleanName(req.body.description, 1000);
  const course = await store.updateCourse(req.params.id, patch);
  if (!course) throw httpError(404, 'Course not found.');
  res.json(course);
});

app.delete('/api/courses/:id', async (req, res) => {
  await store.deleteCourse(req.params.id);
  res.status(204).end();
});

app.get('/api/courses/:id/concepts', async (req, res) => {
  const lang = pickLang(req.query.lang);
  const out = [];
  for (const d of await store.listDocuments(req.params.id)) {
    const s = await store.getSummary(d.id, lang);
    for (const k of s?.keyConcepts || []) out.push({ ...k, docId: d.id, docName: d.name, docType: d.type });
  }
  out.sort((a, b) => a.term.localeCompare(b.term, lang));
  res.json(out);
});

// ---------- Documents ----------

app.post('/api/courses/:id/documents', upload.array('files', process.env.VERCEL ? 1 : 30), async (req, res) => {
  const course = await store.getCourse(req.params.id);
  if (!course) throw httpError(404, 'Course not found.');
  const lang = pickLang(req.body.lang);
  const auto = req.body.auto !== '0';
  const { apiKey } = await store.getEffectiveConfig();
  const results = [];
  for (const f of req.files || []) {
    const name = fixFilename(f.originalname);
    try {
      const { type, pages } = await extractDocument(f.buffer, name);
      const doc = await store.addDocument({ courseId: course.id, name, type, size: f.size, buffer: f.buffer, pages });
      if (auto && apiKey) await queue.enqueue(doc.id, lang);
      results.push({ ok: true, name, document: await store.getDocument(doc.id) });
    } catch (err) {
      console.error(`[upload] ${name}: ${err.message}`);
      results.push({ ok: false, name, error: err.message });
    }
  }
  res.json({ results });
});

app.get('/api/documents/:id', async (req, res) => {
  const doc = await store.getDocument(req.params.id);
  if (!doc) throw httpError(404, 'Document not found.');
  const course = await store.getCourse(doc.courseId);
  res.json({
    document: doc,
    course: course && { id: course.id, name: course.name },
    pages: await store.getPages(doc.id),
  });
});

app.get('/api/documents/:id/status', async (req, res) => {
  const doc = await store.getDocument(req.params.id);
  if (!doc) throw httpError(404, 'Document not found.');
  res.json(doc.summaryStatus || {});
});

app.get('/api/documents/:id/summary', async (req, res) => {
  const summary = await store.getSummary(req.params.id, pickLang(req.query.lang));
  if (!summary) throw httpError(404, 'Study guide not generated yet.');
  res.json(summary);
});

app.post('/api/documents/:id/summarize', async (req, res) => {
  const doc = await store.getDocument(req.params.id);
  if (!doc) throw httpError(404, 'Document not found.');
  const { apiKey } = await store.getEffectiveConfig();
  if (!apiKey) throw httpError(400, 'No Gemini API key configured. Add one in Settings.');
  await queue.enqueue(doc.id, pickLang(req.body.lang));
  res.status(202).json((await store.getDocument(doc.id)).summaryStatus);
});

app.get('/api/documents/:id/file', async (req, res) => {
  const doc = await store.getDocument(req.params.id);
  if (!doc) throw httpError(404, 'Document not found.');
  if (store.REMOTE_STORAGE) {
    const buffer = await store.getUploadBuffer(doc);
    res.attachment(doc.name).send(buffer);
  } else {
    res.download(store.uploadPath(doc), doc.name);
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  await store.deleteDocument(req.params.id);
  res.status(204).end();
});

// ---------- Errors ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message || 'Internal error';
  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') message = `File too large (max ${MAX_FILE_MB} MB).`;
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// ---------- Start ----------

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3210;
  const HOST = process.env.HOST || '127.0.0.1';
  app.listen(PORT, HOST, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Master Study Hub is running at ${url}\n  Data folder: ${store.DATA_DIR}\n  Press Ctrl+C to stop.\n`);
    await queue.resume().catch((e) => console.error('Queue resume failed:', e.message));
    if (process.argv.includes('--open')) {
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
      exec(cmd);
    }
  });
}

export default app;
