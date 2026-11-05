import { marked } from '/vendor/marked/marked.esm.js';
import { t, getLang, setLang, applyLang } from '/i18n.js';

// ---------- Helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sidebar = $('#sidebar');
const main = $('#main');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html(token) {
      return esc(typeof token === 'string' ? token : token.text);
    },
    link(token) {
      const href = /^(https?:|mailto:)/i.test(token.href || '') ? token.href : '#';
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
    },
  },
});
const md = (s) => marked.parse(s || '');

async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), kind === 'error' ? 6000 : 3000);
}

const fmtDate = (iso) => new Date(iso).toLocaleString(getLang() === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' });
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const unitWord = (doc, plural) => (doc.type === 'pptx' ? t(plural ? 'slides' : 'slide') : t(plural ? 'pages' : 'page'));
const docIcon = (type) => (type === 'pptx' ? '📊' : '📄');
const statusOf = (doc, lang = getLang()) => doc.summaryStatus?.[lang] || { state: 'none' };
const isBusy = (st) => st.state === 'pending' || st.state === 'running';

function badge(st) {
  const spin = st.state === 'running' ? '<span class="spinner"></span>' : '';
  return `<span class="badge ${st.state}" ${st.error ? `title="${esc(st.error)}"` : ''}>${spin}${t('status_' + st.state)}</span>`;
}

function pageChips(doc, pages) {
  if (!pages?.length) return '';
  return `<span class="chips">${pages
    .map((n) => `<button class="chip" data-page="${n}" title="${esc(unitWord(doc))} ${n}">${esc(unitWord(doc))} ${n}</button>`)
    .join('')}</span>`;
}

function courseDialog(course) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<form method="dialog">
      <h2>${course ? t('editCourse') : t('newCourse')}</h2>
      <label>${t('courseName')}<input name="name" required maxlength="120" value="${esc(course?.name)}" placeholder="${esc(t('courseNamePh'))}" autofocus></label>
      <label>${t('description')}<textarea name="description" rows="3" maxlength="1000" placeholder="${esc(t('descriptionPh'))}">${esc(course?.description)}</textarea></label>
      <div class="row end">
        <button value="cancel" formnovalidate class="btn ghost">${t('cancel')}</button>
        <button value="ok" class="btn primary">${course ? t('save') : t('create')}</button>
      </div>
    </form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      const fd = new FormData($('form', d));
      const ok = d.returnValue === 'ok';
      d.remove();
      resolve(ok ? { name: String(fd.get('name')).trim(), description: String(fd.get('description')).trim() } : null);
    });
    d.showModal();
  });
}

