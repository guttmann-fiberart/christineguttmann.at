'use strict';

const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, timeout: opts.timeout || 120000, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim(),
        });
      });
  });
}

/** What is waiting to be published, and can we publish at all? */
async function status() {
  const [porcelain, branch, remote, upstream] = await Promise.all([
    run(['status', '--porcelain']),
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['remote', 'get-url', 'origin']),
    run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  ]);

  const changed = porcelain.stdout ? porcelain.stdout.split(/\r?\n/).filter(Boolean) : [];
  const files = changed.map((line) => line.slice(3).replace(/^"|"$/g, ''));

  let ahead = 0;
  if (upstream.ok) {
    const counts = await run(['rev-list', '--count', '@{u}..HEAD']);
    ahead = counts.ok ? parseInt(counts.stdout, 10) || 0 : 0;
  }

  return {
    branch: branch.ok ? branch.stdout : null,
    hasRemote: remote.ok,
    remoteUrl: remote.ok ? remote.stdout : null,
    hasUpstream: upstream.ok,
    changedFiles: files,
    changedCount: files.length,
    unpushedCommits: ahead,
    pending: files.length > 0 || ahead > 0,
  };
}

/** Stage everything, commit if there is anything to commit, then push. */
async function publish(message) {
  const log = [];
  const step = (label, res) => {
    log.push({ label, ok: res.ok, output: [res.stdout, res.stderr].filter(Boolean).join('\n') });
    return res;
  };

  const before = await status();
  if (!before.hasRemote) {
    return {
      ok: false,
      stage: 'remote',
      error: 'Kein GitHub-Repository verknüpft. Bitte einmalig einrichten (siehe CMS-ANLEITUNG.md).',
      log,
    };
  }
  if (!before.pending) {
    return { ok: true, stage: 'nothing', nothingToDo: true, log };
  }

  if (before.changedCount > 0) {
    const add = step('git add', await run(['add', '-A']));
    if (!add.ok) return { ok: false, stage: 'add', error: add.stderr || 'git add fehlgeschlagen', log };

    const commit = step('git commit', await run(['commit', '-m', message || 'Website aktualisiert']));
    if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      return { ok: false, stage: 'commit', error: commit.stderr || commit.stdout || 'git commit fehlgeschlagen', log };
    }
  }

  const args = before.hasUpstream ? ['push'] : ['push', '-u', 'origin', before.branch];
  const push = step('git push', await run(args, { timeout: 300000 }));
  if (!push.ok) {
    return { ok: false, stage: 'push', error: push.stderr || push.stdout || 'git push fehlgeschlagen', log };
  }

  return { ok: true, stage: 'done', log, after: await status() };
}

/** Discard all uncommitted changes (the editor's "undo everything"). */
async function discardAll() {
  const reset = await run(['checkout', '--', '.']);
  const clean = await run(['clean', '-fd', '--', 'assets/img']);
  return { ok: reset.ok, detail: [reset.stderr, clean.stderr].filter(Boolean).join('\n') };
}

module.exports = { status, publish, discardAll, run, ROOT };
