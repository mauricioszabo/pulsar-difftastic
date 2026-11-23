'use strict';

const {run, sendJSON, decodeText, maxBlobBytes} = require('./command');
const {patchRows, patchRowsForComment, hunkTail, hunkRange} = require('./diff');
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

function ghEnv() {
  return {...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: ''};
}

function api(gh, signal) {
  return async endpoint => JSON.parse(await run(gh, [
    'api', '--hostname', 'github.com', '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json', endpoint
  ], {signal, env: ghEnv()}));
}

const threadQuery = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{isResolved isOutdated comments(first:100){nodes{databaseId}}}}}}}`;

async function reviewThreads(ref, gh, signal) {
  const [owner, name] = ref.repository.split('/').slice(1);
  const threads = new Map();
  let cursor = null;
  for (let page = 1; page <= 100; page++) {
    const args = ['api', 'graphql', '-f', `query=${threadQuery}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${ref.number}`];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const {data} = JSON.parse(await run(gh, args, {signal, env: ghEnv()}));
    const page_ = data?.repository?.pullRequest?.reviewThreads;
    if (!page_) throw new Error('GitHub returned an invalid review thread list.');
    for (const node of page_.nodes) {
      const ids = node.comments.nodes.map(comment => comment.databaseId).filter(Number.isSafeInteger);
      for (const id of ids) threads.set(id, {thread: ids[0], resolved: node.isResolved, outdated: node.isOutdated});
    }
    if (!page_.pageInfo.hasNextPage) return threads;
    cursor = page_.pageInfo.endCursor;
  }
  throw new Error('This PR has too many review threads to load.');
}

function reviewComment(comment, file, thread) {
  const current = comment.position !== null && patchRowsForComment(file, comment);
  return {
    id: comment.id, body: comment.body, user: comment.user, html_url: comment.html_url,
    path: comment.path, side: comment.side, line: comment.line, head: comment.original_commit_id,
    thread: thread?.thread ?? comment.in_reply_to_id ?? comment.id,
    outdated: !current, resolved: Boolean(thread?.resolved),
    hunk: comment.diff_hunk, originalLine: comment.original_line, originalCommit: comment.original_commit_id
  };
}

function postJSON(gh, endpoint, data, signal) {
  return sendJSON(gh, [
    'api', '--hostname', 'github.com', '--method', 'POST',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'Content-Type: application/json', '--input', '-', endpoint
  ], data, {signal, env: ghEnv(), service: 'GitHub'});
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
  return reviewComment({...comment, body: body.trim(), path: file.filename, line: anchor.line,
    side: anchor.side, original_commit_id: analysis.head, original_line: anchor.line}, file, null);
}

async function loadReviewComments(ref, analysis, gh, signal) {
  const get = api(gh, signal);
  const files = new Map(analysis.files.map(file => [file.filename, file]));
  const threads = await reviewThreads(ref, gh, signal).catch(() => new Map());
  const comments = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await get(`${ref.repository}/pulls/${ref.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid review comment list.');
    for (const comment of batch) {
      const file = comment && files.get(comment.path);
      if (file && Number.isSafeInteger(comment.id) && comment.id > 0 && typeof comment.body === 'string') {
        comments.push(reviewComment(comment, file, threads.get(comment.id)));
      }
    }
    if (batch.length < 100) return comments;
  }
  throw new Error('This PR has too many review comments to load.');
}

const blockSize = 4;

async function reviewCommentBlock(ref, analysis, comment) {
  const groups = hunkTail(comment.hunk, comment.side === 'LEFT' ? 0 : 1, comment.originalLine, blockSize);
  if (!groups.length) return {note: 'GitHub did not supply the original diff for this comment.'};
  const range = [hunkRange(groups, 0), hunkRange(groups, 1)];
  return {groups, range, anchor: range[0] || hunkRange(patchRows(comment.hunk), 0),
    base: analysis.mergeBase || analysis.metadata.base.sha};
}

async function deleteReviewComment(ref, id, gh, signal) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid review comment ID.');
  await run(gh, [
    'api', '--hostname', 'github.com', '--method', 'DELETE',
    '-H', 'Accept: application/vnd.github+json', `${ref.repository}/pulls/comments/${id}`
  ], {signal, env: ghEnv()});
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
    return decodeText(Buffer.from(blob.content, 'base64'));
  }

  return {
    metadata, files, mergeBase, head,
    readHead(file) {
      return file.status === 'removed' ? {bytes: Buffer.alloc(0), text: ''} : readPath(head, file.filename, true);
    },
    readBase(file) {
      if (!mergeBase) throw new Error(comparison.error?.message || 'GitHub did not return a comparison merge base.');
      return readPath(mergeBase, file.previous_filename || file.filename, false);
    },
    readAt(commit, pathname) {
      return readPath(commit, pathname, true);
    }
  };
}

async function pullRequestsForBranch(root, branch, gh) {
  const output = await run(gh, [
    'pr', 'list', '--head', branch, '--state', 'all', '--limit', '100',
    '--json', 'number,title,url,state,isDraft'
  ], {cwd: root, env: ghEnv()});
  let prs;
  try {
    prs = JSON.parse(output);
    if (!Array.isArray(prs) || prs.some(pr => typeof pr.title !== 'string' ||
        typeof pr.url !== 'string' || !Number.isInteger(pr.number) ||
        pullRequest(pr.url).number !== pr.number)) throw new Error('Invalid PR list');
  } catch {
    throw new Error('GitHub CLI returned an invalid pull request list.');
  }
  return prs;
}

module.exports = {
  pullRequest, loadPullRequest, loadReviewComments, postReviewComment, deleteReviewComment, pullRequestsForBranch,
  reviewCommentBlock
};
