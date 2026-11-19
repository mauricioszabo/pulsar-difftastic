'use strict';

const path = require('path');
const {run, pullRequest} = require('./github');

async function pullRequestsForEditor(editor, gh) {
  const file = editor?.getPath();
  if (!file) throw new Error('Open a file on a Git branch before using Open PR on Current Branch.');
  const cwd = path.dirname(file);
  let root;
  try {
    root = (await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error('The active editor is not in a Git repository.');
  }
  let branch;
  try {
    branch = (await run('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  } catch {
    throw new Error('The active editor’s Git repository has no current branch.');
  }
  const output = await run(gh, [
    'pr', 'list', '--head', branch, '--state', 'all', '--limit', '100',
    '--json', 'number,title,url,state,isDraft'
  ], {cwd: root, env: {...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: ''}});
  let prs;
  try {
    prs = JSON.parse(output);
    if (!Array.isArray(prs) || prs.some(pr => typeof pr.title !== 'string' ||
        typeof pr.url !== 'string' || !Number.isInteger(pr.number) ||
        pullRequest(pr.url).number !== pr.number)) throw new Error('Invalid PR list');
  } catch {
    throw new Error('GitHub CLI returned an invalid pull request list.');
  }
  return {branch, prs};
}

module.exports = {pullRequestsForEditor};
