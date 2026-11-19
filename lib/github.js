'use strict';

const {execFile, spawn} = require('child_process');
const {promisify, TextDecoder} = require('util');
const runFile = promisify(execFile);
const maxBlobBytes = 1024 * 1024;
const shaPattern = /^[0-9a-f]{40}$/i;

function pullRequest(input) {
  const text = input.trim();
  const match = /^(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/(?:files|commits|changes))?\/?(?:[?#].*)?|([\w.-]+)\/([\w.-]+)#(\d+))$/i.exec(text);
  if (!match) throw new Error('Enter a github.com pull request URL or owner/repo#123.');
  const owner = (match[1] || match[4]).toLowerCase();
  const repo = (match[2] || match[5]).toLowerCase();
  const number = Number(match[3] || match[6]);
  if (!/^[a-z\d][a-z\d-]*$/i.test(owner) || repo === '.' || repo === '..' ||
      !Number.isSafeInteger(number) || number < 1) {
    throw new Error('Enter a valid GitHub pull request.');
  }
  return {key: `${owner}/${repo}#${number}`, url: `https://github.com/${owner}/${repo}/pull/${number}`,
    repository: `repos/${owner}/${repo}`, number};
}

async function run(binary, args, options = {}) {
  try {
    const {stdout} = await runFile(binary, args, {
      maxBuffer: 24 * 1024 * 1024, timeout: 60000, windowsHide: true, ...options
    });
    return stdout;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.code === 'ENOENT') {
      throw new Error(`Could not find ${binary}. Check the executable path in package settings.`);
    }
    if (error.killed) throw new Error(`${binary} timed out.`);
    const detail = String(error.stderr || '').trim().slice(0, 800);
    throw new Error(detail || `${binary} failed (${error.code || 'unknown error'}).`);
  }
}

function api(gh, signal) {
  return async endpoint => JSON.parse(await run(gh, [
    'api', '--hostname', 'github.com', '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json', endpoint
  ], {signal, env: {...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: ''}}));
}

// Send JSON over stdin so comment bodies never appear in process arguments or on disk.
function postJSON(gh, endpoint, data, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(gh, [
      'api', '--hostname', 'github.com', '--method', 'POST',
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'Content-Type: application/json', '--input', '-', endpoint
    ], {signal, timeout: 60000, windowsHide: true,
      env: {...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: ''}});
    let output = '';
    let errorOutput = '';
    let failed = false;
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) { failed = true; child.kill(); }
    });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-4096); });
    child.stdin.on('error', () => {}); // A failed request may close stdin early; 'close' reports the error.
    child.on('error', error => {
      if (error.code === 'ENOENT') reject(new Error(`Could not find ${gh}. Check the executable path in package settings.`));
      else reject(error);
    });
    child.on('close', code => {
      if (signal?.aborted) return reject(new Error('Request cancelled. Check GitHub before retrying.'));
      if (failed) return reject(new Error('GitHub returned an oversized response. Check GitHub before retrying.'));
      if (code !== 0) return reject(new Error(errorOutput.trim().slice(0, 800) ||
        `GitHub CLI failed (${code}). Check GitHub before retrying.`));
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error('Invalid GitHub response. Check GitHub before retrying.')); }
    });
    child.stdin.end(JSON.stringify(data));
  });
}

async function postReviewComment(ref, analysis, anchor, body, gh, signal) {
  if (!body.trim() || anchor.head !== analysis.head || !shaPattern.test(anchor.head)) {
    throw new Error('The comment is empty or belongs to an earlier PR revision. Reload the PR.');
  }
  const file = analysis.files.find(item => item.filename === anchor.path);
  if (!file || !['LEFT', 'RIGHT'].includes(anchor.side) || !Number.isSafeInteger(anchor.line) || anchor.line < 1 ||
      !patchRowsForComment(file, anchor)) {
    throw new Error('This line is not in the GitHub patch. Select a line from the GitHub patch view.');
  }
  const get = api(gh, signal);
  const latest = await get(`${ref.repository}/pulls/${ref.number}`);
  if (latest.head?.sha !== analysis.head || latest.base?.sha !== analysis.metadata.base.sha) {
    throw new Error('The PR changed since it was loaded. Reload it before commenting.');
  }
  let comment;
  try {
    comment = await postJSON(gh, `${ref.repository}/pulls/${ref.number}/comments`, {
      body: body.trim(), commit_id: analysis.head, path: file.filename,
      line: anchor.line, side: anchor.side
    }, signal);
  } catch (error) {
    throw new Error(`${error.message} Check GitHub before retrying.`);
  }
  if (!Number.isSafeInteger(comment?.id) || comment.id < 1) {
    throw new Error('GitHub did not confirm the comment. Check the PR before retrying.');
  }
  return {...comment, body: body.trim(), path: file.filename, line: anchor.line, side: anchor.side};
}

