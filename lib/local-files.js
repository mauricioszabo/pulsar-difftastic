'use strict';

const path = require('path');
const {run} = require('./command');

async function localFilesForReview(analysis, projectPaths) {
  const head = analysis.metadata?.head;
  if (!head?.ref || !head.sha || analysis.head !== head.sha) return new Map();
  for (const root of projectPaths || []) {
    let branch;
    let sha;
    try {
      [branch, sha] = await Promise.all([
        run('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD']),
        run('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'])
      ]).then(([branch_, sha_]) => [branch_.trim(), sha_.trim()]);
    } catch {
      continue;
    }
    if (branch !== head.ref || sha.toLowerCase() !== head.sha.toLowerCase()) continue;
    const matched = new Map();
    for (const file of analysis.files) {
      try {
        const record = await run('git', ['-C', root, 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', file.filename]);
        if (record.split('\0').includes(file.filename)) matched.set(file.filename, path.join(root, file.filename));
      } catch {
        // A deleted, untracked, or otherwise unavailable HEAD path is not a valid editor target.
      }
    }
    return matched;
  }
  return new Map();
}

module.exports = {localFilesForReview};
