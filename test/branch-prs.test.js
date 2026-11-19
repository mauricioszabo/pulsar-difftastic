'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pullRequestsForEditor} = require('../lib/branch-prs');

test('finds PRs for the active editor repository and branch, including closed PRs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpr-branch-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feature/review']);
  const nested = path.join(root, 'src');
  fs.mkdirSync(nested);
  const file = path.join(nested, 'file.js');
  fs.writeFileSync(file, '');
  const gh = path.join(root, 'fake-gh');
  const argsPath = path.join(root, 'args.json');
  fs.writeFileSync(gh, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}));\nconsole.log(JSON.stringify([{number: 12, title: 'Fix tests', url: 'https://github.com/a/b/pull/12', state: 'CLOSED', isDraft: false}]));\n`, {mode: 0o755});
  const result = await pullRequestsForEditor({getPath: () => file}, gh);
  assert.equal(result.branch, 'feature/review');
  assert.equal(result.prs[0].number, 12);
  const call = JSON.parse(fs.readFileSync(argsPath, 'utf8'));
  assert.equal(call.cwd, root);
  assert.deepEqual(call.args.slice(0, 7), ['pr', 'list', '--head', 'feature/review', '--state', 'all', '--limit']);
  assert.match(call.args.join(' '), /--json number,title,url,state,isDraft/);
});

test('reports missing editor paths and non-repository files', async t => {
  await assert.rejects(pullRequestsForEditor(null, 'gh'), /Open a file/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpr-no-git-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'file');
  fs.writeFileSync(file, '');
  await assert.rejects(pullRequestsForEditor({getPath: () => file}, 'gh'), /not in a Git repository/);
});
