// Minimal Gemini REST client (no SDK needed).
// Docs: https://ai.google.dev/api/generate-content

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = process.env.VERCEL ? 45_000 : 5 * 60_000;
const DEFAULT_RETRIES = process.env.VERCEL ? 0 : 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini({ apiKey, model, body, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES }) {
  if (!apiKey) throw new Error('No Gemini API key configured. Add one in Settings.');
  const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = new Error(`Could not reach Gemini: ${err.cause?.message || err.message}`);
      if (attempt < retries) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    lastErr = new Error(`Gemini error (${res.status}): ${data?.error?.message || res.statusText}`);
    lastErr.status = res.status;
    if (!RETRYABLE.has(res.status) || attempt === retries) throw lastErr;
    await sleep(3000 * 2 ** attempt);
  }
  throw lastErr;
}

function responseText(data) {
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('');
  if (!text) {
    const reason = data?.promptFeedback?.blockReason || cand?.finishReason || 'empty response';
    throw new Error(`Gemini returned no content (${reason}).`);
  }
  return { text, finishReason: cand?.finishReason };
}

function parseJsonLoose(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

/**
 * Generate structured JSON.
 * @param {object} o
 * @param {Array} o.parts  user content parts, e.g. [{text}, {inlineData:{mimeType,data}}]
 */
export async function generateJson({ apiKey, model, system, parts, schema, temperature = 0.3 }) {
  const data = await callGemini({
    apiKey,
    model,
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature },
    },
  });
  const { text, finishReason } = responseText(data);
  try {
    return parseJsonLoose(text);
  } catch {
    const hint = finishReason === 'MAX_TOKENS' ? ' The answer was cut off (document too long?).' : '';
    throw new Error(`Gemini returned invalid JSON.${hint}`);
  }
}

export async function testConnection({ apiKey, model, retries = process.env.VERCEL ? 0 : 1 }) {
  const data = await callGemini({
    apiKey,
    model,
    retries,
    timeoutMs: process.env.VERCEL ? 45_000 : 60_000,
    body: { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }] },
  });
  return responseText(data).text.trim();
}

/** List the models this key can use for generateContent. */
export async function listModels(apiKey) {
  if (!apiKey) throw new Error('No Gemini API key configured. Add one in Settings.');
  const models = [];
  let pageToken = '';
  do {
    const url = `${BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(30_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini error (${res.status}): ${data?.error?.message || res.statusText}`);
    for (const m of data.models || []) {
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      const id = String(m.name || '').replace(/^models\//, '');
      if (!/^gemini-/.test(id) || /(embedding|image|tts|audio|live|vision|aqa)/i.test(id)) continue;
      models.push({ id, displayName: m.displayName || id, inputTokenLimit: m.inputTokenLimit || 0 });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

const version = (id) => parseFloat((id.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');

/** True when an error means "this model name doesn't exist / was retired". */
export function isModelUnavailable(err) {
  return err?.status === 404 || (err?.status === 400 && /model/i.test(err.message) && /not (found|supported)|no longer/i.test(err.message));
}

/** Pick a sensible default: newest stable "flash" model, else newest stable model. */
export function pickRecommendedModel(models) {
  const stable = models.filter((m) => !/(preview|exp|latest|lite|\d{3,}$|-\d{2}-\d{2})/i.test(m.id));
  const byVersion = (list) => [...list].sort((a, b) => version(b.id) - version(a.id))[0]?.id;
  return (
    byVersion(stable.filter((m) => /^gemini-[\d.]+-flash$/.test(m.id))) ||
    byVersion(stable.filter((m) => /flash/.test(m.id))) ||
    byVersion(stable) ||
    models[0]?.id ||
    null
  );
}

/** True when the model exists but is temporarily overloaded or rate-limited. */
export function isBusy(err) {
  return [429, 500, 503, 504].includes(err?.status) || /^Could not reach Gemini/.test(err?.message || '');
}

/**
 * Alternative models to try when `current` fails, best first:
 * stable flash (newest first) → stable flash-lite → flash previews → other stable models.
 */
export function fallbackModels(models, current) {
  const ids = models.map((m) => m.id).filter((id) => id !== current && !/latest/.test(id));
  const isStable = (id) => !/(preview|exp|\d{3,}$|-\d{2}-\d{2})/i.test(id);
  const byVersion = (a, b) => version(b) - version(a);
  const groups = [
    ids.filter((id) => isStable(id) && /^gemini-[\d.]+-flash$/.test(id)),
    ids.filter((id) => isStable(id) && /^gemini-[\d.]+-flash-lite$/.test(id)),
    ids.filter((id) => !isStable(id) && /flash/.test(id)),
    ids.filter((id) => isStable(id) && !/flash/.test(id)),
  ];
  const seen = new Set();
  return groups.flatMap((g) => g.sort(byVersion)).filter((id) => !seen.has(id) && seen.add(id));
}

/**
 * Run `run(model)`; if the model is retired or busy, try up to `maxAlternatives` other models.
 * Resolves to { result, model, switchedFrom?, reason? } where reason is 'unavailable' | 'busy'.
 */
export async function withModelFallback({ apiKey, model, run, maxAlternatives = 3 }) {
  try {
    return { result: await run(model), model };
  } catch (err) {
    if (!isModelUnavailable(err) && !isBusy(err)) throw err;
    const reason = isModelUnavailable(err) ? 'unavailable' : 'busy';
    let alternatives = [];
    if (!process.env.VERCEL) {
      try {
        alternatives = fallbackModels(await listModels(apiKey), model).slice(0, maxAlternatives);
      } catch {
        /* keep original error */
      }
    }
    const tried = [model];
    let last = err;
    for (const alt of alternatives) {
      tried.push(alt);
      try {
        console.warn(`[gemini] "${model}" ${reason}, trying "${alt}"`);
        return { result: await run(alt), model: alt, switchedFrom: model, reason };
      } catch (e) {
        last = e;
        if (!isModelUnavailable(e) && !isBusy(e)) throw e;
      }
    }
    if (isBusy(last)) {
      const busy = new Error(
        `Google's Gemini servers are overloaded right now — this is not a problem with your key or the app. ` +
          `Tried: ${tried.join(', ')}. Please try again in a few minutes. (${last.message})`
      );
      busy.status = 503;
      throw busy;
    }
    throw last;
  }
}
