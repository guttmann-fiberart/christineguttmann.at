'use strict';

/* Admin shell: page tabs, save/publish, image picker.
 * The actual editing happens inside the preview iframe (editor.js), which
 * registers itself here via window.CMSAdmin. Both run on the same origin. */

const $ = (id) => document.getElementById(id);

const el = {
  pages: $('pages'), state: $('state'), hint: $('hint'),
  save: $('btn-save'), publish: $('btn-publish'), discard: $('btn-discard'),
  preview: $('preview'), toast: $('toast'),
  picker: $('picker'), thumbs: $('picker-thumbs'), search: $('picker-search'),
  pickerFile: $('picker-file'), pickerClose: $('picker-close'),
  dialog: $('dialog'), dialogTitle: $('dialog-title'),
  dialogBody: $('dialog-body'), dialogActions: $('dialog-actions'),
};

let state = { pages: [], git: null };
let currentPage = 'index.html';
let editor = null;          // set by the iframe
let dirty = false;
let images = [];
let pickerResolve = null;

/* ---------- plumbing ---------- */

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({ error: 'Unlesbare Antwort vom Server' }));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(message, isError) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', !!isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, isError ? 7000 : 3000);
}

/* ---------- header state ---------- */

function renderPages() {
  el.pages.replaceChildren(...state.pages.map((p) => {
    const b = document.createElement('button');
    b.textContent = p.title;
    b.setAttribute('aria-current', String(p.file === currentPage));
    b.addEventListener('click', () => goToPage(p.file));
    return b;
  }));
}

function renderState() {
  const git = state.git;
  if (dirty) {
    el.state.className = 'state dirty';
    el.state.textContent = 'Nicht gespeicherte Änderungen';
  } else if (git && git.pending) {
    const n = git.changedCount + git.unpushedCommits;
    el.state.className = 'state dirty';
    el.state.textContent = `${n} Änderung${n === 1 ? '' : 'en'} noch nicht veröffentlicht`;
  } else {
    el.state.className = 'state clean';
    el.state.textContent = 'Alles veröffentlicht';
  }
  el.save.disabled = !dirty;
  el.discard.disabled = !(dirty || (git && git.pending));
}

async function refreshState() {
  state = await api('/api/state');
  renderPages();
  renderState();
}

function goToPage(file) {
  if (dirty && !confirm('Es gibt nicht gespeicherte Änderungen. Seite trotzdem wechseln?')) return;
  currentPage = file;
  dirty = false;
  editor = null;
  el.preview.src = `/preview/${file}`;
  renderPages();
  renderState();
}

/* ---------- image picker ---------- */

async function loadImages() {
  images = (await api('/api/images')).images;
}

function renderThumbs(filter) {
  const q = (filter || '').toLowerCase();
  const list = images.filter((i) => !q || i.name.toLowerCase().includes(q));
  el.thumbs.replaceChildren(...list.map((img) => {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.title = `${img.name} · ${Math.round(img.bytes / 1024)} KB`;

    const im = document.createElement('img');
    im.src = '/' + img.path;
    im.loading = 'lazy';
    im.alt = '';

    const cap = document.createElement('span');
    cap.textContent = img.name;

    b.append(im, cap);
    b.addEventListener('click', () => closePicker(img.path));
    return b;
  }));
  if (!list.length) {
    const p = document.createElement('p');
    p.textContent = 'Keine passenden Bilder gefunden.';
    p.style.color = 'var(--muted)';
    el.thumbs.replaceChildren(p);
  }
}

/** Opened by the editor; resolves to a path like "assets/img/foo.jpg" or null. */
async function openPicker() {
  el.picker.hidden = false;
  el.search.value = '';
  el.thumbs.textContent = 'Lade…';
  await loadImages();
  renderThumbs('');
  el.search.focus();
  return new Promise((resolve) => { pickerResolve = resolve; });
}

function closePicker(value) {
  el.picker.hidden = true;
  const done = pickerResolve;
  pickerResolve = null;
  if (done) done(value || null);
}

/** Downscale in the browser so the repository does not fill up with 6 MB photos. */
function shrink(file, maxSide = 2000, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 900 * 1024) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
        reader.readAsDataURL(file);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      resolve(canvas.toDataURL(type, quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}

async function uploadFile(file) {
  try {
    toast('Bild wird verkleinert und gespeichert…');
    const dataUrl = await shrink(file);
    const saved = await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, dataUrl }),
    });
    await loadImages();
    toast(`„${saved.name}" hinzugefügt`);
    closePicker(saved.path);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- save & publish ---------- */

async function save() {
  if (!editor) return;
  const ops = editor.collectOps();
  if (!Object.keys(ops).length) {
    dirty = false;
    renderState();
    toast('Keine Änderungen zu speichern');
    return;
  }
  el.save.disabled = true;
  try {
    const result = await api('/api/save', {
      method: 'POST',
      body: JSON.stringify({ page: currentPage, regions: ops }),
    });
    state.git = result.git;
    dirty = false;
    editor.markSaved();
    renderState();
    const extra = result.alsoTouched && result.alsoTouched.length
      ? ` (auch auf ${result.alsoTouched.length} weiteren Seiten)` : '';
    toast(`Gespeichert${extra}`);
  } catch (err) {
    toast(`Nicht gespeichert: ${err.message}`, true);
    renderState();
  }
}