async function loadReviewComments(ref, analysis, gh, signal) {
  const get = api(gh, signal);
  const files = new Map(analysis.files.map(file => [file.filename, file]));
  const comments = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await get(`${ref.repository}/pulls/${ref.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid review comment list.');
    for (const comment of batch) {
      const file = comment && files.get(comment.path);
      if (file && Number.isSafeInteger(comment.id) && comment.id > 0 &&
          typeof comment.body === 'string' && comment.position !== null &&
          patchRowsForComment(file, comment)) comments.push(comment);
    }
    if (batch.length < 100) return comments;
  }
  throw new Error('This PR has too many review comments to load.');
}

async function deleteReviewComment(ref, id, gh, signal) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid review comment ID.');
  await run(gh, [
    'api', '--hostname', 'github.com', '--method', 'DELETE',
    '-H', 'Accept: application/vnd.github+json', `${ref.repository}/pulls/comments/${id}`
  ], {signal, env: {...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: ''}});
}

function patchRowsForComment(file, anchor) {
  // GitHub only accepts a line present in the PR diff, not every Difftastic context line.
  const {patchRows} = require('./diff');
  if (!['LEFT', 'RIGHT'].includes(anchor.side) || !Number.isSafeInteger(anchor.line) || anchor.line < 1) return false;
  const index = anchor.side === 'LEFT' ? 0 : 1;
  return patchRows(file.patch).some(group => group.rows.some(row => row[index]?.number === anchor.line));
}

function memoizeRequest(fetch) {
  const requests = new Map();
  return key => {
    if (!requests.has(key)) {
      requests.set(key, fetch(key).catch(error => {
        requests.delete(key);
        throw error;
      }));
    }
    return requests.get(key);
  };
}

function repositoryPath(fullName) {
  if (!/^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(fullName || '')) return null;
  const repo = fullName.split('/')[1];
  return repo === '.' || repo === '..' ? null : `repos/${fullName.toLowerCase()}`;
}

async function loadPullRequest(ref, gh, signal) {
  const get = api(gh, signal);
  const endpoint = `${ref.repository}/pulls/${ref.number}`;
  const metadata = await get(endpoint);
  const base = metadata.base.sha;
  const head = metadata.head.sha;
  if (!shaPattern.test(base) || !shaPattern.test(head)) throw new Error('GitHub returned invalid commit IDs.');
  const count = Math.min(metadata.changed_files, 3000);
  if (!Number.isInteger(count) || count < 0) throw new Error('GitHub returned an invalid file count.');

  const [comparison, files] = await Promise.all([
    get(`${ref.repository}/compare/${base}...${head}?per_page=1`).catch(error => ({error})),
    (async () => {
      const files = [];
      for (let page = 1; page <= Math.ceil(count / 100); page++) {
        const batch = await get(`${endpoint}/files?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid changed-file list.');
        files.push(...batch);
      }
      return files;
    })()
  ]);
  const comparisonSha = comparison.merge_base_commit?.sha;
  const mergeBase = shaPattern.test(comparisonSha) ? comparisonSha : null;

  const latest = await get(endpoint);
  if (latest.base.sha !== base || latest.head.sha !== head || latest.changed_files !== metadata.changed_files ||
      files.length !== count || new Set(files.map(file => file.filename)).size !== count) {
    throw new Error('The pull request changed while loading. Reload it to review the latest revision.');
  }

  const object = memoizeRequest(get);
  const fork = repositoryPath(metadata.head.repo?.full_name);

  async function headObject(commit) {
    try {
      return {repository: ref.repository, commit: await object(`${ref.repository}/git/commits/${commit}`)};
    } catch (error) {
      if (!fork || fork === ref.repository || !/HTTP (404|422)\b/.test(error.message)) throw error;
      return {repository: fork, commit: await object(`${fork}/git/commits/${commit}`)};
    }
  }

  async function readPath(commit, pathname, fromHead) {
    const revision = fromHead
      ? await headObject(commit)
      : {repository: ref.repository, commit: await object(`${ref.repository}/git/commits/${commit}`)};
    let treeSha = revision.commit.tree.sha;
    const parts = pathname.split('/');
    let entry;
    for (let index = 0; index < parts.length; index++) {
      const result = await object(`${revision.repository}/git/trees/${treeSha}`);
      entry = result.tree.find(item => item.path === parts[index]);
      if (!entry) throw new Error('This path was not found in the recorded commit.');
      if (index < parts.length - 1 && entry.type !== 'tree') throw new Error('GitHub returned an invalid file path.');
      treeSha = entry.sha;
    }
    if (entry.type === 'commit') return {reason: 'Submodule', oid: entry.sha};
    if (entry.type !== 'blob') return {reason: 'Unsupported Git object'};
    if (entry.size > maxBlobBytes) return {reason: 'File exceeds the 1 MiB structural diff limit'};
    const blob = await get(`${revision.repository}/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64') return {reason: 'Unsupported blob encoding'};
    const bytes = Buffer.from(blob.content, 'base64');
    if (bytes.length > maxBlobBytes) return {reason: 'File exceeds the 1 MiB structural diff limit'};
    if (bytes.includes(0)) return {reason: 'Binary file'};
    try {
      return {bytes, text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)};
    } catch {
      return {reason: 'File is not UTF-8 text'};
    }
  }

  return {
    metadata, files, mergeBase, head,
    readHead(file) {
      return file.status === 'removed' ? {bytes: Buffer.alloc(0), text: ''} : readPath(head, file.filename, true);
    },
    readBase(file) {
      if (!mergeBase) throw new Error(comparison.error?.message || 'GitHub did not return a comparison merge base.');
      return readPath(mergeBase, file.previous_filename || file.filename, false);
    }
  };
}

module.exports = {pullRequest, loadPullRequest, loadReviewComments, postReviewComment, deleteReviewComment, run};
