'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// No gh executable is launched: the view's GitHub module is replaced in the module cache.
test('Reload fetches posted comments and deleting one removes it without a success notification', async () => {
  const viewPath = require.resolve('../lib/review-view');
  const githubPath = require.resolve('../lib/github');
  const draftsPath = require.resolve('../lib/drafts');
  const providersPath = require.resolve('../lib/providers');
  const originalCache = [viewPath, githubPath, draftsPath, providersPath].map(key => require.cache[key]);
  const originalLoad = Module._load;
  const originalAtom = global.atom;
  const originalDocument = global.document;
  const remote = [{id: 33, path: 'file.js', side: 'RIGHT', line: 1, body: 'Hi'}];
  let loads = 0;
  let deletes = 0;
  let failDelete = false;
  let notices = 0;
  global.document = {createElement: tag => ({
    tag, children: [], events: {}, append(...nodes) { this.children.push(...nodes); },
    addEventListener(name, handler) { this.events[name] = handler; }, setAttribute() {}
  })};
  const ref = {key: 'a/b#1', url: 'https://github.com/a/b/pull/1', repository: 'repos/a/b', number: 1};
  const analysis = {head: 'a'.repeat(40), metadata: {base: {sha: 'b'.repeat(40)}}, files: [{filename: 'file.js'}]};
  global.atom = {
    config: {get: () => 'gh'}, project: {getPaths: () => []}, getConfigDirPath: () => '/tmp', confirm: () => 1,
    notifications: {addSuccess: () => { notices++; }}
  };
  try {
    Module._load = function(name, parent, isMain) {
      if (name === 'atom') return {Emitter: class { emit() {} dispose() {} }};
      if (name === 'electron') return {shell: {openExternal() {}}};
      return originalLoad.call(this, name, parent, isMain);
    };
    require.cache[githubPath] = {id: githubPath, filename: githubPath, loaded: true, exports: {
      pullRequest: () => ref,
      loadPullRequest: async () => analysis,
      loadReviewComments: async () => { loads++; return remote.slice(); },
      postReviewComment: async () => {
        const comment = {id: 34, path: 'file.js', side: 'RIGHT', line: 1, body: 'New comment'};
        remote.push(comment);
        return comment;
      },
      deleteReviewComment: async (actualRef, id) => {
        assert.equal(actualRef, ref);
        assert.equal(id, 33);
        if (failDelete) throw new Error('Permission denied');
        deletes++;
        remote.splice(remote.findIndex(comment => comment.id === id), 1);
      }
    }};
    require.cache[draftsPath] = {id: draftsPath, filename: draftsPath, loaded: true,
      exports: class { async list() { return []; } }};
    delete require.cache[viewPath];
    delete require.cache[providersPath];
    const ReviewView = require('../lib/review-view');
    const view = Object.create(ReviewView.prototype);
    view.provider = require('../lib/providers').github;
    view.emitter = {emit() {}};
    view.address = {value: ''};
    view.results = new Map();
    view.postedDrafts = new Set();
    view.deletingComments = new Set();
    view.render = () => {};
    view.renderHeader = () => {};
    view.renderFiles = () => {};
    view.renderContent = () => { view.renders = (view.renders || 0) + 1; };
    view.select = file => { view.file = file; };
    view.showError = message => { view.error = message; };
    await view.open(ref.url);
    assert.deepEqual(view.comments.map(comment => comment.id), [33]);
    await view.open(ref.url, 'file.js');
    assert.deepEqual(view.comments.map(comment => comment.id), [33]);
    assert.equal(loads, 2);
    const remove = {disabled: false};
    failDelete = true;
    await view.deleteComment(view.comments[0], remove);
    assert.deepEqual(view.comments.map(comment => comment.id), [33]);
    assert.equal(remove.disabled, false);
    assert.match(view.error, /Permission denied/);
    failDelete = false;
    await view.deleteComment(view.comments[0], remove);
    assert.equal(deletes, 1);
    assert.deepEqual(view.comments, []);
    assert.equal(view.renders, 2);
    assert.equal(notices, 0);
    view.composer = {anchor: {path: 'file.js', side: 'RIGHT', line: 1}, body: 'New comment', context: 'file'};
    const form = view.editor();
    await form.events.submit({preventDefault() {}});
    assert.deepEqual(view.comments.map(comment => comment.id), [34]);
    assert.equal(notices, 0);
    await view.open(ref.url);
    assert.deepEqual(view.comments.map(comment => comment.id), [34]);
  } finally {
    Module._load = originalLoad;
    global.atom = originalAtom;
    global.document = originalDocument;
    [viewPath, githubPath, draftsPath, providersPath].forEach((key, index) => {
      if (originalCache[index]) require.cache[key] = originalCache[index];
      else delete require.cache[key];
    });
  }
});
