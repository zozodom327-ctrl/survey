/* SurveyForPerfection — static survey app. No frameworks, no build step. */
(function () {
  'use strict';

  const TYPES = { text: 'Text', yesno: 'Yes / No', duration: 'Duration', message: 'Message' };
  const YESNO = [
    { v: 'yes', label: 'Yes' },
    { v: 'no', label: 'No' },
    { v: 'declined', label: 'Unwilling to answer' },
  ];
  const KEY_PROGRESS = 'dailySurvey.progress';
  const KEY_DRAFT = 'dailySurvey.draft';

  const app = document.getElementById('app');
  const editbarEl = document.getElementById('editbar');

  let live = null;        // normalised survey from survey.json, or null if it failed
  let liveError = null;   // message when survey.json failed to load / validate
  let mode = location.hash === '#edit' ? 'edit' : 'take';

  // ---------- Helpers ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function store(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable (private mode) — app still works */ }
  }
  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  function countWords(s) {
    const t = (s || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function newId() {
    return 'q_' + Math.random().toString(36).slice(2, 8);
  }

  function localDateKey(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function hashString(s) {
    let x = 5381;
    for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
    return (x >>> 0).toString(36);
  }

  function formatDuration(total) {
    const hrs = Math.floor(total / 3600);
    const min = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (total === 0) return '0 min';
    if (hrs > 0) return `${hrs} h ${min} min` + (sec ? ` ${sec} s` : '');
    return `${min} min ${sec} s`;
  }

  function formatElapsed(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)} min ${s % 60} s`;
  }

  const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
  function countWord(n) { return NUMBER_WORDS[n] || String(n); }

  /** Roman numerals up to 39 (beyond that they get unwieldy, so use digits). */
  function roman(n) {
    if (n < 1 || n > 39) return String(n);
    const tens = ['', 'X', 'XX', 'XXX'][Math.floor(n / 10)];
    const ones = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'][n % 10];
    return tens + ones;
  }

  /** "SurveyForPerfection" → "SurveyFor" / pink italic "Perfection" on two lines. Other titles are shown as-is. */
  function styledTitle(t) {
    const m = /^(\S*[a-z]For)([A-Z]\S*)$/.exec(t);
    return m ? [m[1], h('br'), h('em', {}, m[2])] : t;
  }

  function longDate(d) {
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function shortTime(d) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** In-page replacement for confirm(). Resolves true/false. */
  function confirmBox(text, okLabel) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); if (prev) prev.focus(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      const ok = h('button', { type: 'button', class: 'btn-primary btn-danger-fill', onclick: () => done(true) }, okLabel || 'OK');
      const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) done(false); } },
        h('div', { class: 'dialog panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-text' },
          h('p', { id: 'dlg-text' }, text),
          h('div', { class: 'row', style: 'justify-content:flex-end' },
            h('button', { type: 'button', onclick: () => done(false) }, 'Cancel'), ok)));
      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
      ok.focus();
    });
  }

  // ---------- Survey validation ----------

  function isLimit(v) { return v == null || (Number.isInteger(v) && v >= 1); }
  function optText(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

  /** Display names for items by position: "Question 3", "Message 1" (each counted separately). */
  function itemLabels(items) {
    let qn = 0;
    let mn = 0;
    return items.map((q) => (q && q.type === 'message' ? `Message ${++mn}` : `Question ${++qn}`));
  }

  /** Returns { survey, errors[] }. errors items: { index, message } (index null = whole file). */
  function validateSurvey(raw) {
    const errors = [];
    const add = (index, message) => errors.push({ index, message });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      add(null, 'The file is not a survey object (expected { "title": …, "questions": [ … ] }).');
      return { survey: null, errors };
    }
    if (raw.title != null && typeof raw.title !== 'string') add(null, 'The survey title must be text.');
    if (!Array.isArray(raw.questions)) {
      add(null, 'The file has no "questions" list.');
      return { survey: null, errors };
    }
    if (!raw.questions.some((q) => q && q.type !== 'message')) add(null, 'The survey has no questions.');

    const labels = itemLabels(raw.questions);
    const seen = new Set();
    const questions = raw.questions.map((q, i) => {
      const n = labels[i];
      if (!q || typeof q !== 'object') { add(i, `${n} is not a valid entry.`); return null; }
      const out = { id: typeof q.id === 'string' && q.id ? q.id : newId(), type: q.type };
      if (seen.has(out.id)) add(i, `${n} has the same id as an earlier item ("${out.id}").`);
      seen.add(out.id);

      if (q.type === 'message') {
        out.title = typeof q.title === 'string' ? q.title : '';
        if (!out.title.trim()) add(i, `${n} has no title.`);
        out.body = typeof q.body === 'string' ? q.body : '';
        out.showTitle = !!q.showTitle;
        return out;
      }

      if (!TYPES[q.type]) add(i, `${n} has an unknown type "${q.type}" (use text, yesno, duration or message).`);
      out.prompt = typeof q.prompt === 'string' ? q.prompt : '';
      if (!out.prompt.trim()) add(i, `${n} has no prompt.`);
      out.required = q.required !== false;
      if (typeof q.description === 'string') out.description = q.description;
      if (q.type === 'text') {
        out.wordLimit = q.wordLimit ?? null;
        if (!isLimit(out.wordLimit)) add(i, `${n}: word limit must be a whole number of 1 or more.`);
      } else if (q.type === 'yesno' || q.type === 'duration') {
        const r = q.reason && typeof q.reason === 'object' ? q.reason : {};
        out.reason = { enabled: !!r.enabled };
        if (out.reason.enabled) {
          out.reason.wordLimit = r.wordLimit ?? null;
          if (!isLimit(out.reason.wordLimit)) add(i, `${n}: reason word limit must be a whole number of 1 or more.`);
          if (typeof r.label === 'string') out.reason.label = r.label;
          out.reason.required = r.required === true; // older files have no flag: their boxes stay optional
        }
      }
      return out;
    });

    return {
      survey: { version: 1, title: (raw.title || '').trim() || 'SurveyForPerfection', questions: questions.filter(Boolean) },
      errors,
    };
  }

  /** Clean JSON for saving: drops empty limits, labels and descriptions; keeps field order readable. */
  function serialise(survey) {
    const out = {
      version: 1,
      title: survey.title,
      questions: survey.questions.map((q) => {
        if (q.type === 'message') {
          return { id: q.id, type: 'message', title: (q.title || '').trim(), body: (q.body || '').trim(), showTitle: !!q.showTitle };
        }
        const o = { id: q.id, type: q.type, prompt: q.prompt.trim(), required: q.required !== false };
        const desc = optText(q.description);
        if (desc) o.description = desc;
        if (q.type === 'text' && q.wordLimit != null && q.wordLimit !== '') o.wordLimit = q.wordLimit;
        if (q.type !== 'text') {
          o.reason = { enabled: !!(q.reason && q.reason.enabled) };
          if (o.reason.enabled) {
            const label = optText(q.reason.label);
            if (label) o.reason.label = label;
            o.reason.required = q.reason.required === true;
            if (q.reason.wordLimit != null && q.reason.wordLimit !== '') o.reason.wordLimit = q.reason.wordLimit;
          }
        }
        return o;
      }),
    };
    return JSON.stringify(out, null, 2) + '\n';
  }

  // ---------- Loading ----------

  async function loadLive() {
    let res;
    try {
      res = await fetch('survey.json?v=' + Date.now(), { cache: 'no-store' });
    } catch (e) {
      const hint = location.protocol === 'file:'
        ? ' Pages opened straight from disk can\'t load files — run "python -m http.server" in the folder and open http://localhost:8000.'
        : ' Check your connection and refresh.';
      throw new Error('Couldn\'t load survey.json.' + hint);
    }
    if (!res.ok) throw new Error(`Couldn't find survey.json (server said ${res.status}). Make sure it sits next to index.html.`);
    const text = await res.text();
    let raw;
    try { raw = JSON.parse(text); } catch (e) {
      throw new Error('survey.json isn\'t valid JSON: ' + e.message + '. A missing comma or quote is the usual cause.');
    }
    const { survey, errors } = validateSurvey(raw);
    if (errors.length) throw new Error('survey.json has problems:\n• ' + errors.map((e) => e.message).join('\n• '));
    return survey;
  }

  function showError(title, message) {
    app.replaceChildren(
      h('div', { class: 'panel stack', role: 'alert' },
        h('h2', {}, title),
        h('pre', { class: 'err-list' }, message),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => location.reload() }, 'Try again'))
      )
    );
  }

  // ---------- Routing ----------
  // The editor is hidden from respondents: Ctrl+E (Cmd+E on Mac) toggles it.
  // Opening the link with #edit also works, for phones without a keyboard.

  function route() {
    editbarEl.hidden = mode !== 'edit';
    app.className = 'container' + (mode === 'edit' ? ' editor-wide' : '');
    if (mode === 'edit') Editor.open();
    else startTake();
  }

  function setMode(m) {
    mode = m;
    if (m === 'take' && location.hash === '#edit') {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    }
    route();
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setMode(mode === 'edit' ? 'take' : 'edit');
    }
  });
  document.getElementById('close-editor').addEventListener('click', () => setMode('take'));
  window.addEventListener('hashchange', () => { mode = location.hash === '#edit' ? 'edit' : 'take'; route(); });

  function startTake() {
    if (!live) { showError('This survey can\'t be loaded', liveError || 'Unknown problem.'); return; }
    Runner.start(live, { preview: false });
  }

  // ---------- Survey runner ----------

  const Runner = (() => {
    let survey, preview, state, onExit;

    function surveyHash(s) { return hashString(serialise(s)); }

    function save() { if (!preview) store(KEY_PROGRESS, state); }

    function start(s, opts) {
      survey = s;
      preview = !!opts.preview;
      onExit = opts.onExit || null;
      state = null;
      const saved = preview ? null : load(KEY_PROGRESS);
      const today = localDateKey(new Date());
      if (saved && (saved.date !== today || saved.hash !== surveyHash(s))) store(KEY_PROGRESS, undefined);
      const resumable = saved && saved.date === today && saved.hash === surveyHash(s) ? saved : null;
      renderStart(resumable);
    }

    function freshState() {
      return { date: localDateKey(new Date()), hash: surveyHash(survey), startedAt: Date.now(), index: 0, answers: {} };
    }

    function previewBanner() {
      if (!preview) return null;
      return h('div', { class: 'banner row spread' },
        h('span', {}, h('strong', {}, 'Preview'), ' — trying your draft. Nothing is saved.'),
        h('button', { type: 'button', class: 'btn-small', onclick: () => onExit && onExit() }, 'Back to editor'));
    }

    function renderStart(resumable) {
      const n = survey.questions.filter((q) => q.type !== 'message').length;
      const begin = () => { state = freshState(); save(); renderQuestion(); };
      const actions = resumable
        ? [
            h('p', {}, 'Continue where you left off?'),
            h('div', { class: 'row center' },
              h('button', { type: 'button', class: 'btn-primary', onclick: () => { state = resumable; renderQuestion(); } },
                'Continue'),
              h('button', { type: 'button', onclick: begin }, 'Start over')),
          ]
        : [h('button', { type: 'button', class: 'btn-primary btn-start', onclick: begin }, 'Start')];
      app.replaceChildren(
        h('section', { class: 'start' },
          previewBanner(),
          h('div', { class: 'bookplate' },
            h('div', { class: 'bookplate-inner' },
              h('h1', { class: 'big-title' }, styledTitle(survey.title)),
              h('p', { class: 'start-date' }, longDate(new Date())),
              h('p', { class: 'start-count' }, `${countWord(n)} question${n === 1 ? '' : 's'}`))),
          h('div', { class: 'start-actions' }, actions))
      );
      const first = app.querySelector('.btn-primary');
      if (first) first.focus();
    }

    /** A required reason is asked for once the main answer is given, but never after "Unwilling to answer". */
    function reasonNeeded(q, a) {
      if (!q.reason || !q.reason.enabled || !q.reason.required) return false;
      if (q.type === 'yesno') return !!a.value && a.value !== 'declined';
      return [a.h, a.m, a.s].some((v) => v != null && v !== '');
    }

    /** Checks the current answer. Returns { ok, message }. */
    function check(q, a) {
      a = a || {};
      const overReason = q.reason && q.reason.enabled && q.reason.wordLimit && countWords(a.reason) > q.reason.wordLimit;
      if (q.type === 'text') {
        if (q.wordLimit && countWords(a.text) > q.wordLimit) return { ok: false, message: 'Please shorten your answer' };
        if (q.required && !(a.text || '').trim()) return { ok: false };
      } else if (q.type === 'yesno') {
        if (q.required && !a.value) return { ok: false };
      } else if (q.type === 'duration') {
        const f = [a.h, a.m, a.s];
        const max = [23, 59, 59];
        for (let i = 0; i < 3; i++) {
          const v = f[i];
          if (v == null || v === '') continue;
          if (!/^\d+$/.test(v) || +v > max[i]) {
            return { ok: false, message: ['Hours must be 0–23', 'Minutes must be 0–59', 'Seconds must be 0–59'][i] };
          }
        }
        if (q.required && f.every((v) => v == null || v === '')) return { ok: false };
      }
      if (overReason) return { ok: false, message: 'Please shorten your reason' };
      if (reasonNeeded(q, a) && !(a.reason || '').trim()) return { ok: false };
      return { ok: true };
    }

    function wordBox(opts) {
      // opts: { id, label, multiline, value, limit, onInput, onEnter }
      const counter = opts.limit ? h('div', { class: 'counter', id: opts.id + '-count', 'aria-live': 'polite' }) : null;
      const input = opts.multiline
        ? h('textarea', { id: opts.id, rows: 4, 'aria-describedby': counter ? counter.id : null })
        : h('input', { id: opts.id, type: 'text', autocomplete: 'off', 'aria-describedby': counter ? counter.id : null });
      input.value = opts.value || '';
      const update = () => {
        if (counter) {
          const n = countWords(input.value);
          counter.textContent = `${n} / ${opts.limit} words`;
          counter.classList.toggle('over', n > opts.limit);
        }
      };
      input.addEventListener('input', () => { update(); opts.onInput(input.value); });
      if (!opts.multiline && opts.onEnter) {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); opts.onEnter(); } });
      }
      update();
      return h('div', {}, opts.label ? h('label', { for: opts.id }, opts.label) : null, input, counter);
    }

    function renderQuestion() {
      const i = state.index;
      const q = survey.questions[i];
      const isLast = i === survey.questions.length - 1;
      // Messages don't count as questions in the numbering or progress.
      const totalQ = survey.questions.filter((x) => x.type !== 'message').length;
      const qNum = survey.questions.slice(0, i + 1).filter((x) => x.type !== 'message').length;
      const isMessage = q.type === 'message';
      const a = isMessage ? {} : state.answers[q.id] || (state.answers[q.id] = {});

      const errEl = h('div', { class: 'field-error', role: 'status' });
      const nextBtn = h('button', { type: 'button', class: 'btn-primary', onclick: goNext }, isLast ? 'Finish' : 'Next');
      const backBtn = h('button', { type: 'button', onclick: goBack }, 'Back');

      function refresh() {
        const r = isMessage ? { ok: true } : check(q, a);
        nextBtn.disabled = !r.ok;
        errEl.textContent = r.message || '';
        save();
      }
      function goNext() {
        if (!isMessage && !check(q, a).ok) return;
        if (isLast) return finish();
        state.index++;
        save();
        renderQuestion();
      }
      function goBack() {
        if (i === 0) { renderStart(null); return; }
        state.index--;
        save();
        renderQuestion();
      }

      if (isMessage) {
        app.replaceChildren(
          h('section', {},
            previewBanner(),
            progress(qNum, totalQ),
            h('h2', { class: 'prompt', tabindex: '-1' }, q.title),
            optText(q.body) ? h('p', { class: 'message-body' }, q.body.trim()) : null,
            h('div', { class: 'nav' }, backBtn, nextBtn))
        );
        save();
        app.querySelector('.prompt').focus();
        return;
      }

      const promptId = 'prompt-' + q.id;
      const desc = optText(q.description);
      const descId = desc ? 'desc-' + q.id : null;
      let body;
      if (q.type === 'text') {
        body = wordBox({
          id: 'ans', multiline: true, value: a.text, limit: q.wordLimit,
          onInput: (v) => { a.text = v; refresh(); },
        });
        body.querySelector('textarea').setAttribute('aria-labelledby', promptId);
      } else if (q.type === 'yesno') {
        const btns = YESNO.map((o) => h('button', {
          type: 'button', class: 'choice', 'data-v': o.v, 'aria-pressed': String(a.value === o.v),
          onclick: () => {
            a.value = o.v;
            for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.v === o.v));
            refresh();
          },
        }, o.label));
        body = h('div', { class: 'choices', role: 'group', 'aria-labelledby': promptId }, btns);
      } else {
        const field = (key, label, max) => {
          const id = 'dur-' + key;
          const input = h('input', {
            id, type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '2',
            autocomplete: 'off', placeholder: '0', 'aria-label': label + ` (0–${max})`,
          });
          input.value = a[key] ?? '';
          input.addEventListener('input', () => { a[key] = input.value.trim(); refresh(); });
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } });
          return h('div', {}, h('label', { for: id, 'aria-hidden': 'true' }, label), input);
        };
        body = h('div', { class: 'duration', role: 'group', 'aria-labelledby': promptId },
          field('h', 'Hours', 23), field('m', 'Minutes', 59), field('s', 'Seconds', 59));
      }

      let reason = null;
      if (q.reason && q.reason.enabled) {
        reason = h('div', { class: 'reason' }, wordBox({
          id: 'reason', label: (optText(q.reason.label) || 'Reason') + (q.reason.required ? '' : ' (optional)'), value: a.reason, limit: q.reason.wordLimit,
          onInput: (v) => { a.reason = v; refresh(); }, onEnter: goNext,
        }));
      }

      app.replaceChildren(
        h('section', {},
          previewBanner(),
          h('p', { class: 'qcount', 'aria-label': `Question ${qNum} of ${totalQ}` }, `Question ${roman(qNum)} of ${roman(totalQ)}`),
          progress(qNum, totalQ),
          h('h2', { class: 'prompt', id: promptId, tabindex: '-1', 'aria-describedby': descId }, q.prompt),
          desc ? h('p', { class: 'qdesc', id: descId }, desc) : null,
          body, reason, errEl,
          h('div', { class: 'nav' }, backBtn, nextBtn))
      );
      refresh();
      app.querySelector('.prompt').focus();
    }

    function finish() {
      const finishedAt = Date.now();
      const results = {
        title: survey.title,
        finishedAt,
        elapsed: finishedAt - state.startedAt,
        // Messages appear on the card only as section headings, and only when ticked.
        items: survey.questions
          .filter((q) => q.type !== 'message' || q.showTitle)
          .map((q) => (q.type === 'message'
            ? { q, heading: q.title.trim() }
            : { q, a: toAnswer(q, state.answers[q.id] || {}) })),
      };
      if (!preview) store(KEY_PROGRESS, undefined);
      // The card is drawn with web fonts, so wait (briefly) for them before drawing.
      app.replaceChildren(h('p', { class: 'preparing', role: 'status' }, 'Preparing your card…'));
      ResultCard.ready().then(() => renderResults(results));
    }

    /** Segmented progress for short surveys, a plain bar for long ones. */
    function progress(n, total) {
      const attrs = { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(n), 'aria-label': 'Progress' };
      if (total <= 30) {
        const segs = [];
        for (let k = 1; k <= total; k++) segs.push(h('span', { class: k <= n ? 'on' : null }));
        return h('div', { class: 'segments', ...attrs }, segs);
      }
      return h('div', { class: 'bar', ...attrs }, h('div', { style: `width:${(n / total) * 100}%` }));
    }

    function toAnswer(q, a) {
      const reason = q.reason && q.reason.enabled && (a.reason || '').trim() ? a.reason.trim() : null;
      if (q.type === 'text') return { text: (a.text || '').trim() || null };
      if (q.type === 'yesno') return { value: a.value || null, reason };
      const f = [a.h, a.m, a.s];
      if (f.every((v) => v == null || v === '')) return { seconds: null, reason };
      return { seconds: (+a.h || 0) * 3600 + (+a.m || 0) * 60 + (+a.s || 0), reason };
    }

    function renderResults(results) {
      const canvas = ResultCard.draw(results);
      const img = h('img', { class: 'result-img', alt: 'Results image: ' + ResultCard.asText(results).replace(/[*_>]/g, '').replace(/\n+/g, '. ') });
      img.src = canvas.toDataURL('image/png');
      const status = h('div', { class: 'status', role: 'status' });
      const fileName = 'checkin-' + localDateKey(new Date(results.finishedAt)) + '.png';

      const copyImage = async () => {
        try {
          if (!navigator.clipboard || !window.ClipboardItem) throw new Error('unsupported');
          const blob = new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no blob'))), 'image/png'));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          status.textContent = 'Copied — paste into Discord';
        } catch (e) {
          status.textContent = 'This browser blocked copying the image. Use Download image instead, then attach the file in Discord.';
        }
      };
      const download = () => {
        canvas.toBlob((b) => {
          const url = URL.createObjectURL(b);
          const link = h('a', { href: url, download: fileName });
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          status.textContent = 'Downloaded ' + fileName;
        }, 'image/png');
      };
      const copyText = async () => {
        try {
          await navigator.clipboard.writeText(ResultCard.asText(results));
          status.textContent = 'Text copied — paste into Discord';
        } catch (e) {
          status.textContent = 'Couldn\'t copy text in this browser.';
        }
      };

      app.replaceChildren(
        h('section', {},
          previewBanner(),
          h('h2', { tabindex: '-1', id: 'done', class: 'done-title' }, 'All done'),
          img,
          h('div', { class: 'result-actions' },
            h('button', { type: 'button', class: 'btn-primary', onclick: copyImage }, 'Copy image'),
            h('button', { type: 'button', onclick: download }, 'Download'),
            h('button', { type: 'button', onclick: copyText }, 'Copy as text'),
            h('button', { type: 'button', onclick: () => start(survey, { preview, onExit }) }, 'Start over')),
          status)
      );
      document.getElementById('done').focus();
    }

    return { start };
  })();

  // ---------- Results image (canvas) ----------

  const ResultCard = (() => {
    const W = 800;
    const SCALE = 2;
    const X0 = 50;               // content edge: 14 outer margin + 6 frame gap + 30 padding
    const INNER = W - X0 * 2;
    const GAP = 44;              // between the two columns
    const ITEM_GAP = 18;         // below each question
    const SERIF = 'Fraunces, Georgia, "Times New Roman", serif';
    const BODY = 'Newsreader, Georgia, "Times New Roman", serif';
    const C = {
      bg: '#151015', frame: '#ff5cb8', inner: '#47384a', rule: '#3d2f3b',
      title: '#f6ebf1', sub: '#d2c1cb', q: '#bfaab6', answer: '#f6ebf1', faint: '#8f7d8a',
    };
    // Pink and grey: Yes = pink, No = solid grey, Unwilling = grey outline. The word is always shown.
    const PILL = {
      yes: { label: 'Yes', bg: '#ff5cb8', fg: '#1a0f17' },
      no: { label: 'No', bg: '#6f6470', fg: '#ffffff' },
      declined: { label: YESNO[2].label, bg: null, border: '#8f7d8a', fg: '#d2c1cb' },
    };
    const FONTS = ['600 38px Fraunces', 'italic 600 22px Fraunces', '400 16px Newsreader', 'italic 400 16px Newsreader', '600 21px Newsreader'];

    /** Resolves once the card's fonts are loaded, or after 2.5 s so a slow network never blocks the card. */
    function ready() {
      if (!document.fonts || !document.fonts.load) return Promise.resolve();
      const loads = Promise.all(FONTS.map((f) => document.fonts.load(f))).catch(() => {});
      return Promise.race([loads, new Promise((r) => setTimeout(r, 2500))]);
    }

    /** Splits an answer into what the card shows. A custom reason label puts the reason on its own lines. */
    function answerParts(item) {
      const { q, a } = item;
      if (q.type === 'text') return { pill: null, text: a.text };
      const label = q.reason && q.reason.enabled ? optText(q.reason.label) : null;
      const d = q.type === 'duration' && a.seconds != null ? formatDuration(a.seconds) : null;
      if (label) return { pill: q.type === 'yesno' ? a.value : null, text: d, reasonLabel: label, reason: a.reason };
      if (q.type === 'yesno') return { pill: a.value, text: a.reason };
      return { pill: null, text: d && a.reason ? `${d} — ${a.reason}` : d || (a.reason ? '— ' + a.reason : null) };
    }

    /** Word-wraps text; the first line may be narrower (to sit beside a pill). Breaks over-long words. */
    function wrap(ctx, text, width, firstWidth) {
      const lines = [];
      const fits = (s, w) => ctx.measureText(s).width <= w;
      for (const para of String(text).split(/\n/)) {
        let line = '';
        const limit = () => (lines.length === 0 ? firstWidth : width);
        for (let word of para.split(/\s+/).filter(Boolean)) {
          // A word that won't fit beside the pill but fits a full line starts on the next line.
          if (lines.length === 0 && !line && !fits(word, firstWidth) && fits(word, width)) lines.push('');
          while (!fits(word, limit())) {
            if (line) { lines.push(line); line = ''; continue; }
            let cut = word.length - 1;
            while (cut > 1 && !fits(word.slice(0, cut), limit())) cut--;
            lines.push(word.slice(0, cut));
            word = word.slice(cut);
          }
          const test = line ? line + ' ' + word : word;
          if (!fits(test, limit()) && line) { lines.push(line); line = word; } else line = test;
        }
        lines.push(line);
      }
      return lines;
    }

    /** Lays out one question + answer (or a message heading) at (0, 0). Returns { ops, h, heading }. */
    function measureItem(ctx, item, width, sz, lh) {
      const ops = [];
      let y = 0;
      const lines = (str, font, color, size) => {
        ctx.font = font;
        for (const line of wrap(ctx, str, width, width)) {
          ops.push({ kind: 'text', str: line, x: 0, y, font, color, size });
          y += lh(size);
        }
      };

      if (item.heading != null) {
        lines(item.heading, `italic 600 ${sz.head}px ${SERIF}`, C.frame, sz.head);
        return { ops, h: y + 10, heading: true };
      }

      lines(item.q.prompt, `400 ${sz.q}px ${BODY}`, C.q, sz.q);
      y += 3;

      const { pill, text, reasonLabel, reason } = answerParts(item);
      const aFont = `${pill ? 400 : 600} ${sz.a}px ${BODY}`;
      const rowH = lh(sz.a);
      let firstWidth = width;
      let x0 = 0;
      if (pill) {
        const p = PILL[pill];
        const pFont = `600 ${sz.pill}px ${BODY}`;
        ctx.font = pFont;
        const label = '● ' + p.label;
        const pw = Math.ceil(ctx.measureText(label).width) + 24;
        const ph = Math.round(sz.pill * 1.65);
        ops.push({ kind: 'pill', x: 0, y: y + (rowH - ph) / 2, w: pw, h: ph, label, font: pFont, p });
        firstWidth = width - pw - 10;
        x0 = pw + 10;
      }
      if (text) {
        ctx.font = aFont;
        wrap(ctx, text, width, firstWidth).forEach((line, li) => {
          if (line) ops.push({ kind: 'text', str: line, x: li === 0 ? x0 : 0, y, font: aFont, color: C.answer, size: sz.a });
          y += rowH;
        });
      } else {
        if (!pill) ops.push({ kind: 'text', str: '—', x: 0, y, font: aFont, color: C.faint, size: sz.a });
        y += rowH;
      }

      if (reason) {
        y += 4;
        lines(reasonLabel, `italic 400 ${sz.q}px ${BODY}`, C.q, sz.q);
        lines(reason, `400 ${sz.a}px ${BODY}`, C.answer, sz.a);
      }
      return { ops, h: y + ITEM_GAP };
    }

    function layout(ctx, results, k) {
      const f = (n) => Math.round(n * k);
      const sz = { date: f(38), sub: f(19), small: f(16), q: f(16), a: f(21), pill: f(16), head: f(22) };
      const lh = (s) => Math.round(s * 1.3);
      const ops = [];
      let y = 48;

      const header = (str, font, color, size) => {
        ctx.font = font;
        for (const line of wrap(ctx, str, INNER, INNER)) {
          ops.push({ kind: 'text', str: line, x: X0, y, font, color, size });
          y += lh(size);
        }
      };
      const d = new Date(results.finishedAt);
      header(longDate(d), `600 ${sz.date}px ${SERIF}`, C.title, sz.date);
      y += 4;
      header(`Completed ${shortTime(d)} · took ${formatElapsed(results.elapsed)}`, `400 ${sz.sub}px ${BODY}`, C.sub, sz.sub);
      header(results.title, `italic 400 ${sz.small}px ${BODY}`, C.frame, sz.small);
      y += 18;
      ops.push({ kind: 'hrule', y });
      y += 22;

      // Two columns read like a book spread: down the left, then down the right.
      const twoCol = results.items.length > 1;
      const colW = twoCol ? (INNER - GAP) / 2 : INNER;
      const blocks = results.items.map((item) => measureItem(ctx, item, colW, sz, lh));
      let split = blocks.length;
      if (twoCol) {
        const total = blocks.reduce((s, b) => s + b.h, 0);
        let best = Infinity;
        let acc = 0;
        for (let i = 1; i < blocks.length; i++) {
          acc += blocks[i - 1].h;
          if (blocks[i - 1].heading) continue; // never leave a heading at the foot of the left column
          const tallest = Math.max(acc, total - acc);
          if (tallest < best) { best = tallest; split = i; }
        }
      }
      const top = y;
      const colH = [0, 0];
      blocks.forEach((b, i) => {
        const col = i < split ? 0 : 1;
        const bx = X0 + col * (colW + GAP);
        const by = top + colH[col];
        for (const op of b.ops) ops.push({ ...op, x: op.x + bx, y: op.y + by });
        colH[col] += b.h;
      });
      const bottom = top + Math.max(colH[0], colH[1]) - ITEM_GAP;
      if (twoCol) ops.push({ kind: 'vrule', x: X0 + colW + GAP / 2, y0: top, y1: bottom });
      return { ops, height: Math.ceil(bottom + 34) };
    }

    function draw(results) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let k = 1;
      let res = layout(ctx, results, k);
      while (res.height > 4000 && k > 0.55) { k -= 0.1; res = layout(ctx, results, k); }

      const H = res.height;
      canvas.width = W * SCALE;
      canvas.height = H * SCALE;
      ctx.scale(SCALE, SCALE);

      // Card and its double bookplate frame.
      roundRect(ctx, 0, 0, W, H, 20);
      ctx.fillStyle = C.bg;
      ctx.fill();
      ctx.lineWidth = 1;
      roundRect(ctx, 14.5, 14.5, W - 29, H - 29, 10);
      ctx.strokeStyle = C.frame;
      ctx.stroke();
      roundRect(ctx, 20.5, 20.5, W - 41, H - 41, 6);
      ctx.strokeStyle = C.inner;
      ctx.stroke();

      for (const op of res.ops) {
        if (op.kind === 'text') {
          ctx.font = op.font;
          ctx.fillStyle = op.color;
          ctx.textBaseline = 'top';
          ctx.fillText(op.str, op.x, op.y + op.size * 0.1);
        } else if (op.kind === 'hrule') {
          ctx.fillStyle = C.inner;
          ctx.fillRect(X0, op.y, INNER, 1);
        } else if (op.kind === 'vrule') {
          ctx.fillStyle = C.rule;
          ctx.fillRect(op.x, op.y0, 1, op.y1 - op.y0);
        } else if (op.kind === 'pill') {
          roundRect(ctx, op.x + 0.75, op.y + 0.75, op.w - 1.5, op.h - 1.5, op.h / 2);
          if (op.p.bg) { ctx.fillStyle = op.p.bg; ctx.fill(); }
          if (op.p.border) { ctx.lineWidth = 1.5; ctx.strokeStyle = op.p.border; ctx.stroke(); ctx.lineWidth = 1; }
          ctx.font = op.font;
          ctx.fillStyle = op.p.fg;
          ctx.textBaseline = 'middle';
          ctx.fillText(op.label, op.x + 12, op.y + op.h / 2 + 1);
        }
      }
      return canvas;
    }

    function roundRect(ctx, x, y, w, hgt, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + hgt, r);
      ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
      ctx.arcTo(x, y + hgt, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function asText(results) {
      const d = new Date(results.finishedAt);
      const out = [
        `**${longDate(d)}**`,
        `Completed ${shortTime(d)} · took ${formatElapsed(results.elapsed)}`,
        results.title,
        '',
      ];
      for (const item of results.items) {
        if (item.heading != null) { out.push(`__${item.heading}__`, ''); continue; }
        const { pill, text, reasonLabel, reason } = answerParts(item);
        const ans = pill ? PILL[pill].label + (text ? ' — ' + text : '') : text || '—';
        out.push(item.q.prompt, '> ' + ans.replace(/\n/g, '\n> '));
        if (reason) out.push(`> *${/[?:.!]$/.test(reasonLabel) ? reasonLabel : reasonLabel + ':'}* ` + reason.replace(/\n/g, '\n> '));
        out.push('');
      }
      return out.join('\n').trim();
    }

    return { draw, asText, ready };
  })();

  // ---------- Publishing straight to GitHub ----------
  // Optional. With a fine-grained token (this repo only, "Contents: Read and write") the editor
  // commits survey.json itself. The token is kept in this browser's storage and nowhere else.

  const KEY_GITHUB = 'dailySurvey.github';

  const GitHub = (() => {
    function settings() { return load(KEY_GITHUB) || {}; }
    function saveSettings(s) { store(KEY_GITHUB, s); }
    function connected() { const s = settings(); return !!(s.token && s.owner && s.repo); }

    /** Guesses owner/repo from a GitHub Pages address: <owner>.github.io/<repo>/ */
    function guess() {
      const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
      if (!m) return {};
      const seg = location.pathname.split('/').filter(Boolean)[0];
      return { owner: m[1], repo: seg && !seg.includes('.') ? seg : `${m[1]}.github.io` };
    }

    function toBase64(text) {
      const bytes = new TextEncoder().encode(text);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    function fromBase64(b64) {
      const bin = atob(b64.replace(/\s/g, ''));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }

    async function api(method, body) {
      const s = settings();
      const path = (s.path || 'survey.json').replace(/^\/+/, '');
      const branch = s.branch || 'main';
      const where = `${s.owner}/${s.repo}`;
      const url = `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/`
        + path.split('/').map(encodeURIComponent).join('/')
        + (method === 'GET' ? `?ref=${encodeURIComponent(branch)}` : '');
      let res;
      try {
        res = await fetch(url, {
          method,
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${s.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new Error('Couldn\'t reach GitHub. Check your connection and try again.');
      }
      if (res.ok) return res.json();
      const reasons = {
        401: 'GitHub rejected the token. It may have expired or been revoked: create a new one and connect again.',
        403: `The token isn't allowed to change ${where}. Check it has "Contents: Read and write" access to that repository.`,
        404: `GitHub couldn't find ${path} on the ${branch} branch of ${where}, or the token doesn't have access to that repository.`,
        409: 'survey.json changed on GitHub while you were publishing. Press Publish again to retry.',
        422: 'survey.json changed on GitHub while you were publishing. Press Publish again to retry.',
      };
      throw new Error(reasons[res.status] || `GitHub returned an error (${res.status}). Try again in a moment.`);
    }

    /** Reads the current file: { sha, text }. */
    async function fetchFile() {
      const j = await api('GET');
      return { sha: j.sha, text: fromBase64(j.content || '') };
    }

    /** Commits new file text on top of `sha`. Returns the commit's web address. */
    async function commit(text, sha) {
      const j = await api('PUT', { message: 'Update survey questions', content: toBase64(text), sha, branch: settings().branch || 'main' });
      return j.commit && j.commit.html_url;
    }

    return { settings, saveSettings, connected, guess, fetchFile, commit };
  })();

  // ---------- Editor ----------

  const Editor = (() => {
    let draft = null;
    let errors = [];       // from last validation attempt (shown on cards)
    let showErrors = false;
    let listEl, dirtyEl, msgEl;

    function persist() {
      store(KEY_DRAFT, draft);
      updateDirty();
      if (showErrors) markErrors();
    }

    function isDirty() {
      if (!live) return true;
      return serialise(draft) !== serialise(live);
    }

    function updateDirty() {
      if (!dirtyEl) return;
      const dirty = isDirty();
      dirtyEl.textContent = dirty ? 'Draft has unsaved changes' : 'Matches the live survey';
      dirtyEl.className = dirty ? 'dirty' : 'saved';
    }

    function open() {
      if (!draft) {
        const saved = load(KEY_DRAFT);
        draft = saved && Array.isArray(saved.questions) ? saved : live ? clone(live) : { version: 1, title: 'SurveyForPerfection', questions: [] };
      }
      render();
    }

    function blank(type) {
      if (type === 'message') return { id: newId(), type, title: '', body: '', showTitle: false };
      const q = { id: newId(), type, prompt: '', required: true };
      if (type === 'text') q.wordLimit = null;
      else q.reason = { enabled: false, required: true, wordLimit: null };
      return q;
    }

    function parseLimit(v) {
      v = v.trim();
      if (v === '') return null;
      return /^\d+$/.test(v) ? parseInt(v, 10) : v; // keep bad input so validation can flag it
    }

    function message(text, isError) {
      msgEl.replaceChildren(...(Array.isArray(text) ? text : [text]));
      msgEl.className = 'banner' + (isError ? ' error-text' : '');
      msgEl.hidden = !text;
    }

    function validateDraft() {
      const res = validateSurvey(draft);
      errors = res.errors;
      showErrors = true;
      markErrors();
      if (errors.length) {
        message(['Fix these before saving:', h('pre', { class: 'err-list' }, '• ' + errors.map((e) => e.message).join('\n• '))], true);
        const firstBad = listEl.querySelector('.qcard.invalid');
        if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return false;
      }
      return true;
    }

    function markErrors() {
      errors = validateSurvey(draft).errors;
      for (const card of listEl.children) {
        const i = +card.dataset.index;
        const mine = errors.filter((e) => e.index === i);
        card.classList.toggle('invalid', mine.length > 0);
        card.querySelector('.card-errors').textContent = mine.map((e) => e.message.replace(/^(Question|Message) \d+:? ?/, '')).join(' ');
      }
      if (!errors.length && msgEl && msgEl.classList.contains('error-text')) message('', false);
    }

    function render() {
      dirtyEl = h('span', { 'aria-live': 'polite' });
      msgEl = h('div', { class: 'banner', role: 'status', hidden: true });
      listEl = h('div', {});

      const titleInput = h('input', { id: 'ed-title', type: 'text', value: draft.title || '' });
      titleInput.addEventListener('input', () => { draft.title = titleInput.value; persist(); });

      const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
      fileInput.addEventListener('change', () => importFile(fileInput));

      app.replaceChildren(
        h('section', {},
          h('div', { class: 'toolbar panel' },
            h('div', {}, h('label', { for: 'ed-title' }, 'Survey title'), titleInput),
            h('div', { class: 'row' },
              h('span', { class: 'muted' }, 'Add:'),
              Object.entries(TYPES).map(([t, label]) => h('button', { type: 'button', class: 'btn-small', onclick: () => addQuestion(t) }, '+ ' + label))),
            h('div', { class: 'row' },
              h('button', { type: 'button', onclick: tryIt }, 'Try it'),
              GitHub.connected()
                ? [h('button', { type: 'button', class: 'btn-primary', onclick: publish }, 'Publish'),
                  h('button', { type: 'button', onclick: saveFile }, 'Download')]
                : h('button', { type: 'button', class: 'btn-primary', onclick: saveFile }, 'Save'),
              h('button', { type: 'button', onclick: copyJson }, 'Copy JSON'),
              h('button', { type: 'button', onclick: () => fileInput.click() }, 'Import'),
              h('button', { type: 'button', class: 'btn-danger', onclick: revert }, 'Revert'),
              fileInput),
            dirtyEl),
          githubPanel(),
          msgEl,
          !live ? h('div', { class: 'banner error-text' }, 'The live survey.json could not be loaded: ', liveError) : null,
          listEl)
      );
      renderList();
      updateDirty();
    }

    function renderList(focusSelector) {
      listEl.replaceChildren(...draft.questions.map((q, i) => card(q, i)));
      if (!draft.questions.length) listEl.append(h('p', { class: 'muted' }, 'No questions yet. Add one above.'));
      if (showErrors) markErrors();
      if (focusSelector) {
        const el = listEl.querySelector(focusSelector);
        if (el) el.focus();
      }
    }

    function card(q, i) {
      const n = draft.questions.length;
      const name = itemLabels(draft.questions)[i];
      const pid = `p-${q.id}`;

      const checkbox = (label, checked, onChange) => {
        const box = h('input', { type: 'checkbox', checked });
        box.addEventListener('change', () => onChange(box.checked));
        return h('label', {}, box, label);
      };
      const limitField = (label, value, onChange) => {
        const inp = h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: 'none', value: value ?? '' });
        inp.addEventListener('input', () => onChange(parseLimit(inp.value)));
        return h('label', {}, label, inp);
      };
      const textField = (label, value, placeholder, onChange) => {
        const inp = h('input', { type: 'text', value: value || '', placeholder });
        inp.addEventListener('input', () => onChange(inp.value));
        return h('label', { class: 'grow' }, label, inp);
      };
      const textArea = (labelText, value, placeholder, onChange) => {
        const id = `ta-${q.id}-${labelText.replace(/\W+/g, '')}`;
        const ta = h('textarea', { id, class: 'ed-text', rows: 3, placeholder });
        ta.value = value || '';
        ta.addEventListener('input', () => onChange(ta.value));
        return h('div', { class: 'ed-block' }, h('label', { for: id, class: 'sr-only' }, `${name} ${labelText}`), ta);
      };

      let main;
      let opts;
      let extra = null;
      if (q.type === 'message') {
        main = h('input', { id: pid, type: 'text', value: q.title, placeholder: 'Message title' });
        main.addEventListener('input', () => { q.title = main.value; persist(); });
        extra = textArea('description', q.body, 'What should people read here? (instructions, a reminder…)', (v) => { q.body = v; persist(); });
        opts = [checkbox('Show title on results card', !!q.showTitle, (v) => { q.showTitle = v; persist(); })];
      } else {
        main = h('input', { id: pid, type: 'text', value: q.prompt, placeholder: 'Question text' });
        main.addEventListener('input', () => { q.prompt = main.value; persist(); });

        // Description: shown under the prompt while answering, never on the results card.
        const desc = textArea('description', q.description, 'Extra help for answering (not shown on the results card)', (v) => { q.description = v; persist(); });
        desc.hidden = typeof q.description !== 'string';
        extra = desc;

        opts = [
          checkbox('Required', q.required !== false, (v) => { q.required = v; persist(); }),
          checkbox('Add description', typeof q.description === 'string', (v) => {
            if (v) q.description = q.description || ''; else delete q.description;
            desc.hidden = !v;
            if (v) desc.querySelector('textarea').focus();
            persist();
          }),
        ];
        if (q.type === 'text') {
          opts.push(limitField('Word limit', q.wordLimit, (v) => { q.wordLimit = v; persist(); }));
        } else {
          q.reason = q.reason || { enabled: false };
          const label = textField('Reason label', q.reason.label, 'Reason', (v) => { q.reason.label = v; persist(); });
          const limit = limitField('Reason word limit', q.reason.wordLimit, (v) => { q.reason.wordLimit = v; persist(); });
          const req = checkbox('Reason required', q.reason.required === true, (v) => { q.reason.required = v; persist(); });
          const shown = [req, label, limit];
          for (const el of shown) el.hidden = !q.reason.enabled;
          opts.push(checkbox('Reason box', q.reason.enabled, (v) => {
            // A newly switched-on reason box starts as required.
            if (v && q.reason.required === undefined) { q.reason.required = true; req.querySelector('input').checked = true; }
            q.reason.enabled = v;
            for (const el of shown) el.hidden = !v;
            persist();
          }), ...shown);
        }
      }

      const handle = h('span', { class: 'handle', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⠿');
      const el = h('div', { class: 'qcard' + (q.type === 'message' ? ' is-message' : ''), 'data-index': String(i) },
        h('div', { class: 'qhead' },
          handle,
          h('span', { class: 'badge' }, TYPES[q.type] || q.type),
          h('span', { class: 'qnum' }, name)),
        h('label', { for: pid, class: 'sr-only' }, q.type === 'message' ? `${name} title` : `${name} prompt`),
        main,
        q.type === 'message' ? extra : null,
        h('div', { class: 'opts' }, opts),
        q.type === 'message' ? null : extra,
        h('div', { class: 'card-errors', role: 'status' }),
        h('div', { class: 'qactions' },
          h('button', { type: 'button', class: 'btn-small', disabled: i === 0, 'aria-label': `Move ${name} up`, onclick: () => move(i, i - 1, 'up') }, '↑ Up'),
          h('button', { type: 'button', class: 'btn-small', disabled: i === n - 1, 'aria-label': `Move ${name} down`, onclick: () => move(i, i + 1, 'down') }, '↓ Down'),
          h('button', { type: 'button', class: 'btn-small', onclick: () => duplicate(i) }, 'Duplicate'),
          h('button', { type: 'button', class: 'btn-small btn-danger', onclick: () => remove(i) }, 'Delete'))
      );

      // Drag-and-drop (desktop). Only the handle starts a drag so text fields stay selectable.
      handle.addEventListener('mousedown', () => { el.draggable = true; });
      el.addEventListener('dragstart', (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { el.draggable = false; el.classList.remove('dragging'); clearDrop(); });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        const after = e.offsetY > el.offsetHeight / 2 || e.clientY > el.getBoundingClientRect().top + el.offsetHeight / 2;
        clearDrop();
        el.classList.add(after ? 'drop-after' : 'drop-before');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = +e.dataTransfer.getData('text/plain');
        const after = el.classList.contains('drop-after');
        clearDrop();
        let to = i + (after ? 1 : 0);
        if (from < to) to--;
        if (from !== to && !isNaN(from)) move(from, to);
      });
      return el;
    }

    function clearDrop() {
      for (const c of listEl.querySelectorAll('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
    }

    function addQuestion(type) {
      draft.questions.push(blank(type));
      persist();
      renderList();
      const last = listEl.lastElementChild;
      last.scrollIntoView({ behavior: 'smooth', block: 'center' });
      last.querySelector('input[type="text"]').focus({ preventScroll: true });
    }

    function move(from, to, dir) {
      if (to < 0 || to >= draft.questions.length) return;
      const [q] = draft.questions.splice(from, 1);
      draft.questions.splice(to, 0, q);
      persist();
      // Keep keyboard focus on the same button so repeated presses keep moving the card.
      const idx = dir === 'up' ? 0 : 1;
      renderList();
      const btns = listEl.children[to].querySelectorAll('.qactions button');
      const target = btns[idx].disabled ? btns[1 - idx] : btns[idx];
      if (dir) target.focus();
    }

    function duplicate(i) {
      const copy = clone(draft.questions[i]);
      copy.id = newId();
      draft.questions.splice(i + 1, 0, copy);
      persist();
      renderList();
      listEl.children[i + 1].querySelector('input[type="text"]').focus();
    }

    async function remove(i) {
      const q = draft.questions[i];
      const text = q.type === 'message' ? q.title : q.prompt;
      if (!await confirmBox(`Delete ${itemLabels(draft.questions)[i].toLowerCase()}${text ? `: "${text}"` : ''}?`, 'Delete')) return;
      draft.questions.splice(i, 1);
      persist();
      renderList();
    }

    function tryIt() {
      const { survey, errors: errs } = validateSurvey(draft);
      if (errs.length) { validateDraft(); return; }
      Runner.start(survey, { preview: true, onExit: () => render() });
    }

    /** Commits the draft straight to the repo (needs a connected token). */
    async function publish() {
      if (!validateDraft()) return;
      const survey = validateSurvey(draft).survey;
      const text = serialise(survey);
      message('Publishing…', false);
      try {
        const remote = await GitHub.fetchFile();
        let remoteText = null;
        try { remoteText = serialise(validateSurvey(JSON.parse(remote.text)).survey); } catch (e) { /* unreadable file counts as changed */ }
        if (remoteText === text) { message('GitHub already has exactly this survey. Nothing to publish.', false); return; }
        // Changed on GitHub since this editor loaded it (another device, or a manual upload)?
        if (remoteText !== (live ? serialise(live) : null)
          && !await confirmBox('survey.json on GitHub has changed since this editor loaded it, perhaps from another device. Publish anyway and replace it?', 'Replace it')) {
          message('Not published. Revert loads the version on GitHub if you want to start from that.', false);
          return;
        }
        const url = await GitHub.commit(text, remote.sha);
        live = survey;
        persist();
        const parts = [h('strong', {}, 'Published. '), 'The live survey updates within a minute or two. '];
        if (url) parts.push(h('a', { href: url, target: '_blank', rel: 'noopener' }, 'See the change on GitHub'));
        message(parts, false);
      } catch (e) {
        message(e.message, true);
      }
    }

    /** The "Publish straight to GitHub" settings panel. */
    function githubPanel() {
      const saved = GitHub.settings();
      const s = { branch: 'main', path: 'survey.json', ...GitHub.guess(), ...saved };
      const field = (id, label, value, attrs) => {
        const inp = h('input', { id, type: 'text', value: value || '', autocomplete: 'off', spellcheck: 'false', ...attrs });
        return [inp, h('div', { class: 'gh-field' }, h('label', { for: id }, label), inp)];
      };
      const [owner, ownerEl] = field('gh-owner', 'Account', s.owner, { placeholder: 'your-username' });
      const [repo, repoEl] = field('gh-repo', 'Repository', s.repo, { placeholder: 'survey' });
      const [branch, branchEl] = field('gh-branch', 'Branch', s.branch);
      const [path, pathEl] = field('gh-path', 'File', s.path);
      const [token, tokenEl] = field('gh-token', 'Token', '', {
        type: 'password', placeholder: saved.token ? 'Saved. Paste a new one to replace it' : 'github_pat_…',
      });
      const status = h('p', { class: 'small muted', role: 'status' });

      const connect = async () => {
        const next = {
          owner: owner.value.trim(), repo: repo.value.trim(),
          branch: branch.value.trim() || 'main', path: path.value.trim() || 'survey.json',
          token: token.value.trim() || saved.token || '',
        };
        if (!next.owner || !next.repo || !next.token) { status.textContent = 'Fill in the account, repository and token.'; return; }
        GitHub.saveSettings(next);
        status.textContent = 'Checking the connection…';
        try {
          await GitHub.fetchFile();
          render();
          message(`Connected to ${next.owner}/${next.repo}. Publish now saves straight to GitHub.`, false);
        } catch (e) {
          if (saved.token) GitHub.saveSettings(saved); else store(KEY_GITHUB, undefined);
          status.textContent = e.message;
        }
      };
      const disconnect = async () => {
        if (!await confirmBox('Forget the GitHub token on this device?', 'Forget it')) return;
        store(KEY_GITHUB, undefined);
        render();
        message('Disconnected. The token is no longer stored on this device. You can also delete it on GitHub.', false);
      };

      const isOn = GitHub.connected();
      return h('details', { class: 'panel gh' },
        h('summary', {}, isOn ? `GitHub: connected to ${saved.owner}/${saved.repo}` : 'Publish straight to GitHub'),
        h('div', { class: 'gh-body' },
          isOn ? null : h('ol', { class: 'gh-steps small' },
            h('li', {}, 'Signed in to the GitHub account that owns the survey, open ',
              h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'Settings → Developer settings → Fine-grained tokens → Generate new token'), '.'),
            h('li', {}, 'Repository access: ', h('strong', {}, 'Only select repositories'), ', then pick the survey repository.'),
            h('li', {}, 'Permissions: add ', h('strong', {}, 'Contents'), ' and set it to ', h('strong', {}, 'Read and write'), '.'),
            h('li', {}, 'Choose an expiry, generate the token, and paste it below.')),
          h('div', { class: 'gh-grid' }, ownerEl, repoEl, branchEl, pathEl),
          tokenEl,
          h('p', { class: 'small muted' }, 'The token is stored only in this browser, on this device. It is never put in the survey or the repository.'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn-small', onclick: connect }, isOn ? 'Save and check' : 'Connect'),
            isOn ? h('button', { type: 'button', class: 'btn-small btn-danger', onclick: disconnect }, 'Disconnect') : null),
          status));
    }

    function saveFile() {
      if (!validateDraft()) return;
      const json = serialise(validateSurvey(draft).survey);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: 'survey.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      message([h('strong', {}, 'survey.json downloaded. '), 'Upload this file to your repo, replacing the old survey.json. Changes go live in about a minute.'], false);
    }

    async function copyJson() {
      if (!validateDraft()) return;
      try {
        await navigator.clipboard.writeText(serialise(validateSurvey(draft).survey));
        message('JSON copied. Paste it over the contents of survey.json on GitHub and commit. Changes go live in about a minute.', false);
      } catch (e) {
        message('This browser blocked clipboard access. Use Save instead.', true);
      }
    }

    function importFile(input) {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      file.text().then(async (text) => {
        let raw;
        try { raw = JSON.parse(text); } catch (e) { message(`${file.name} isn't valid JSON: ${e.message}`, true); return; }
        const { survey, errors: errs } = validateSurvey(raw);
        if (!survey) { message(`${file.name} isn't a survey file: ${errs[0].message}`, true); return; }
        if (draft.questions.length && !await confirmBox(`Replace the current draft with ${file.name}?`, 'Replace')) return;
        draft = survey;
        showErrors = errs.length > 0;
        persist();
        render();
        if (errs.length) validateDraft();
        else message(`Imported ${file.name}. Press Save when you're ready to publish it.`, false);
      });
    }

    async function revert() {
      if (!await confirmBox('Discard your draft and reload the live survey.json?', 'Discard draft')) return;
      store(KEY_DRAFT, undefined);
      try {
        live = await loadLive();
        liveError = null;
      } catch (e) {
        liveError = e.message;
      }
      draft = live ? clone(live) : { version: 1, title: 'SurveyForPerfection', questions: [] };
      showErrors = false;
      render();
      message('Draft discarded.', false);
    }

    return { open };
  })();

  // ---------- Boot ----------

  (async function boot() {
    try {
      live = await loadLive();
      document.title = live.title;
    } catch (e) {
      liveError = e.message;
    }
    route();
  })();
})();
