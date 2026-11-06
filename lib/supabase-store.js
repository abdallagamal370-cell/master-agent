import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const BUCKET = process.env.SUPABASE_BUCKET || 'study-uploads';
const configId = 'singleton';

function fail(error) {
  if (error) throw new Error(`Supabase storage error: ${error.message}`);
}

function course(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, description: row.description || '', createdAt: row.created_at };
}

function document(row) {
  if (!row) return null;
  return {
    id: row.id,
    courseId: row.course_id,
    name: row.name,
    type: row.type,
    size: Number(row.size),
    pageCount: row.page_count,
    createdAt: row.created_at,
    summaryStatus: row.summary_status || {},
  };
}

function storagePath(doc) {
  return `${doc.id}.${doc.type}`;
}

export async function getConfig() {
  const { data, error } = await client.from('app_config').select('config').eq('id', configId).maybeSingle();
  fail(error);
  return data?.config || {};
}

export async function saveConfig(patch) {
  const config = { ...(await getConfig()), ...patch };
  for (const key of Object.keys(config)) if (config[key] == null) delete config[key];
  const { error } = await client.from('app_config').upsert({ id: configId, config }, { onConflict: 'id' });
  fail(error);
  return config;
}

export async function listCourses() {
  const [{ data: courses, error }, { data: documents, error: docsError }] = await Promise.all([
    client.from('courses').select('*').order('name'),
    client.from('documents').select('course_id'),
  ]);
  fail(error);
  fail(docsError);
  const counts = new Map();
  for (const doc of documents) counts.set(doc.course_id, (counts.get(doc.course_id) || 0) + 1);
  return courses.map((row) => ({ ...course(row), documentCount: counts.get(row.id) || 0 }));
}

export async function getCourse(id) {
  const { data, error } = await client.from('courses').select('*').eq('id', id).maybeSingle();
  fail(error);
  return course(data);
}

export async function createCourse({ name, description = '' }) {
  const { data, error } = await client
    .from('courses')
    .insert({ name, description })
    .select('*')
    .single();
  fail(error);
  return course(data);
}

export async function updateCourse(id, patch) {
  const values = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  const { data, error } = await client.from('courses').update(values).eq('id', id).select('*').maybeSingle();
  fail(error);
  return course(data);
}

export async function deleteCourse(id) {
  const docs = await listDocuments(id);
  await Promise.all(
    docs.map(async (doc) => {
      const { error } = await client.storage.from(BUCKET).remove([storagePath(doc)]);
      fail(error);
    })
  );
  const { error } = await client.from('courses').delete().eq('id', id);
  fail(error);
}

export async function listDocuments(courseId) {
  const { data, error } = await client.from('documents').select('*').eq('course_id', courseId).order('name');
  fail(error);
  return data.map(document);
}

export async function listAllDocuments() {
  const { data, error } = await client.from('documents').select('*');
  fail(error);
  return data.map(document);
}

export async function getDocument(id) {
  const { data, error } = await client.from('documents').select('*').eq('id', id).maybeSingle();
  fail(error);
  return document(data);
}

export async function getUploadBuffer(doc) {
  const { data, error } = await client.storage.from(BUCKET).download(storagePath(doc));
  fail(error);
  return Buffer.from(await data.arrayBuffer());
}

export async function addDocument({ courseId, name, type, size, buffer, pages }) {
  const id = crypto.randomUUID();
  const doc = { id, type };
  const { error: uploadError } = await client.storage.from(BUCKET).upload(storagePath(doc), buffer, {
    contentType: type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    upsert: false,
  });
  fail(uploadError);
  const { data, error } = await client
    .from('documents')
    .insert({ id, course_id: courseId, name, type, size, page_count: pages.length, pages, summary_status: {} })
    .select('*')
    .single();
  if (error) {
    await client.storage.from(BUCKET).remove([storagePath(doc)]);
    fail(error);
  }
  return document(data);
}

export async function deleteDocument(id) {
  const doc = await getDocument(id);
  if (!doc) return false;
  const { error: storageError } = await client.storage.from(BUCKET).remove([storagePath(doc)]);
  fail(storageError);
  const { error } = await client.from('documents').delete().eq('id', id);
  fail(error);
  return true;
}

export async function getPages(id) {
  const { data, error } = await client.from('documents').select('pages').eq('id', id).maybeSingle();
  fail(error);
  return data?.pages || [];
}

export async function getSummary(id, lang) {
  const column = lang === 'ar' ? 'summary_ar' : 'summary_en';
  const { data, error } = await client.from('documents').select(column).eq('id', id).maybeSingle();
  fail(error);
  return data?.[column] || null;
}

export async function saveSummary(id, lang, summary) {
  const column = lang === 'ar' ? 'summary_ar' : 'summary_en';
  const { data, error } = await client.from('documents').update({ [column]: summary }).eq('id', id).select('id').maybeSingle();
  fail(error);
  return Boolean(data);
}

export async function setSummaryStatus(id, lang, state, errorMessage = null) {
  const { data, error } = await client.from('documents').select('summary_status').eq('id', id).maybeSingle();
  fail(error);
  if (!data) return null;
  const summaryStatus = {
    ...(data.summary_status || {}),
    [lang]: { state, error: errorMessage, updatedAt: new Date().toISOString() },
  };
  const { error: updateError } = await client.from('documents').update({ summary_status: summaryStatus }).eq('id', id);
  fail(updateError);
  return summaryStatus;
}