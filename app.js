/* SurveyForPerfection — static survey app. No frameworks, no build step. */
(function () {
  'use strict';

  const TYPES = { text: 'Text', yesno: 'Yes / No', duration: 'Duration' };
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
    if (raw.questions.length === 0) add(null, 'The survey has no questions.');

    const seen = new Set();
    const questions = raw.questions.map((q, i) => {
      const n = i + 1;
      if (!q || typeof q !== 'object') { add(i, `Question ${n} is not a valid entry.`); return null; }
      const out = { id: typeof q.id === 'string' && q.id ? q.id : newId(), type: q.type };
      if (seen.has(out.id)) add(i, `Question ${n} has the same id as an earlier question ("${out.id}").`);
      seen.add(out.id);
      if (!TYPES[q.type]) add(i, `Question ${n} has an unknown type "${q.type}" (use text, yesno or duration).`);
      out.prompt = typeof q.prompt === 'string' ? q.prompt : '';
      if (!out.prompt.trim()) add(i, `Question ${n} has no prompt.`);
      out.required = q.required !== false;
      if (q.type === 'text') {
        out.wordLimit = q.wordLimit ?? null;
        if (!isLimit(out.wordLimit)) add(i, `Question ${n}: word limit must be a whole number of 1 or more.`);
      } else if (q.type === 'yesno' || q.type === 'duration') {
        const r = q.reason && typeof q.reason === 'object' ? q.reason : {};
        out.reason = { enabled: !!r.enabled };
        if (out.reason.enabled) {
          out.reason.wordLimit = r.wordLimit ?? null;
          if (!isLimit(out.reason.wordLimit)) add(i, `Question ${n}: reason word limit must be a whole number of 1 or more.`);
        }
      }
      return out;
    });

    return {
      survey: { version: 1, title: (raw.title || '').trim() || 'SurveyForPerfection', questions: questions.filter(Boolean) },
      errors,
    };
  }

  /** Clean JSON for saving: drops empty limits, keeps field order readable. */
  function serialise(survey) {
    const out = {
      version: 1,
      title: survey.title,
      questions: survey.questions.map((q) => {
        const o = { id: q.id, type: q.type, prompt: q.prompt.trim(), required: q.required !== false };
        if (q.type === 'text' && q.wordLimit != null && q.wordLimit !== '') o.wordLimit = q.wordLimit;
        if (q.type !== 'text') {
          o.reason = { enabled: !!(q.reason && q.reason.enabled) };
          if (o.reason.enabled && q.reason.wordLimit != null && q.reason.wordLimit !== '') o.reason.wordLimit = q.reason.wordLimit;
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
      const n = survey.questions.length;
      const begin = () => { state = freshState(); save(); renderQuestion(); };
      const actions = resumable
        ? [
            h('p', {}, 'Continue where you left off?'),
            h('div', { class: 'row center' },
              h('button', { type: 'button', class: 'btn-primary', onclick: () => { state = resumable; renderQuestion(); } },
                `Continue at question ${resumable.index + 1}`),
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
      const total = survey.questions.length;
      const a = state.answers[q.id] || (state.answers[q.id] = {});
      const isLast = i === total - 1;

      const errEl = h('div', { class: 'field-error', role: 'status' });
      const nextBtn = h('button', { type: 'button', class: 'btn-primary', onclick: goNext }, isLast ? 'Finish' : 'Next');
      const backBtn = h('button', { type: 'button', onclick: goBack }, 'Back');

      function refresh() {
        const r = check(q, a);
        nextBtn.disabled = !r.ok;
        errEl.textContent = r.message || '';
        save();
      }
      function goNext() {
        if (!check(q, a).ok) return;
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

      const promptId = 'prompt-' + q.id;
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
          id: 'reason', label: 'Reason (optional)', value: a.reason, limit: q.reason.wordLimit,
          onInput: (v) => { a.reason = v; refresh(); }, onEnter: goNext,
        }));
      }

      app.replaceChildren(
        h('section', {},
          previewBanner(),
          h('p', { class: 'qcount', 'aria-label': `Question ${i + 1} of ${total}` }, `Question ${roman(i + 1)} of ${roman(total)}`),
          progress(i + 1, total),
          h('h2', { class: 'prompt', id: promptId, tabindex: '-1' }, q.prompt),
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
        items: survey.questions.map((q) => ({ q, a: toAnswer(q, state.answers[q.id] || {}) })),
      };
      if (!preview) store(KEY_PROGRESS, undefined);
      // The card is drawn with web fonts, so wait (briefly) for them before drawing.
      app.replaceChildren(h('p', { class: 'preparing', role: 'status' }, 'Preparing your card…'));
      ResultCard.ready().then(() => renderResults(results));
    }

    /** Segmented progress for short surveys, a plain bar for long ones. */
    function progress(n, total) {
      const attrs = { role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(total), 'aria-valuenow': String(n), 'aria-label': 'Progress' };
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
      const img = h('img', { class: 'result-img', alt: 'Results image: ' + ResultCard.asText(results).replace(/\n+/g, '. ') });
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
    const FONTS = ['600 38px Fraunces', '400 16px Newsreader', 'italic 400 16px Newsreader', '600 21px Newsreader'];

    /** Resolves once the card's fonts are loaded, or after 2.5 s so a slow network never blocks the card. */
    function ready() {
      if (!document.fonts || !document.fonts.load) return Promise.resolve();
      const loads = Promise.all(FONTS.map((f) => document.fonts.load(f))).catch(() => {});
      return Promise.race([loads, new Promise((r) => setTimeout(r, 2500))]);
    }

    function answerParts(item) {
      const { q, a } = item;
      if (q.type === 'text') return { pill: null, text: a.text };
      if (q.type === 'yesno') return { pill: a.value, text: a.reason };
      const d = a.seconds == null ? null : formatDuration(a.seconds);
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

    /** Lays out one question + answer at (0, 0). Returns { ops, h }. */
    function measureItem(ctx, item, width, sz, lh) {
      const ops = [];
      let y = 0;
      const qFont = `400 ${sz.q}px ${BODY}`;
      ctx.font = qFont;
      for (const line of wrap(ctx, item.q.prompt, width, width)) {
        ops.push({ kind: 'text', str: line, x: 0, y, font: qFont, color: C.q, size: sz.q });
        y += lh(sz.q);
      }
      y += 3;

      const { pill, text } = answerParts(item);
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
        if (!text) return { ops, h: y + rowH + ITEM_GAP };
      } else if (!text) {
        ops.push({ kind: 'text', str: '—', x: 0, y, font: aFont, color: C.faint, size: sz.a });
        return { ops, h: y + rowH + ITEM_GAP };
      }
      ctx.font = aFont;
      wrap(ctx, text, width, firstWidth).forEach((line, li) => {
        if (line) ops.push({ kind: 'text', str: line, x: li === 0 ? x0 : 0, y, font: aFont, color: C.answer, size: sz.a });
        y += rowH;
      });
      return { ops, h: y + ITEM_GAP };
    }

    function layout(ctx, results, k) {
      const f = (n) => Math.round(n * k);
      const sz = { date: f(38), sub: f(19), small: f(16), q: f(16), a: f(21), pill: f(16) };
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
        const { pill, text } = answerParts(item);
        const ans = pill ? PILL[pill].label + (text ? ' — ' + text : '') : text || '—';
        out.push(item.q.prompt, '> ' + ans.replace(/\n/g, '\n> '), '');
      }
      return out.join('\n').trim();
    }

    return { draw, asText, ready };
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
      const q = { id: newId(), type, prompt: '', required: true };
      if (type === 'text') q.wordLimit = null;
      else q.reason = { enabled: false, wordLimit: null };
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
        card.querySelector('.card-errors').textContent = mine.map((e) => e.message.replace(/^Question \d+:? ?/, '')).join(' ');
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
              h('span', { class: 'muted' }, 'Add question:'),
              Object.entries(TYPES).map(([t, label]) => h('button', { type: 'button', class: 'btn-small', onclick: () => addQuestion(t) }, '+ ' + label))),
            h('div', { class: 'row' },
              h('button', { type: 'button', onclick: tryIt }, 'Try it'),
              h('button', { type: 'button', class: 'btn-primary', onclick: saveFile }, 'Save'),
              h('button', { type: 'button', onclick: copyJson }, 'Copy JSON'),
              h('button', { type: 'button', onclick: () => fileInput.click() }, 'Import'),
              h('button', { type: 'button', class: 'btn-danger', onclick: revert }, 'Revert'),
              fileInput),
            dirtyEl),
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
      const pid = `p-${q.id}`;
      const prompt = h('input', { id: pid, type: 'text', value: q.prompt, placeholder: 'Question text' });
      prompt.addEventListener('input', () => { q.prompt = prompt.value; persist(); });

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

      const opts = [checkbox('Required', q.required !== false, (v) => { q.required = v; persist(); })];
      if (q.type === 'text') {
        opts.push(limitField('Word limit', q.wordLimit, (v) => { q.wordLimit = v; persist(); }));
      } else {
        q.reason = q.reason || { enabled: false };
        const limit = limitField('Reason word limit', q.reason.wordLimit, (v) => { q.reason.wordLimit = v; persist(); });
        limit.hidden = !q.reason.enabled;
        opts.push(checkbox('Reason box', q.reason.enabled, (v) => { q.reason.enabled = v; limit.hidden = !v; persist(); }), limit);
      }

      const handle = h('span', { class: 'handle', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⠿');
      const el = h('div', { class: 'qcard', 'data-index': String(i) },
        h('div', { class: 'qhead' },
          handle,
          h('span', { class: 'badge' }, TYPES[q.type] || q.type),
          h('span', { class: 'qnum' }, `Question ${i + 1}`)),
        h('label', { for: pid, class: 'sr-only' }, `Question ${i + 1} prompt`),
        prompt,
        h('div', { class: 'opts' }, opts),
        h('div', { class: 'card-errors', role: 'status' }),
        h('div', { class: 'qactions' },
          h('button', { type: 'button', class: 'btn-small', disabled: i === 0, 'aria-label': `Move question ${i + 1} up`, onclick: () => move(i, i - 1, 'up') }, '↑ Up'),
          h('button', { type: 'button', class: 'btn-small', disabled: i === n - 1, 'aria-label': `Move question ${i + 1} down`, onclick: () => move(i, i + 1, 'down') }, '↓ Down'),
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
      if (!await confirmBox(`Delete question ${i + 1}${q.prompt ? `: "${q.prompt}"` : ''}?`, 'Delete')) return;
      draft.questions.splice(i, 1);
      persist();
      renderList();
    }

    function tryIt() {
      const { survey, errors: errs } = validateSurvey(draft);
      if (errs.length) { validateDraft(); return; }
      Runner.start(survey, { preview: true, onExit: () => render() });
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
