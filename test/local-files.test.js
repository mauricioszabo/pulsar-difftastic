'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');

// Stub git commands so this test doesn't inspect or modify a real checkout.
test('exposes only files present at the exact PR head on the matching local branch', async () => {
  const commandPath = require.resolve('../lib/command');
  const filesPath = require.resolve('../lib/local-files');
  const oldCommand = require.cache[commandPath];
  const oldFiles = require.cache[filesPath];
  const calls = [];
  const head = 'a'.repeat(40);
  const filesAtHead = new Set(['src/current.js']);
  require.cache[commandPath] = {id: commandPath, filename: commandPath, loaded: true, exports: {
    run: async (_binary, args) => {
      calls.push(args);
      if (args.includes('symbolic-ref')) return 'feature/abc\n';
      if (args.includes('rev-parse')) return `${head}\n`;
      const file = args.at(-1);
      return filesAtHead.has(file) ? `${file}\0` : '';
    }
  }};
  delete require.cache[filesPath];
  try {
    const {localFilesForReview} = require('../lib/local-files');
    const analysis = {
      head, metadata: {head: {ref: 'feature/abc', sha: head}},
      files: [{filename: 'src/current.js'}, {filename: 'src/deleted.js'}]
    };
    const result = await localFilesForReview(analysis, ['/repo']);
    assert.deepEqual([...result], [['src/current.js', '/repo/src/current.js']]);
    assert.ok(calls.some(args => args.includes('--')));

    assert.equal((await localFilesForReview({...analysis,
      metadata: {head: {ref: 'other', sha: head}}}, ['/repo'])).size, 0);
    assert.equal((await localFilesForReview({...analysis,
      metadata: {head: {ref: 'feature/abc', sha: 'b'.repeat(40)}}}, ['/repo'])).size, 0);
  } finally {
    if (oldCommand) require.cache[commandPath] = oldCommand;
    else delete require.cache[commandPath];
    if (oldFiles) require.cache[filesPath] = oldFiles;
    else delete require.cache[filesPath];
  }
});