async function newCourse() {
  const data = await courseDialog();
  if (!data?.name) return;
  try {
    const c = await api('/api/courses', { method: 'POST', body: data });
    location.hash = `#/course/${c.id}`;
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- Router ----------

let viewSeq = 0;
let pollTimer = null;
let currentCourseId = null;

const routes = [
  [/^#\/?$/, renderHome],
  [/^#\/course\/([\w-]+)$/, renderCourse],
  [/^#\/doc\/([\w-]+)$/, renderDoc],
  [/^#\/settings$/, renderSettings],
];

async function route() {
  clearTimeout(pollTimer);
  const seq = ++viewSeq;
  currentCourseId = null;
  const hash = location.hash || '#/';
  const match = routes.map(([re, fn]) => [hash.match(re), fn]).find(([m]) => m);
  if (!match) return (location.hash = '#/');
  main.innerHTML = `<div class="loading">${t('loading')}</div>`;
  main.onclick = null;
  try {
    await match[1](seq, ...match[0].slice(1));
  } catch (e) {
    if (seq === viewSeq) main.innerHTML = `<div class="empty-state"><h2>${esc(e.message || t('notFound'))}</h2><a class="btn" href="#/">${t('home')}</a></div>`;
  }
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  renderSidebar();
}

function poll(seq, fn, ms = 3000) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (seq !== viewSeq) return;
    try {
      await fn();
    } catch {
      /* ignore transient errors */
    }
  }, ms);
}

// ---------- Sidebar ----------

async function renderSidebar() {
  const courses = await api('/api/courses').catch(() => []);
  const hash = location.hash || '#/';
  sidebar.innerHTML = `
    <a class="brand" href="#/"><span class="logo">🎓</span><span>${t('appName')}</span></a>
    <div class="side-title">${t('courses')}</div>
    <nav class="course-nav">
      ${
        courses
          .map(
            (c) => `<a href="#/course/${c.id}" class="${c.id === currentCourseId ? 'active' : ''}">
              <span class="ico">📚</span><span class="name">${esc(c.name)}</span><small>${c.documentCount}</small></a>`
          )
          .join('') || `<p class="muted small pad">${t('noCoursesYet')}</p>`
      }
    </nav>
    <button class="btn ghost block" id="side-new">＋ ${t('newCourse')}</button>
    <div class="side-bottom">
      <a href="#/settings" class="${hash === '#/settings' ? 'active' : ''}"><span class="ico">⚙️</span>${t('settings')}</a>
      <button class="btn ghost block" id="lang-toggle" title="${t('language')}">🌐 ${getLang() === 'en' ? 'العربية' : 'English'}</button>
    </div>`;
  $('#side-new').onclick = newCourse;
  $('#lang-toggle').onclick = () => {
    setLang(getLang() === 'en' ? 'ar' : 'en');
    route();
  };
}

// ---------- Home ----------

async function renderHome(seq) {
  const [courses, settings] = await Promise.all([api('/api/courses'), api('/api/settings')]);
  if (seq !== viewSeq) return;
  main.innerHTML = `
    <section class="hero">
      <h1>🎓 ${t('appName')}</h1>
      <p>${t('tagline')}</p>
    </section>
    ${
      settings.hasKey
        ? ''
        : `<div class="callout warn"><span>🔑 ${t('noKeyBanner')}</span><a class="btn primary" href="#/settings">${t('goToSettings')}</a></div>`
    }
    <h2 class="section-title">${t('courses')}</h2>
    <div class="grid">
      ${courses
        .map(
          (c) => `<a class="card course-card" href="#/course/${c.id}">
            <div class="cc-icon">📚</div>
            <h3>${esc(c.name)}</h3>
            ${c.description ? `<p class="muted clamp">${esc(c.description)}</p>` : ''}
            <span class="muted small">${t('docsCount', { n: c.documentCount })}</span>
          </a>`
        )
        .join('')}
      <button class="card course-card add" id="home-new"><div class="cc-icon">＋</div><h3>${t('newCourse')}</h3></button>
    </div>
    <h2 class="section-title">${t('howItWorks')}</h2>
    <ol class="steps">
      <li><span>1</span>${t('step1')}</li>
      <li><span>2</span>${t('step2')}</li>
      <li><span>3</span>${t('step3')}</li>
      <li><span>4</span>${t('step4')}</li>
    </ol>`;
  $('#home-new').onclick = newCourse;
}

// ---------- Course ----------

async function renderCourse(seq, id) {
  const course = await api(`/api/courses/${id}`);
  if (seq !== viewSeq) return;
  currentCourseId = id;
  const state = { course, tab: 'docs', concepts: null, filter: '' };

  main.innerHTML = `
    <div class="crumbs"><a href="#/">${t('home')}</a><span>›</span>${esc(course.name)}</div>
    <header class="page-head">
      <div>
        <h1>${esc(course.name)}</h1>
        ${course.description ? `<p class="muted">${esc(course.description)}</p>` : ''}
      </div>
      <div class="actions">
        <button class="btn ghost" id="c-edit">✏️ ${t('edit')}</button>
        <button class="btn ghost danger" id="c-del">🗑 ${t('delete')}</button>
      </div>
    </header>
    <section class="dropzone" id="dz" tabindex="0">
      <input type="file" id="file-input" multiple accept=".pdf,.pptx" hidden>
      <div class="dz-icon">⬆️</div>
      <strong>${t('dropFiles')}</strong>
      <span class="muted small">${t('supportedFormats')}</span>
      <div class="progress" id="dz-progress" hidden><div class="bar"></div><span class="small"></span></div>
    </section>
    <label class="check"><input type="checkbox" id="auto-sum" ${localStorage.getItem('msh.auto') === '0' ? '' : 'checked'}> ${t('autoSummarize')}</label>
    <div class="tabs" id="c-tabs">
      <button data-tab="docs" class="active">${t('documents')} (${course.documents.length})</button>
      <button data-tab="glossary">${t('glossary')}</button>
    </div>
    <div id="c-body"></div>`;

  $('#c-edit').onclick = async () => {
    const data = await courseDialog(course);
    if (!data?.name) return;
    await api(`/api/courses/${id}`, { method: 'PATCH', body: data });
    route();
  };
  $('#c-del').onclick = async () => {
    if (!confirm(t('confirmDeleteCourse', { name: course.name }))) return;
    await api(`/api/courses/${id}`, { method: 'DELETE' });
    location.hash = '#/';
  };
  $('#auto-sum').onchange = (e) => localStorage.setItem('msh.auto', e.target.checked ? '1' : '0');

  // Upload
  const dz = $('#dz');
  const input = $('#file-input');
  dz.onclick = (e) => {
    if (!dz.classList.contains('busy') && !e.target.closest('.progress')) input.click();
  };
  dz.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && input.click();
  dz.ondragover = (e) => {
    e.preventDefault();
    dz.classList.add('over');
  };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    uploadFiles([...e.dataTransfer.files]);
  };
  input.onchange = () => {
    uploadFiles([...input.files]);
    input.value = '';
  };

  function uploadFiles(files) {
    if (!files.length || dz.classList.contains('busy')) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));
    fd.append('lang', getLang());
    fd.append('auto', $('#auto-sum').checked ? '1' : '0');
    const prog = $('#dz-progress');
    const bar = $('.bar', prog);
    const label = $('span', prog);
    prog.hidden = false;
    dz.classList.add('busy');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/courses/${id}/documents`);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      bar.style.width = `${p}%`;
      label.textContent = p < 100 ? t('uploading', { p }) : t('processing');
    };
    xhr.onloadend = async () => {
      dz.classList.remove('busy');
      prog.hidden = true;
      bar.style.width = '0';
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* empty */
      }
      if (xhr.status !== 200) return toast(data.error || `Upload failed (${xhr.status})`, 'error');
      const ok = data.results.filter((r) => r.ok);
      const bad = data.results.filter((r) => !r.ok);
      if (ok.length) toast(t('uploadedN', { n: ok.length }), 'success');
      bad.forEach((r) => toast(t('uploadFailed', { name: r.name, error: r.error }), 'error'));
      if (seq === viewSeq) {
        const fresh = await api(`/api/courses/${id}`);
        state.course = fresh;
        state.concepts = null;
        $('[data-tab="docs"]', main).textContent = `${t('documents')} (${fresh.documents.length})`;
        drawBody();
        renderSidebar();
      }
    };
    xhr.send(fd);
  }

  // Tabs
  $('#c-tabs').onclick = (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    $$('#c-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    drawBody();
  };

  // Document actions (delegated)
  $('#c-body').onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    e.preventDefault();
    const doc = state.course.documents.find((d) => d.id === btn.dataset.id);
    if (!doc) return;
    try {
      if (btn.dataset.act === 'gen') {
        if (statusOf(doc).state === 'ready' && !confirm(t('confirmRegenerate'))) return;
        doc.summaryStatus = await api(`/api/documents/${doc.id}/summarize`, { method: 'POST', body: { lang: getLang() } });
      } else if (btn.dataset.act === 'del') {
        if (!confirm(t('confirmDeleteDoc', { name: doc.name }))) return;
        await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
        state.course.documents = state.course.documents.filter((d) => d.id !== doc.id);
        state.concepts = null;
        $('[data-tab="docs"]', main).textContent = `${t('documents')} (${state.course.documents.length})`;
        renderSidebar();
      }
      drawBody();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  async function drawBody() {
    const body = $('#c-body');
    if (!body) return;
    if (state.tab === 'docs') {
      body.innerHTML = docsTable(state.course.documents);
      schedule();
    } else {
      if (!state.concepts) {
        body.innerHTML = `<div class="loading">${t('loading')}</div>`;
        state.concepts = await api(`/api/courses/${id}/concepts?lang=${getLang()}`);
        if (seq !== viewSeq || state.tab !== 'glossary') return;
      }
      body.innerHTML = glossaryView(state.concepts, state.filter);
      const inp = $('#g-search', body);
      inp.oninput = () => {
        state.filter = inp.value;
        $('#g-list', body).innerHTML = glossaryItems(state.concepts, state.filter);
      };
    }
  }

  function schedule() {
    if (!state.course.documents.some((d) => isBusy(statusOf(d)))) return;
    poll(seq, async () => {
      const fresh = await api(`/api/courses/${id}`);
      const sig = (c) => JSON.stringify(c.documents.map((d) => [d.id, statusOf(d).state]));
      const changed = sig(fresh) !== sig(state.course);
      state.course = fresh;
      if (changed) state.concepts = null;
      if (changed && state.tab === 'docs') drawBody();
      else schedule();
    });
  }

  drawBody();
}

function docsTable(docs) {
  if (!docs.length) return `<div class="empty-state small"><p>${t('noDocs')}</p></div>`;
  return `<div class="doc-list">${docs
    .map((d) => {
      const st = statusOf(d);
      return `<div class="doc-row">
        <a class="doc-main" href="#/doc/${d.id}">
          <span class="doc-icon">${docIcon(d.type)}</span>
          <span class="doc-text"><span class="doc-name" dir="auto">${esc(d.name)}</span>
          <span class="muted small">${d.type.toUpperCase()} · ${d.pageCount} ${unitWord(d, true)} · ${fmtSize(d.size)}</span></span>
        </a>
        ${badge(st)}
        <div class="row-actions">
          ${isBusy(st) ? '' : `<button class="btn small" data-act="gen" data-id="${d.id}">${st.state === 'ready' ? '↻ ' + t('regenerate') : st.state === 'error' ? t('retry') : '✨ ' + t('generate')}</button>`}
          <button class="btn small ghost danger" data-act="del" data-id="${d.id}" title="${t('delete')}">🗑</button>
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

function matches(k, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return [k.term, k.definition, k.example].some((s) => s?.toLowerCase().includes(q));
}

function glossaryItems(concepts, filter) {
  const list = concepts.filter((k) => matches(k, filter));
  if (!list.length) return `<p class="muted">${t('noResults')}</p>`;
  return list
    .map(
      (k) => `<div class="concept">
        <h4>${esc(k.term)}</h4>
        <p>${esc(k.definition)}</p>
        ${k.example ? `<p class="example"><strong>${t('example')}:</strong> ${esc(k.example)}</p>` : ''}
        <a class="src-link small" href="#/doc/${k.docId}">${docIcon(k.docType)} ${esc(k.docName)}${
          k.pages?.length ? ` · ${k.docType === 'pptx' ? t('slide') : t('page')} ${k.pages.join(', ')}` : ''
        }</a>
      </div>`
    )
    .join('');
}

function glossaryView(concepts, filter) {
  if (!concepts.length) return `<div class="empty-state small"><p>${t('glossaryEmpty')}</p></div>`;
  return `<input type="search" id="g-search" class="search" placeholder="${t('search')}" value="${esc(filter)}">
    <div class="concept-grid" id="g-list">${glossaryItems(concepts, filter)}</div>`;
}

// ---------- Document ----------

async function renderDoc(seq, id) {
  const data = await api(`/api/documents/${id}`);
  if (seq !== viewSeq) return;
  currentCourseId = data.document.courseId;
  const state = { ...data, tab: 'overview', viewLang: getLang(), summary: null, filter: '' };
  await loadSummary(state);
  if (seq !== viewSeq) return;

  main.onclick = async (e) => {
    const chip = e.target.closest('[data-page]');
    if (chip) {
      state.tab = 'source';
      drawDoc(state, seq);
      const target = $(`#page-${chip.dataset.page}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1600);
      }
      return;
    }
    const tab = e.target.closest('[data-dtab]');
    if (tab) {
      state.tab = tab.dataset.dtab;
      drawDoc(state, seq);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'gen') {
      if (state.summary && !confirm(t('confirmRegenerate'))) return;
      try {
        state.document.summaryStatus = await api(`/api/documents/${id}/summarize`, {
          method: 'POST',
          body: { lang: state.viewLang },
        });
        drawDoc(state, seq);
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (act === 'other-lang') {
      state.viewLang = state.viewLang === 'en' ? 'ar' : 'en';
      await loadSummary(state);
      drawDoc(state, seq);
    } else if (act === 'del') {
      if (!confirm(t('confirmDeleteDoc', { name: state.document.name }))) return;
      await api(`/api/documents/${id}`, { method: 'DELETE' });
      location.hash = `#/course/${state.document.courseId}`;
    }
  };

  drawDoc(state, seq);
}

async function loadSummary(state) {
  // Also load while regenerating / after a failed regeneration so the previous guide stays visible.
  state.summary =
    statusOf(state.document, state.viewLang).state !== 'none'
      ? await api(`/api/documents/${state.document.id}/summary?lang=${state.viewLang}`).catch(() => null)
      : null;
}

function drawDoc(state, seq) {
  const { document: doc, course, summary, viewLang } = state;
  const st = statusOf(doc, viewLang);
  const otherLang = viewLang === 'en' ? 'ar' : 'en';
  const otherReady = statusOf(doc, otherLang).state === 'ready';
  const uiLang = getLang();
  const tabs = [
    ['overview', t('overview')],
    ['concepts', `${t('keyConcepts')}${summary ? ` (${summary.keyConcepts.length})` : ''}`],
    ['sections', `${t('sections')}${summary ? ` (${summary.sections.length})` : ''}`],
    ['source', `${t('source')} (${doc.pageCount})`],
  ];

  main.innerHTML = `
    <div class="crumbs"><a href="#/">${t('home')}</a><span>›</span>${
      course ? `<a href="#/course/${course.id}">${esc(course.name)}</a><span>›</span>` : ''
    }<span dir="auto">${esc(doc.name)}</span></div>
    <header class="page-head">
      <div>
        <h1 dir="auto">${docIcon(doc.type)} ${esc(summary?.title || doc.name)}</h1>
        <p class="muted small" dir="auto">${esc(doc.name)} · ${doc.type.toUpperCase()} · ${doc.pageCount} ${unitWord(doc, true)} · ${fmtSize(doc.size)}</p>
      </div>
      <div class="actions">
        ${badge(st)}
        ${isBusy(st) ? '' : `<button class="btn ${summary ? 'ghost' : 'primary'}" data-act="gen">${summary ? '↻ ' + t('regenerate') : '✨ ' + t('generate')}</button>`}
        <a class="btn ghost" href="/api/documents/${doc.id}/file" title="${t('download')}">⬇</a>
        <button class="btn ghost danger" data-act="del" title="${t('delete')}">🗑</button>
      </div>
    </header>
    ${
      viewLang !== uiLang
        ? `<div class="callout"><span>🌐 ${t('lang_' + viewLang)}</span><button class="btn small" data-act="other-lang">${t('backToLang', { lang: t('lang_' + uiLang) })}</button></div>`
        : otherReady
          ? `<div class="lang-switch"><button class="link" data-act="other-lang">🌐 ${t('viewInLang', { lang: t('lang_' + otherLang) })}</button></div>`
          : ''
    }
    ${statusBox(st)}
    <div class="tabs">${tabs.map(([k, label]) => `<button data-dtab="${k}" class="${state.tab === k ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div id="d-body" class="d-body" lang="${viewLang}" dir="${state.tab === 'source' ? 'auto' : viewLang === 'ar' ? 'rtl' : 'ltr'}"></div>`;

  const body = $('#d-body');
  if (state.tab === 'source') body.innerHTML = sourceView(state);
  else if (!summary) body.innerHTML = noSummaryView(st);
  else if (state.tab === 'overview') body.innerHTML = overviewView(state);
  else if (state.tab === 'sections') body.innerHTML = sectionsView(state);
  else if (state.tab === 'concepts') {
    body.innerHTML = conceptsView(state);
    const inp = $('#k-search', body);
    inp.oninput = () => {
      state.filter = inp.value;
      $('#k-list', body).innerHTML = conceptItems(state);
    };
  }

  if (isBusy(st)) pollDocStatus(state, seq);
}

function pollDocStatus(state, seq) {
  // Re-render only when the status changes (preserves scroll position while waiting).
  poll(seq, async () => {
    const before = statusOf(state.document, state.viewLang).state;
    state.document.summaryStatus = await api(`/api/documents/${state.document.id}/status`);
    const after = statusOf(state.document, state.viewLang).state;
    if (after === before) return pollDocStatus(state, seq);
    await loadSummary(state);
    if (seq !== viewSeq) return;
    drawDoc(state, seq);
    if (after === 'ready') toast(`${t('status_ready')} ✔`, 'success');
  });
}

function statusBox(st) {
  if (st.state === 'running') return `<div class="callout info"><span class="spinner"></span><span>${t('generatingHint')}</span></div>`;
  if (st.state === 'pending') return `<div class="callout info"><span>⏳ ${t('queuedHint')}</span></div>`;
  if (st.state === 'error') return `<div class="callout error"><span>⚠️ ${t('errorHint')} ${esc(st.error)}</span></div>`;
  return '';
}

function noSummaryView(st) {
  return `<div class="empty-state">
    <div class="big">${isBusy(st) ? '<span class="spinner lg"></span>' : '✨'}</div>
    <h2>${isBusy(st) ? t('status_' + st.state) : t('noSummary')}</h2>
    <p class="muted">${t('noSummaryHint')}</p>
    ${isBusy(st) ? '' : `<button class="btn primary" data-act="gen">✨ ${t('generate')}</button>`}
  </div>`;
}

function overviewView({ document: doc, summary: s }) {
  return `
    ${s.meta?.truncated ? `<div class="callout warn">⚠️ ${t('truncatedWarn')}</div>` : ''}
    <article class="card prose">${md(s.overview)}</article>
    ${
      s.takeaways.length
        ? `<h3 class="section-title">⭐ ${t('takeaways')}</h3>
           <ol class="card takeaways">${s.takeaways.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`
        : ''
    }
    <div class="two-col">
      ${
        s.prerequisites.length
          ? `<div><h3 class="section-title">🧱 ${t('prerequisites')}</h3>
             <div class="card"><ul class="plain">${s.prerequisites.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>`
          : ''
      }
      ${
        s.goDeeper.length
          ? `<div><h3 class="section-title">🔭 ${t('goDeeper')}</h3>
             <div class="card"><ul class="plain deeper">${s.goDeeper
               .map((g) => `<li><strong>${esc(g.topic)}</strong><span class="muted">${esc(g.why)}</span></li>`)
               .join('')}</ul></div></div>`
          : ''
      }
    </div>
    ${s.meta ? `<p class="muted small meta">${t('generatedWith', { model: esc(s.meta.model), date: fmtDate(s.meta.generatedAt) })}</p>` : ''}`;
}

function sectionsView({ document: doc, summary: s }) {
  return s.sections
    .map(
      (sec, i) => `<section class="card section-card">
        <header><span class="num">${i + 1}</span><h3>${esc(sec.heading)}</h3>${pageChips(doc, sec.pages)}</header>
        <div class="prose">${md(sec.summary)}</div>
      </section>`
    )
    .join('');
}

function conceptItems({ document: doc, summary: s, filter }) {
  const list = s.keyConcepts.filter((k) => matches(k, filter));
  if (!list.length) return `<p class="muted">${t('noResults')}</p>`;
  return list
    .map(
      (k) => `<div class="concept">
        <h4>${esc(k.term)}</h4>
        <p>${esc(k.definition)}</p>
        ${k.example ? `<p class="example"><strong>${t('example')}:</strong> ${esc(k.example)}</p>` : ''}
        ${pageChips(doc, k.pages)}
      </div>`
    )
    .join('');
}

function conceptsView(state) {
  return `<input type="search" id="k-search" class="search" placeholder="${t('search')}" value="${esc(state.filter)}">
    <div class="concept-grid" id="k-list">${conceptItems(state)}</div>`;
}

function sourceView({ document: doc, pages }) {
  return `<div class="source-list">${pages
    .map(
      (p) => `<section class="card page" id="page-${p.n}">
        <header><span class="num">${esc(unitWord(doc))} ${p.n}</span>${p.title ? `<h4 dir="auto">${esc(p.title)}</h4>` : ''}</header>
        <div class="page-text" dir="auto">${p.text ? esc(p.text) : `<span class="muted">${t('emptyPage')}</span>`}</div>
        ${p.notes ? `<details class="notes"><summary>${t('speakerNotes')}</summary><div dir="auto">${esc(p.notes)}</div></details>` : ''}
      </section>`
    )
    .join('')}</div>`;
}

// ---------- Settings ----------

async function renderSettings(seq) {
  const s = await api('/api/settings');
  if (seq !== viewSeq) return;
  main.innerHTML = `
    <div class="crumbs"><a href="#/">${t('home')}</a><span>›</span>${t('settings')}</div>
    <header class="page-head"><h1>⚙️ ${t('settings')}</h1></header>
    <form class="card form" id="settings-form">
      <label>${t('apiKey')}
        <input type="password" name="apiKey" autocomplete="off" placeholder="AIza…" dir="ltr">
      </label>
      <p class="muted small">${t('apiKeyHint')} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">${t('getKey')} ↗</a></p>
      ${
        s.keySource === 'env'
          ? `<p class="small ok">✔ ${t('keyFromEnv', { preview: esc(s.keyPreview) })}</p>`
          : s.hasKey
            ? `<p class="small ok">✔ ${t('keySaved', { preview: esc(s.keyPreview) })} <button type="button" class="link danger" id="clear-key">${t('removeKey')}</button></p>`
            : ''
      }
      <label>${t('model')}
        <input name="model" list="models" value="${esc(s.model)}" dir="ltr" autocomplete="off">
        <datalist id="models"></datalist>
      </label>
      <p class="muted small">${t('modelHint', { model: esc(s.defaultModel) })}
        <button type="button" class="link" id="detect-model">${t('detectModel')}</button></p>
      <div class="row">
        <button class="btn primary" type="submit">${t('save')}</button>
        <button class="btn ghost" type="button" id="test-btn">${t('testConnection')}</button>
        <span id="test-result" class="small"></span>
      </div>
    </form>
    <div class="card">
      <h3>${t('aboutTitle')}</h3>
      <p class="muted">${t('aboutText')}</p>
    </div>`;

  const form = $('#settings-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/api/settings', { method: 'PUT', body: { apiKey: fd.get('apiKey'), model: fd.get('model') } });
      toast(t('saved'), 'success');
      route();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#clear-key')?.addEventListener('click', async () => {
    await api('/api/settings', { method: 'PUT', body: { clearKey: true } });
    route();
  });
  $('#test-btn').onclick = async () => {
    const out = $('#test-result');
    const fd = new FormData(form);
    out.className = 'small muted';
    out.textContent = t('testing');
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: { apiKey: fd.get('apiKey'), model: fd.get('model') } });
      out.className = 'small ok';
      if (r.switchedFrom && r.reason === 'busy') {
        out.textContent = `${t('testOk', { model: r.model })} — ${t('modelBusy', { old: r.switchedFrom, model: r.model })}`;
      } else if (r.switchedFrom) {
        form.elements.model.value = r.model;
        out.textContent = `${t('testOk', { model: r.model })} — ${t('modelSwitched', { old: r.switchedFrom })}`;
      } else out.textContent = t('testOk', { model: r.model });
    } catch (err) {
      out.className = 'small error-text';
      out.textContent = err.message;
    }
  };

  async function loadModels(apply) {
    const key = String(new FormData(form).get('apiKey') || '').trim();
    const r = await api('/api/models', key ? { headers: { 'x-api-key': key } } : {});
    $('#models').innerHTML = r.models.map((m) => `<option value="${esc(m.id)}">${esc(m.displayName)}</option>`).join('');
    if (apply && r.recommended) form.elements.model.value = r.recommended;
    return r;
  }
  if (s.hasKey) loadModels(false).catch(() => {});
  $('#detect-model').onclick = async () => {
    const out = $('#test-result');
    out.className = 'small muted';
    out.textContent = t('testing');
    try {
      const r = await loadModels(true);
      out.className = 'small ok';
      out.textContent = r.recommended ? t('modelDetected', { model: r.recommended, n: r.models.length }) : t('noModels');
    } catch (err) {
      out.className = 'small error-text';
      out.textContent = err.message;
    }
  };
}

// ---------- Boot ----------

applyLang();
window.addEventListener('hashchange', route);
route();
