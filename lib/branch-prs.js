'use strict';

const path = require('path');
const {run} = require('./command');

async function pullRequestsForEditor(editor, listForBranch) {
  const file = editor?.getPath();
  if (!file) throw new Error('Open a file on a Git branch first.');
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
  return {branch, prs: await listForBranch(root, branch)};
}

module.exports = {pullRequestsForEditor};
