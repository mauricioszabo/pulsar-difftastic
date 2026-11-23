'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const childProcess = require('node:child_process');
const {promisify} = require('node:util');

// All process calls are intercepted. This test never starts glab (or any other executable).
test('loads, comments on, and lists GitLab merge requests through glab', async () => {
  const originalExec = childProcess.execFile;
  const originalSpawn = childProcess.spawn;
  const modules = ['../lib/command', '../lib/diff', '../lib/gitlab'].map(name => require.resolve(name));
  const previous = modules.map(key => require.cache[key]);
  const refs = {base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: 'a'.repeat(40)};
  let latestRefs = refs;
  const calls = [];
  const posts = [];
  const project = 'projects/group%2Fsub%2Fproject';
  const request = {
    iid: 7, title: 'Add feature', state: 'opened', draft: false, author: {username: 'me'},
    source_branch: 'feature', target_branch: 'main', changes_count: '3'
  };
  const diffs = [
    {old_path: 'src/file.js', new_path: 'src/file.js', a_mode: '100644', b_mode: '100644',
      new_file: false, renamed_file: false, deleted_file: false,
      diff: '@@ -1,3 +1,3 @@\n context\n-old\n+new\n tail\n'},
    {old_path: 'old name.js', new_path: 'new name.js', a_mode: '100644', b_mode: '100644',
      new_file: false, renamed_file: true, deleted_file: false, diff: ''},
    {old_path: 'vendor/lib', new_path: 'vendor/lib', a_mode: '160000', b_mode: '160000',
      new_file: false, renamed_file: false, deleted_file: false,
      diff: `@@ -1 +1 @@\n-Subproject commit ${'1'.repeat(40)}\n+Subproject commit ${'2'.repeat(40)}\n`}
  ];
  const note = (id, position, extra = {}) => ({
    id, type: 'DiffNote', system: false, body: `Note ${id}`, author: {username: 'me'},
    position: {head_sha: refs.head_sha, new_path: 'src/file.js', old_path: 'src/file.js', ...position}, ...extra
  });
  const discussions = [
    {id: 'd1', notes: [note(41, {new_line: 2, old_line: null})]},
    {id: 'd2', notes: [note(42, {new_line: null, old_line: 2}, {resolved: true})]},
    {id: 'd3', notes: [note(43, {new_line: 2, old_line: null, head_sha: 'd'.repeat(40)})]},
    {id: 'd4', notes: [note(44, {new_line: 40, old_line: null})]},
    {id: 'd5', notes: [{id: 45, type: null, system: false, body: 'General comment'}]}
  ];
  const versions = [
    {id: 90, head_commit_sha: refs.head_sha},
    {id: 91, head_commit_sha: 'd'.repeat(40)}
  ];
  childProcess.execFile = () => assert.fail('execFile must be promisified');
  childProcess.execFile[promisify.custom] = async (binary, args, options) => {
    assert.equal(binary, 'glab');
    assert.equal(options.env.GLAB_NO_PROMPT, '1');
    calls.push(args);
    if (args[0] === 'mr') {
      return {stdout: JSON.stringify([{iid: 7, title: 'Add feature', web_url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/7', state: 'opened', draft: true}]), stderr: ''};
    }
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'gitlab.example.com']);
    const endpoint = args.at(-1);
    if (args[4] === 'DELETE') return {stdout: '', stderr: ''};
    assert.equal(args[4], 'GET');
    if (endpoint === `${project}/merge_requests/7`) return {stdout: JSON.stringify({...request, diff_refs: latestRefs}), stderr: ''};
    if (endpoint === `${project}/merge_requests/7/diffs?per_page=100&page=1`) return {stdout: JSON.stringify(diffs), stderr: ''};
    if (endpoint === `${project}/merge_requests/7/discussions?per_page=100&page=1`) return {stdout: JSON.stringify(discussions), stderr: ''};
    if (endpoint === `${project}/merge_requests/7/versions`) return {stdout: JSON.stringify(versions), stderr: ''};
    if (endpoint === `${project}/merge_requests/7/versions/90`) {
      return {stdout: JSON.stringify({state: 'collected', diffs: [{new_path: 'src/file.js', diff: diffs[0].diff}]}), stderr: ''};
    }
    if (endpoint === `${project}/merge_requests/7/versions/91`) {
      return {stdout: JSON.stringify({state: 'without_files', diffs: []}), stderr: ''};
    }
    if (endpoint.startsWith(`${project}/repository/files/`)) {
      return {stdout: JSON.stringify({size: 4, encoding: 'base64', content: Buffer.from(endpoint).toString('base64')}), stderr: ''};
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  childProcess.spawn = (binary, args) => {
    assert.equal(binary, 'glab');
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.stdin = new PassThrough();
    let input = '';
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      posts.push({args, data: JSON.parse(input)});
      queueMicrotask(() => {
        process.stdout.write(JSON.stringify({id: 'abc', notes: [{id: 50 + posts.length, author: {username: 'me'}}]}));
        process.emit('close', 0);
      });
    });
    return process;
  };
  try {
    modules.forEach(key => delete require.cache[key]);
    const gitlab = require('../lib/gitlab');

    const ref = gitlab.mergeRequest('https://gitlab.example.com/group/sub/project/-/merge_requests/7/diffs');
    assert.deepEqual(ref, {key: 'group/sub/project!7', url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/7',
      host: 'gitlab.example.com', repository: project, number: 7});
    assert.equal(gitlab.mergeRequest('group/project!3').url, 'https://gitlab.com/group/project/-/merge_requests/3');
    assert.throws(() => gitlab.mergeRequest('https://github.com/a/b/pull/1'), /GitLab merge request/);

    const analysis = await gitlab.loadMergeRequest(ref, 'glab');
    assert.equal(analysis.head, refs.head_sha);
    assert.equal(analysis.mergeBase, refs.base_sha);
    assert.deepEqual(analysis.files.map(file => [file.filename, file.status, file.previous_filename]),
      [['src/file.js', 'modified', undefined], ['new name.js', 'renamed', 'old name.js'], ['vendor/lib', 'modified', undefined]]);
    assert.deepEqual([analysis.files[0].additions, analysis.files[0].deletions], [1, 1]);
    assert.equal(analysis.files[1].patch, undefined);
    assert.deepEqual(analysis.metadata, {
      title: 'Add feature', state: 'open', merged: false, draft: false, user: {login: 'me'},
      base: {ref: 'main', sha: refs.start_sha}, head: {ref: 'feature', sha: refs.head_sha},
      additions: 2, deletions: 2, changed_files: 3
    });
    const head = await analysis.readHead(analysis.files[1]);
    assert.equal(head.text, `${project}/repository/files/new%20name.js?ref=${refs.head_sha}`);
    const base = await analysis.readBase(analysis.files[1]);
    assert.equal(base.text, `${project}/repository/files/old%20name.js?ref=${refs.base_sha}`);
    assert.deepEqual(await analysis.readHead(analysis.files[2]), {reason: 'Submodule', oid: '2'.repeat(40)});
    assert.deepEqual(await analysis.readBase(analysis.files[2]), {reason: 'Submodule', oid: '1'.repeat(40)});

    // Notes on an earlier revision or outside the patch are kept, tagged for the Resolved issues panel.
    const comments = await gitlab.loadMergeRequestComments(ref, analysis, 'glab');
    assert.deepEqual(comments.map(comment => [comment.id, comment.side, comment.line, comment.outdated,
      comment.resolved, comment.thread]), [
      [41, 'RIGHT', 2, false, false, 'd1'],
      [42, 'LEFT', 2, false, true, 'd2'],
      [43, 'RIGHT', 2, true, false, 'd3'],
      [44, 'RIGHT', 40, true, false, 'd4']
    ]);
    assert.equal(comments[0].html_url, `${ref.url}#note_41`);

    const block = await gitlab.mergeRequestCommentBlock(ref, analysis, comments[0], 'glab');
    assert.deepEqual(block.groups.flatMap(group => group.rows).map(row => [row[0]?.text, row[1]?.text]),
      [['context', 'context'], ['old', undefined], [undefined, 'new']]);
    const expired = await gitlab.mergeRequestCommentBlock(ref, analysis, comments[2], 'glab');
    assert.match(expired.note, /no longer stores the diff/);

    const body = 'A private note\nwith a newline';
    const added = await gitlab.postMergeRequestComment(ref, analysis, {path: 'src/file.js', side: 'RIGHT', line: 2, head: refs.head_sha}, body, 'glab');
    assert.deepEqual([added.id, added.body, added.user, added.html_url, added.path, added.side, added.line,
      added.outdated, added.resolved, added.thread],
      [51, body, {login: 'me'}, `${ref.url}#note_51`, 'src/file.js', 'RIGHT', 2, false, false, 'abc']);
    assert.deepEqual(posts[0].args, ['api', '--hostname', 'gitlab.example.com', '--method', 'POST', '--input', '-', `${project}/merge_requests/7/discussions`]);
    assert.deepEqual(posts[0].data, {body, position: {
      position_type: 'text', ...refs, old_path: 'src/file.js', new_path: 'src/file.js', new_line: 2
    }});
    await gitlab.postMergeRequestComment(ref, analysis, {path: 'src/file.js', side: 'RIGHT', line: 3, head: refs.head_sha}, 'Context', 'glab');
    assert.deepEqual([posts[1].data.position.old_line, posts[1].data.position.new_line], [3, 3]);
    await gitlab.postMergeRequestComment(ref, analysis, {path: 'src/file.js', side: 'LEFT', line: 2, head: refs.head_sha}, 'Removed', 'glab');
    assert.deepEqual([posts[2].data.position.old_line, posts[2].data.position.new_line], [2, undefined]);
    await assert.rejects(gitlab.postMergeRequestComment(ref, analysis, {path: 'src/file.js', side: 'RIGHT', line: 40, head: refs.head_sha}, body, 'glab'),
      /not in the GitLab patch/);
    latestRefs = {...refs, head_sha: 'e'.repeat(40)};
    await assert.rejects(gitlab.postMergeRequestComment(ref, analysis, {path: 'src/file.js', side: 'RIGHT', line: 2, head: refs.head_sha}, body, 'glab'),
      /changed since it was loaded/);
    assert.equal(posts.length, 3);

    await gitlab.deleteMergeRequestComment(ref, 41, 'glab');
    assert.deepEqual(calls.at(-1), ['api', '--hostname', 'gitlab.example.com', '--method', 'DELETE', `${project}/merge_requests/7/notes/41`]);
    await assert.rejects(gitlab.deleteMergeRequestComment(ref, '41', 'glab'), /Invalid review comment ID/);

    const requests = await gitlab.mergeRequestsForBranch('/repo', 'feature/x', 'glab');
    assert.deepEqual(calls.at(-1), ['mr', 'list', '--source-branch', 'feature/x', '--all', '--per-page', '100', '--output', 'json']);
    assert.deepEqual(requests, [{number: 7, title: 'Add feature', url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/7', state: 'opened', isDraft: true}]);
  } finally {
    childProcess.execFile = originalExec;
    childProcess.spawn = originalSpawn;
    modules.forEach((key, index) => {
      if (previous[index]) require.cache[key] = previous[index];
      else delete require.cache[key];
    });
  }
});
