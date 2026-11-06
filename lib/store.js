// Persistent storage: a small JSON "database" plus per-document files on disk.
//
// data/
//   config.json            API key + model
//   library.json           courses and document metadata
//   uploads/<docId>.<ext>  original uploaded files
//   docs/<docId>.pages.json         extracted text per page/slide
//   docs/<docId>.summary.<lang>.json generated study guide per language

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hasSupabaseConfig = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (Boolean(process.env.SUPABASE_URL) !== Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable Supabase storage.');
}
if (process.env.VERCEL && !hasSupabaseConfig) {
  throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel before deploying.');
}
const remote = hasSupabaseConfig ? await import('./supabase-store.js') : null;
export const REMOTE_STORAGE = Boolean(remote);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = process.env.STUDY_DATA_DIR
  ? path.resolve(process.env.STUDY_DATA_DIR)
  : path.join(ROOT, 'data');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const LIB_FILE = path.join(DATA_DIR, 'library.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Alias that Google keeps pointing at the newest Flash model. The app also auto-detects
// and switches to an available model if the configured one gets retired (see gemini.js).
export const DEFAULT_MODEL = 'gemini-flash-latest';

let lib = null;
let writeChain = Promise.resolve();

async function ensureDirs() {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function load() {
  if (lib) return lib;
  await ensureDirs();
  lib = await readJson(LIB_FILE, { courses: [], documents: [] });
  lib.courses ??= [];
  lib.documents ??= [];
  return lib;
}

function persist() {
  const snapshot = JSON.parse(JSON.stringify(lib));
  writeChain = writeChain.catch(() => {}).then(() => writeJson(LIB_FILE, snapshot));
  return writeChain;
}

const now = () => new Date().toISOString();
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ---------- Config ----------

export async function getConfig() {
  if (remote) return remote.getConfig();
  await ensureDirs();
  return readJson(CONFIG_FILE, {});
}

export async function saveConfig(patch) {
  if (remote) return remote.saveConfig(patch);
  const cfg = { ...(await getConfig()), ...patch };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined || cfg[k] === null) delete cfg[k];
  await writeJson(CONFIG_FILE, cfg);
  return cfg;
}

export async function getEffectiveConfig() {
  const cfg = await getConfig();
  const envKey = process.env.GEMINI_API_KEY || '';
  return {
    apiKey: envKey || cfg.apiKey || '',
    keySource: envKey ? 'env' : cfg.apiKey ? 'config' : null,
    model: cfg.model || process.env.GEMINI_MODEL || DEFAULT_MODEL,
  };
}

// ---------- Courses ----------

export async function listCourses() {
  if (remote) return remote.listCourses();
  const l = await load();
  return l.courses
    .map((c) => ({ ...c, documentCount: l.documents.filter((d) => d.courseId === c.id).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCourse(id) {
  if (remote) return remote.getCourse(id);
  const l = await load();
  return clone(l.courses.find((c) => c.id === id) || null);
}

export async function createCourse({ name, description = '' }) {
  if (remote) return remote.createCourse({ name, description });
  const l = await load();
  const course = { id: crypto.randomUUID(), name, description, createdAt: now() };
  l.courses.push(course);
  await persist();
  return clone(course);
}

export async function updateCourse(id, { name, description }) {
  if (remote) return remote.updateCourse(id, { name, description });
  const l = await load();
  const c = l.courses.find((x) => x.id === id);
  if (!c) return null;
  if (name !== undefined) c.name = name;
  if (description !== undefined) c.description = description;
  await persist();
  return clone(c);
}

export async function deleteCourse(id) {
  if (remote) return remote.deleteCourse(id);
  const l = await load();
  const docs = l.documents.filter((d) => d.courseId === id);
  for (const d of docs) await removeDocFiles(d);
  l.documents = l.documents.filter((d) => d.courseId !== id);
  l.courses = l.courses.filter((c) => c.id !== id);
  await persist();
}

// ---------- Documents ----------

export async function listDocuments(courseId) {
  if (remote) return remote.listDocuments(courseId);
  const l = await load();
  return clone(
    l.documents
      .filter((d) => d.courseId === courseId)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  );
}

export async function listAllDocuments() {
  if (remote) return remote.listAllDocuments();
  const l = await load();
  return clone(l.documents);
}

export async function getDocument(id) {
  if (remote) return remote.getDocument(id);
  const l = await load();
  return clone(l.documents.find((d) => d.id === id) || null);
}

export function uploadPath(doc) {
  return path.join(UPLOADS_DIR, `${doc.id}.${doc.type}`);
}

export async function getUploadBuffer(doc) {
  if (remote) return remote.getUploadBuffer(doc);
  return fs.readFile(uploadPath(doc));
}

export async function addDocument({ courseId, name, type, size, buffer, pages }) {
  if (remote) return remote.addDocument({ courseId, name, type, size, buffer, pages });
  const l = await load();
  const doc = {
    id: crypto.randomUUID(),
    courseId,
    name,
    type,
    size,
    pageCount: pages.length,
    createdAt: now(),
    summaryStatus: {},
  };
  await fs.writeFile(uploadPath(doc), buffer);
  await writeJson(path.join(DOCS_DIR, `${doc.id}.pages.json`), pages);
  l.documents.push(doc);
  await persist();
  return clone(doc);
}

async function removeDocFiles(doc) {
  const files = [uploadPath(doc), path.join(DOCS_DIR, `${doc.id}.pages.json`)];
  for (const f of await fs.readdir(DOCS_DIR).catch(() => [])) {
    if (f.startsWith(`${doc.id}.summary.`)) files.push(path.join(DOCS_DIR, f));
  }
  await Promise.all(files.map((f) => fs.rm(f, { force: true })));
}

export async function deleteDocument(id) {
  if (remote) return remote.deleteDocument(id);
  const l = await load();
  const doc = l.documents.find((d) => d.id === id);
  if (!doc) return false;
  await removeDocFiles(doc);
  l.documents = l.documents.filter((d) => d.id !== id);
  await persist();
  return true;
}

export async function getPages(id) {
  if (remote) return remote.getPages(id);
  return readJson(path.join(DOCS_DIR, `${id}.pages.json`), []);
}

export async function getSummary(id, lang) {
  if (remote) return remote.getSummary(id, lang);
  return readJson(path.join(DOCS_DIR, `${id}.summary.${lang}.json`), null);
}

export async function saveSummary(id, lang, summary) {
  if (remote) return remote.saveSummary(id, lang, summary);
  if (!(await getDocument(id))) return false; // deleted meanwhile
  await writeJson(path.join(DOCS_DIR, `${id}.summary.${lang}.json`), summary);
  return true;
}

export async function setSummaryStatus(id, lang, state, error = null) {
  if (remote) return remote.setSummaryStatus(id, lang, state, error);
  const l = await load();
  const doc = l.documents.find((d) => d.id === id);
  if (!doc) return null;
  doc.summaryStatus ??= {};
  doc.summaryStatus[lang] = { state, error, updatedAt: now() };
  await persist();
  return clone(doc.summaryStatus);
}
