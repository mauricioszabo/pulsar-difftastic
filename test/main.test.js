'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('Open creates independent tabs; branch command selects a PR without replacing them', async () => {
  const opened = [];
  let commands;
  const editor = {getPath: () => '/project/file.js'};
  const atom = {
    workspace: {
      addOpener: callback => { atom.opener = callback; return {dispose() {}}; },
      open: async uri => {
        const view = atom.opener(uri);
        opened.push(view);
        return view;
      },
      getActiveTextEditor: () => editor,
      getPaneItems: () => []
    },
    commands: {add: (target, handlers) => { commands = handlers; return {dispose() {}}; }},
    config: {get: () => 'gh'},
    notifications: {addError: message => { throw new Error(message); }, addInfo() {}}
  };
  global.atom = atom;
  const review = require.resolve('../lib/review-view');
  const branch = require.resolve('../lib/branch-prs');
  const picker = require.resolve('../lib/pr-picker');
  const main = require.resolve('../lib/main');
  const originals = [review, branch, picker, main].map(key => require.cache[key]);
  const originalLoad = Module._load;
  let nextId = 0;
  let matches = [];
  class FakeReview {
    static uri = 'atom://difftastic-pr-review/review';
    static newURI() { return `${this.uri}/${++nextId}`; }
    constructor(state) { this.uri = state.uri; }
    focusAddress() { this.focused = true; }
    open(url) { this.url = url; }
  }
  class FakePicker {
    constructor(prs, branch, onSelect) { this.prs = prs; this.onSelect = onSelect; this.branch = branch; }
    destroy() { this.onClose?.(); }
  }
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'atom') return {CompositeDisposable: class { constructor(...items) { this.items = items; } dispose() { this.items.forEach(item => item.dispose()); } }};
      return originalLoad.call(this, request, parent, isMain);
    };
    require.cache[review] = {id: review, filename: review, loaded: true, exports: FakeReview};
    require.cache[branch] = {id: branch, filename: branch, loaded: true, exports: {pullRequestsForEditor: async () => ({branch: 'feature', prs: matches})}};
    require.cache[picker] = {id: picker, filename: picker, loaded: true, exports: FakePicker};
    delete require.cache[main];
    const pkg = require('../lib/main');
    pkg.activate();
    await commands['difftastic-pr-review:open']();
    await commands['difftastic-pr-review:open']();
    assert.notEqual(opened[0].uri, opened[1].uri);
    assert.equal(opened[0].focused, true);
    assert.equal(opened[1].focused, true);
    assert.equal(atom.opener('atom://another/package'), undefined);
    matches = [{url: 'https://github.com/a/b/pull/1'}];
    await commands['difftastic-pr-review:open-pr-on-current-branch']();
    assert.equal(opened[2].url, matches[0].url);
    matches = [{url: 'https://github.com/a/b/pull/1'}, {url: 'https://github.com/a/b/pull/2'}];
    await commands['difftastic-pr-review:open-pr-on-current-branch']();
    assert.equal(opened.length, 3);
    assert.equal(pkg.picker.prs.length, 2);
    pkg.picker.onSelect(matches[1]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opened[3].url, matches[1].url);
    pkg.deactivate();
  } finally {
    Module._load = originalLoad;
    delete global.atom;
    [review, branch, picker, main].forEach((key, index) => {
      if (originals[index]) require.cache[key] = originals[index];
      else delete require.cache[key];
    });
  }
});
