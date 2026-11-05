// Simple in-process job queue: generates study guides one at a time
// (sequential to stay friendly with Gemini free-tier rate limits).

import * as store from './store.js';
import { summarizeDocument } from './summarize.js';

const jobs = [];
let current = null;
let running = false;

const same = (a, b) => a && b && a.docId === b.docId && a.lang === b.lang;

export async function enqueue(docId, lang) {
  const job = { docId, lang };
  if (jobs.some((j) => same(j, job)) || same(current, job)) return false;
  await store.setSummaryStatus(docId, lang, 'pending');
  jobs.push(job);
  pump();
  return true;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (jobs.length) {
      current = jobs.shift();
      const { docId, lang } = current;
      const doc = await store.getDocument(docId);
      if (!doc) continue;
      const started = Date.now();
      try {
        await store.setSummaryStatus(docId, lang, 'running');
        console.log(`[study-guide] ${doc.name} (${lang}) ...`);
        const summary = await summarizeDocument(doc, lang);
        if (await store.saveSummary(docId, lang, summary)) {
          await store.setSummaryStatus(docId, lang, 'ready');
        }
        console.log(`[study-guide] ${doc.name} (${lang}) done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (err) {
        console.error(`[study-guide] ${doc.name} (${lang}) failed: ${err.message}`);
        await store.setSummaryStatus(docId, lang, 'error', err.message).catch(() => {});
      }
    }
  } finally {
    current = null;
    running = false;
  }
}

/** Re-queue jobs interrupted by a server restart. */
export async function resume() {
  for (const doc of await store.listAllDocuments()) {
    for (const [lang, st] of Object.entries(doc.summaryStatus || {})) {
      if (st?.state === 'pending' || st?.state === 'running') await enqueue(doc.id, lang);
    }
  }
}
