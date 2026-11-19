'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const childProcess = require('node:child_process');
const {promisify} = require('node:util');

// All process calls are intercepted. This test never starts gh (or any other executable).
test('posts an immediate review comment using stdin, and rejects invalid or stale anchors', async () => {
  const originalExec = childProcess.execFile;
  const originalSpawn = childProcess.spawn;
  const modulePath = require.resolve('../lib/github');
  const previous = require.cache[modulePath];
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  let latestHead = head;
  let posts = 0;
  let deletes = 0;
  let fields;
  let argv;
  childProcess.execFile = (binary, args, options, callback) => {
    assert.equal(binary, 'gh');
    assert.equal(args[4], 'GET');
    queueMicrotask(() => callback(null, JSON.stringify({head: {sha: latestHead}, base: {sha: base}}), ''));
    return {kill() {}};
  };
  childProcess.execFile[promisify.custom] = async (binary, args) => {
    assert.equal(binary, 'gh');
    const endpoint = args.at(-1);
    if (args[4] === 'DELETE') {
      assert.equal(endpoint, 'repos/a/b/pulls/comments/33');
      deletes++;
      return {stdout: '', stderr: ''};
    }
    assert.equal(args[4], 'GET');
    if (endpoint.endsWith('comments?per_page=100&page=1')) return {stdout: JSON.stringify([
      ...Array.from({length: 99}, (_, index) => ({id: index + 100, body: 'Other', path: 'another.js', side: 'RIGHT', line: 1})),
      {id: 33, body: 'Current', path: 'src/file.js', side: 'LEFT', line: 1, position: 1}
    ]), stderr: ''};
    if (endpoint.endsWith('comments?per_page=100&page=2')) return {stdout: JSON.stringify([
      {id: 34, body: 'Outdated', path: 'src/file.js', side: 'LEFT', line: 1, position: null},
      {id: 35, body: 'Other side', path: 'src/file.js', side: 'RIGHT', line: 1, position: 1},
      {id: 36, body: 'Outside patch', path: 'src/file.js', side: 'RIGHT', line: 40, position: 1}
    ]), stderr: ''};
    return {stdout: JSON.stringify({head: {sha: latestHead}, base: {sha: base}}), stderr: ''};
  };
  childProcess.spawn = (binary, args) => {
    assert.equal(binary, 'gh');
    posts++;
    argv = args;
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.stdin = new PassThrough();
    let input = '';
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      fields = JSON.parse(input);
      queueMicrotask(() => {
        process.stdout.write(JSON.stringify({id: 33, html_url: 'https://github.com/a/b/pull/1#discussion_r33'}));
        process.emit('close', 0);
      });
    });
    return process;
  };
  try {
    delete require.cache[modulePath];
    const {postReviewComment, loadReviewComments, deleteReviewComment} = require('../lib/github');
    const ref = {repository: 'repos/a/b', number: 1};
    const analysis = {head, metadata: {base: {sha: base}}, files: [
      {filename: 'src/file.js', patch: '@@ -1,2 +1,2 @@\n-old\n+new\n context\n'}
    ]};
    const anchor = {path: 'src/file.js', side: 'LEFT', line: 1, head};
    const body = 'A private note\nwith a newline';
    const comment = await postReviewComment(ref, analysis, anchor, body, 'gh');
    assert.equal(comment.id, 33);
    assert.deepEqual(fields, {body, commit_id: head, path: 'src/file.js', line: 1, side: 'LEFT'});
    assert.equal(argv.includes(body), false);
    assert.deepEqual(argv.slice(-3), ['--input', '-', 'repos/a/b/pulls/1/comments']);
    await postReviewComment(ref, analysis, {...anchor, side: 'RIGHT'}, ' Right side ', 'gh');
    assert.equal(fields.side, 'RIGHT');
    assert.equal(fields.body, 'Right side');
    await assert.rejects(postReviewComment(ref, analysis, {...anchor, line: 50}, body, 'gh'), /not in the GitHub patch/);
    assert.equal(posts, 2);
    latestHead = 'c'.repeat(40);
    await assert.rejects(postReviewComment(ref, analysis, anchor, body, 'gh'), /changed since it was loaded/);
    assert.equal(posts, 2);
    const loaded = await loadReviewComments(ref, analysis, 'gh');
    assert.deepEqual(loaded.map(item => item.id), [33, 35]);
    await deleteReviewComment(ref, 33, 'gh');
    assert.equal(deletes, 1);
    await assert.rejects(deleteReviewComment(ref, '33', 'gh'), /Invalid review comment ID/);
    assert.equal(deletes, 1);
  } finally {
    childProcess.execFile = originalExec;
    childProcess.spawn = originalSpawn;
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  }
});