function dialog(title, bodyNodes, actions) {
  el.dialogTitle.textContent = title;
  el.dialogBody.replaceChildren(...bodyNodes);
  el.dialogActions.replaceChildren(...actions);
  el.dialog.hidden = false;
}
const closeDialog = () => { el.dialog.hidden = true; };

function p(text) { const n = document.createElement('p'); n.textContent = text; return n; }
function pre(text) { const n = document.createElement('pre'); n.textContent = text; return n; }
function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

async function publish() {
  if (dirty) {
    await save();
    if (dirty) return;                       // save failed — stop here
  }

  const git = (state.git = await api('/api/git'));

  if (!git.hasRemote) {
    dialog('Noch nicht eingerichtet', [
      p('Diese Website ist noch mit keinem GitHub-Repository verbunden, deshalb kann sie nicht veröffentlicht werden.'),
      p('Das muss einmalig eingerichtet werden — siehe CMS-ANLEITUNG.md im Projektordner.'),
    ], [button('OK', 'primary', closeDialog)]);
    return;
  }

  if (!git.pending) {
    dialog('Nichts zu veröffentlichen', [p('Es gibt keine Änderungen seit der letzten Veröffentlichung.')],
      [button('OK', 'primary', closeDialog)]);
    return;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.value = 'Website aktualisiert';

  const list = document.createElement('ul');
  list.replaceChildren(...git.changedFiles.slice(0, 12).map((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    return li;
  }));
  if (git.changedFiles.length > 12) {
    const li = document.createElement('li');
    li.textContent = `… und ${git.changedFiles.length - 12} weitere`;
    list.appendChild(li);
  }

  dialog('Veröffentlichen', [
    p('Diese Änderungen gehen online:'),
    list,
    p('Kurze Beschreibung (optional):'),
    input,
  ], [
    button('Abbrechen', 'ghost', closeDialog),
    button('Jetzt veröffentlichen', 'publish', () => runPublish(input.value)),
  ]);
  input.focus();
  input.select();
}

async function runPublish(message) {
  const spinner = document.createElement('p');
  spinner.innerHTML = '<span class="spinner"></span>Wird veröffentlicht…';
  dialog('Veröffentlichen', [spinner, p('Das kann bei vielen Bildern eine Weile dauern.')], []);

  try {
    const result = await api('/api/publish', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    state.git = await api('/api/git');
    renderState();

    const body = [p('Die Änderungen sind auf GitHub. Die Website wird in ein bis zwei Minuten aktualisiert.')];
    if (state.git.remoteUrl) {
      const link = pagesUrl(state.git.remoteUrl);
      if (link) {
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = link;
        const wrap = document.createElement('p');
        wrap.append('Adresse: ', a);
        body.push(wrap);
      }
    }
    dialog('Veröffentlicht', body, [button('Fertig', 'primary', closeDialog)]);
  } catch (err) {
    dialog('Veröffentlichen fehlgeschlagen', [
      p('Die Änderungen sind lokal gespeichert, aber nicht online gegangen.'),
      pre(err.message),
      p('Bitte Sebastian Bescheid geben — die Arbeit ist nicht verloren.'),
    ], [button('Schließen', 'primary', closeDialog)]);
  }
}

function pagesUrl(remote) {
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (!m) return null;
  const [, owner, repo] = m;
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? `https://${repo}`
    : `https://${owner}.github.io/${repo}/`;
}

async function discard() {
  dialog('Änderungen verwerfen?', [
    p('Alle Änderungen seit der letzten Veröffentlichung werden zurückgesetzt. Das lässt sich nicht rückgängig machen.'),
  ], [
    button('Abbrechen', 'ghost', closeDialog),
    button('Ja, verwerfen', 'publish', async () => {
      closeDialog();
      try {
        const result = await api('/api/discard', { method: 'POST' });
        state.git = result.git;
        dirty = false;
        el.preview.src = `/preview/${currentPage}`;
        renderState();
        toast('Änderungen verworfen');
      } catch (err) {
        toast(err.message, true);
      }
    }),
  ]);
}

/* ---------- API used by the editor inside the iframe ---------- */

window.CMSAdmin = {
  register(api) {
    editor = api;
    dirty = false;
    renderState();
  },
  /** The iframe navigated on its own (a link in the site's menu). */
  pageChanged(file) {
    if (file === currentPage) return;
    currentPage = file;
    dirty = false;
    renderPages();
    renderState();
  },
  setDirty() {
    if (dirty) return;
    dirty = true;
    renderState();
  },
  pickImage: openPicker,
  toast,
  hint(text) {
    el.hint.textContent = text || 'Klicke im Vorschaufenster auf einen Text oder ein Bild.';
  },
};

/* ---------- wiring ---------- */

el.save.addEventListener('click', save);
el.publish.addEventListener('click', publish);
el.discard.addEventListener('click', discard);
el.pickerClose.addEventListener('click', () => closePicker(null));
el.picker.addEventListener('click', (e) => { if (e.target === el.picker) closePicker(null); });
el.search.addEventListener('input', () => renderThumbs(el.search.value));
el.pickerFile.addEventListener('change', () => {
  const file = el.pickerFile.files[0];
  el.pickerFile.value = '';
  if (file) uploadFile(file);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  if (e.key === 'Escape') {
    if (!el.picker.hidden) closePicker(null);
    else if (!el.dialog.hidden) closeDialog();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

refreshState().catch((err) => toast(err.message, true));
