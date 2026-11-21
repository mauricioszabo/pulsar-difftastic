'use strict';

const {run, sendJSON, decodeText, maxBlobBytes} = require('./command');
const {patchRows, patchRowsForComment} = require('./diff');
const shaPattern = /^[0-9a-f]{40}$/i;

function glabEnv() {
  return {...process.env, GLAB_NO_PROMPT: '1', GLAB_PAGER: 'cat', GLAB_DEBUG: ''};
}

function mergeRequest(input) {
  const text = input.trim();
  const url = /^https:\/\/([\w.-]+(?::\d+)?)\/((?:[\w.-]+\/)+[\w.-]+)\/-\/merge_requests\/(\d+)(?:\/[\w-]+)?\/?(?:[?#].*)?$/i.exec(text);
  const short = /^((?:[\w.-]+\/)+[\w.-]+)!(\d+)$/.exec(text);
  if (!url && !short) throw new Error('Enter a GitLab merge request URL or group/project!123.');
  const host = url ? url[1].toLowerCase() : 'gitlab.com';
  const project = url ? url[2] : short[1];
  const number = Number(url ? url[3] : short[2]);
  if (project.split('/').some(part => part === '.' || part === '..') || !Number.isSafeInteger(number) || number < 1) {
    throw new Error('Enter a valid GitLab merge request.');
  }
  return {key: `${project}!${number}`, url: `https://${host}/${project}/-/merge_requests/${number}`,
    host, repository: `projects/${encodeURIComponent(project)}`, number};
}

function api(glab, host, signal) {
  return async endpoint => JSON.parse(await run(glab, ['api', '--hostname', host, '--method', 'GET', endpoint],
    {signal, env: glabEnv()}));
}

function diffRefs(request) {
  const refs = request.diff_refs || {};
  if (![refs.base_sha, refs.start_sha, refs.head_sha].every(sha => shaPattern.test(sha || ''))) {
    throw new Error('GitLab returned invalid commit IDs.');
  }
  return refs;
}

function sameRefs(left, right) {
  return left.base_sha === right.base_sha && left.start_sha === right.start_sha && left.head_sha === right.head_sha;
}

function changedFile(diff) {
  const status = diff.new_file ? 'added' : diff.deleted_file ? 'removed' : diff.renamed_file ? 'renamed' : 'modified';
  const file = {filename: diff.new_path, status, submodule: diff.a_mode === '160000' || diff.b_mode === '160000'};
  if (diff.renamed_file) file.previous_filename = diff.old_path;
  if (diff.diff) {
    const rows = patchRows(diff.diff).flatMap(group => group.rows);
    file.patch = diff.diff;
    file.additions = rows.filter(row => row[1]?.changed).length;
    file.deletions = rows.filter(row => row[0]?.changed).length;
  }
  return file;
}

function submoduleCommit(file, sign) {
  const line = (file.patch || '').split('\n').find(text => text.startsWith(`${sign}Subproject commit `));
  return line?.slice(19);
}

async function loadMergeRequest(ref, glab, signal) {
  const get = api(glab, ref.host, signal);
  const endpoint = `${ref.repository}/merge_requests/${ref.number}`;
  const request = await get(endpoint);
  const refs = diffRefs(request);
  const diffs = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await get(`${endpoint}/diffs?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GitLab returned an invalid changed-file list.');
    diffs.push(...batch);
    if (batch.length < 100) break;
  }
  const latest = await get(endpoint);
  if (!sameRefs(diffRefs(latest), refs)) {
    throw new Error('The merge request changed while loading. Reload it to review the latest revision.');
  }

  const files = diffs.map(changedFile);
  const metadata = {
    title: request.title,
    state: request.state === 'opened' ? 'open' : 'closed',
    merged: request.state === 'merged',
    draft: request.draft,
    user: {login: request.author?.username},
    base: {ref: request.target_branch, sha: refs.start_sha},
    head: {ref: request.source_branch, sha: refs.head_sha},
    additions: files.reduce((total, file) => total + (file.additions || 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions || 0), 0),
    changed_files: Math.max(files.length, parseInt(request.changes_count, 10) || 0)
  };

  async function readPath(commit, file, pathname, sign) {
    if (file.submodule) return {reason: 'Submodule', oid: submoduleCommit(file, sign)};
    const blob = await get(`${ref.repository}/repository/files/${encodeURIComponent(pathname)}?ref=${commit}`);
    if (blob.size > maxBlobBytes) return {reason: 'File exceeds the 1 MiB structural diff limit'};
    if (blob.encoding !== 'base64') return {reason: 'Unsupported blob encoding'};
    return decodeText(Buffer.from(blob.content, 'base64'));
  }

  return {
    metadata, files, refs, mergeBase: refs.base_sha, head: refs.head_sha,
    readHead(file) {
      return file.status === 'removed' ? {bytes: Buffer.alloc(0), text: ''} : readPath(refs.head_sha, file, file.filename, '+');
    },
    readBase(file) {
      return readPath(refs.base_sha, file, file.previous_filename || file.filename, '-');
    }
  };
}

function diffComment(ref, note) {
  const position = note?.position;
  if (note?.type !== 'DiffNote' || note.system || !position || !Number.isSafeInteger(note.id) || note.id < 1 ||
      typeof note.body !== 'string') return null;
  const right = Number.isSafeInteger(position.new_line);
  return {
    id: note.id, body: note.body, user: {login: note.author?.username}, html_url: `${ref.url}#note_${note.id}`,
    path: position.new_path, side: right ? 'RIGHT' : 'LEFT', line: right ? position.new_line : position.old_line,
    head: position.head_sha
  };
}

async function loadMergeRequestComments(ref, analysis, glab, signal) {
  const get = api(glab, ref.host, signal);
  const files = new Map(analysis.files.map(file => [file.filename, file]));
  const comments = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await get(`${ref.repository}/merge_requests/${ref.number}/discussions?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GitLab returned an invalid discussion list.');
    for (const note of batch.flatMap(discussion => discussion?.notes || [])) {
      const comment = diffComment(ref, note);
      const file = comment && files.get(comment.path);
      if (file && comment.head === analysis.head && patchRowsForComment(file, comment)) comments.push(comment);
    }
    if (batch.length < 100) return comments;
  }
  throw new Error('This merge request has too many discussions to load.');
}

function linePosition(file, anchor) {
  const index = anchor.side === 'LEFT' ? 0 : 1;
  const row = patchRows(file.patch).flatMap(group => group.rows).find(item => item[index]?.number === anchor.line);
  if (row[0] && row[1] && !row[index].changed) return {old_line: row[0].number, new_line: row[1].number};
  return index === 0 ? {old_line: anchor.line} : {new_line: anchor.line};
}

async function postMergeRequestComment(ref, analysis, anchor, body, glab, signal) {
  if (!body.trim() || anchor.head !== analysis.head || !shaPattern.test(anchor.head)) {
    throw new Error('The comment is empty or belongs to an earlier merge request revision. Reload the merge request.');
  }
  const file = analysis.files.find(item => item.filename === anchor.path);
  if (!file || !patchRowsForComment(file, anchor)) {
    throw new Error('This line is not in the GitLab patch. Select a line from the Git Patch view.');
  }
  const latest = await api(glab, ref.host, signal)(`${ref.repository}/merge_requests/${ref.number}`);
  if (!sameRefs(diffRefs(latest), analysis.refs)) {
    throw new Error('The merge request changed since it was loaded. Reload it before commenting.');
  }
  const position = {
    position_type: 'text', base_sha: analysis.refs.base_sha, start_sha: analysis.refs.start_sha,
    head_sha: analysis.refs.head_sha, old_path: file.previous_filename || file.filename, new_path: file.filename,
    ...linePosition(file, anchor)
  };
  let discussion;
  try {
    discussion = await sendJSON(glab, [
      'api', '--hostname', ref.host, '--method', 'POST', '--input', '-',
      `${ref.repository}/merge_requests/${ref.number}/discussions`
    ], {body: body.trim(), position}, {signal, env: glabEnv(), service: 'GitLab'});
  } catch (error) {
    throw new Error(`${error.message} Check GitLab before retrying.`);
  }
  const note = discussion?.notes?.[0];
  if (!Number.isSafeInteger(note?.id) || note.id < 1) {
    throw new Error('GitLab did not confirm the comment. Check the merge request before retrying.');
  }
  return {
    id: note.id, body: body.trim(), user: {login: note.author?.username}, html_url: `${ref.url}#note_${note.id}`,
    path: file.filename, side: anchor.side, line: anchor.line
  };
}

async function deleteMergeRequestComment(ref, id, glab, signal) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid review comment ID.');
  await run(glab, [
    'api', '--hostname', ref.host, '--method', 'DELETE', `${ref.repository}/merge_requests/${ref.number}/notes/${id}`
  ], {signal, env: glabEnv()});
}

async function mergeRequestsForBranch(root, branch, glab) {
  const output = await run(glab, [
    'mr', 'list', '--source-branch', branch, '--all', '--per-page', '100', '--output', 'json'
  ], {cwd: root, env: glabEnv()});
  let requests;
  try {
    requests = JSON.parse(output).map(request => ({
      number: request.iid, title: request.title, url: request.web_url, state: request.state, isDraft: request.draft
    }));
    if (requests.some(request => typeof request.title !== 'string' || typeof request.url !== 'string' ||
        !Number.isInteger(request.number) || mergeRequest(request.url).number !== request.number)) {
      throw new Error('Invalid merge request list');
    }
  } catch {
    throw new Error('GitLab CLI returned an invalid merge request list.');
  }
  return requests;
}

module.exports = {
  mergeRequest, loadMergeRequest, loadMergeRequestComments, postMergeRequestComment, deleteMergeRequestComment,
  mergeRequestsForBranch
};
