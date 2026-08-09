# christineguttmann.at — Redesign

Static site (plain HTML/CSS/JS, no build step) plus a small local CMS so the
site owner can edit texts and images and publish to GitHub Pages herself.

- `index.html`, `vita.html`, … — the site. These are the deliverable; there is
  no generator and nothing is compiled. Hand-edit them freely.
- `assets/` — stylesheet, `main.js`, images.
- `cms/` — the local editor (see below). Not used by the published site.
- `CMS-ANLEITUNG.md` — the end-user guide, in German.

---

## The CMS

`Website bearbeiten.cmd` starts a zero-dependency Node server on localhost. It
serves an admin shell that loads the **real page** in an iframe with an editor
injected, then writes changes back into the same `.html` files.

### How editing stays safe

Editable areas are marked in the HTML with `data-cms` attributes:

```html
<h3 data-cms="aktuell-titel" data-cms-kind="text" data-cms-label="Überschrift">aktuell</h3>
```

| Attribute | Meaning |
|---|---|
| `data-cms="id"` | makes the element's content editable; `id` is unique per page |
| `data-cms-kind` | `text` (one line), `rich` (prose), `list` (add/reorder/delete children), `figure` (image only) |
| `data-cms-label` | German label shown in the UI |
| `data-cms-global` | region exists on every page and is written to all of them (footer) |

The server never re-serialises a whole file. `cms/lib/html.js` parses the page
while keeping byte offsets for every node, and `cms/lib/patch.js` splices only
the ranges that changed — so a text edit is a one-line diff and all hand-written
formatting survives. Before writing, the result is re-parsed and rejected if a
region disappeared, a tag became unbalanced, or `</body>`/`</html>` went missing.
Writes are atomic (temp file + rename) and the previous version is copied into
`.cms-backups/` (gitignored, last 40 kept).

Content coming from the browser is rejected if it contains `<script>`, `<style>`,
`<iframe>`, `<form>`, `on*` handlers or `javascript:` URLs.

### Adding a new editable area

Add `data-cms` + `data-cms-kind` + `data-cms-label` to the container. Nothing
else — the editor picks it up on next load. For a list, the direct children
become the items; the first one doubles as the template for "add".

### Tests

`cms/ui/selftest.html` drives the editor inside a real page and prints what it
produces. Start the server, then run it headlessly:

```sh
chrome --headless --disable-gpu --virtual-time-budget=15000 \
  --user-data-dir=/tmp/cms-profile --dump-dom \
  "http://localhost:4321/__cms/selftest.html?page=index.html"
```

Pages worth running: `index.html` (text, images, reorder, add/delete, slider,
filters), `ausstellungen.html` (nested galleries), and
`?page=index.html&mode=roundtrip`, which saves twice through the real API and
verifies the file on disk. The round-trip mode **writes to `index.html`** —
restore it afterwards.

Two invariants to keep in mind if you touch the parser:

- round-trip: every node's `[tagStart, nodeEnd)` slice must rebuild the file
  byte-for-byte, for all six pages
- no-op save: `applyOps(src, {})` must return an identical string

---

## One-time setup for publishing

The CMS's **Veröffentlichen** button runs `git add -A && git commit && git push`.
That needs a remote and stored credentials — do this once, on the machine that
will be used for editing:

1. **Create the repository** on GitHub (`christineguttmann.at`, public — GitHub
   Pages needs public unless you have a paid plan).

2. **Connect it:**
   ```sh
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```

3. **Turn on Pages:** repository → Settings → Pages → Source: *Deploy from a
   branch* → Branch `main`, folder `/ (root)`. The site appears at
   `https://<user>.github.io/<repo>/` after a minute or two.

4. **Store the credentials** so she is never asked for a password: the first
   `git push` from her machine opens Git Credential Manager's browser login.
   Complete it once and Windows remembers it. Verify by pushing a second time
   with no prompt — otherwise the CMS's publish button will appear to hang
   while a hidden dialog waits for input.

5. **Custom domain** (optional): Settings → Pages → Custom domain, plus a
   `CNAME` file in the repo root. Note that the CMS commits every file, so the
   `CNAME` file stays put on its own.

### A note on `cms/` being published

GitHub Pages serves the whole repo, so `cms/ui/admin.html` is reachable on the
live site. It is harmless — it only talks to `http://localhost:4321`, which
does not exist for visitors — but it is public. Delete the folder from the
published branch if that bothers you; keep it in the working copy.
