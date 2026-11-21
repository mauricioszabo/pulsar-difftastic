'use strict';

const {shell} = require('electron');
const {Emitter} = require('atom');
const {createHash, randomUUID} = require('crypto');
const {pullRequest, loadPullRequest, loadReviewComments, postReviewComment, deleteReviewComment} = require('./github');
const {diffFile, patchRows, segments} = require('./diff');
const Drafts = require('./drafts');

const fileStatus = {
  added: ['A', 'Added'], removed: ['D', 'Deleted'], renamed: ['R', 'Renamed'],
  copied: ['C', 'Copied'], modified: ['M', 'Modified'], changed: ['M', 'Changed']
};
const pageSize = 500;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, action) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function statusBadge(file) {
  const [symbol, title] = fileStatus[file.status] || ['·', 'Changed'];
  const badge = el('span', `dpr-file-badge dpr-file-${symbol}`, symbol);
  badge.title = title;
  badge.setAttribute('aria-label', title);
  return badge;
}

function sameAnchor(left, right) {
  return left.path === right.path && left.side === right.side && left.line === right.line &&
    left.baseline === right.baseline && left.head === right.head;
}

class ReviewView {
  static uri = 'atom://difftastic-pr-review/review';

  static newURI() { return `${ReviewView.uri}/${randomUUID()}`; }

  constructor(state = {}) {
    this.uri = state.uri || ReviewView.newURI();
    this.emitter = new Emitter();
    this.element = el('section', 'difftastic-pr-review');
    this.element.setAttribute('aria-label', 'Difftastic PR Review');
    this.results = new Map();
    this.patches = new WeakMap();
    this.drafts = [];
    this.comments = [];
    this.deletingComments = new Set();
    this.postedDrafts = new Set();
    this.mode = 'structural';
    this.limit = pageSize;

    const header = el('header', 'dpr-header');
    const brand = el('div', 'dpr-brand');
    const mark = el('span', 'dpr-mark', '±');
    mark.setAttribute('aria-hidden', 'true');
    brand.append(mark, el('span', null, 'Difftastic PR Review'));

    const form = el('form', 'dpr-address-form');
    this.address = el('input', 'dpr-input native-key-bindings');
    this.address.placeholder = 'GitHub PR URL or owner/repo#123';
    this.address.setAttribute('aria-label', 'GitHub pull request');
    this.address.spellcheck = false;
    this.address.autocomplete = 'off';
    this.address.value = state.url || '';
    const open = el('button', 'dpr-button dpr-primary', 'Load PR');
    open.type = 'submit';
    form.append(this.address, open);
    form.addEventListener('submit', event => {
      event.preventDefault();
      this.open(this.address.value);
    });

    this.actions = el('div', 'dpr-actions');
    header.append(brand, form, this.actions);
    this.summary = el('div', 'dpr-summary');
    this.error = el('div', 'dpr-error');
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    const layout = el('div', 'dpr-layout');
    this.sidebar = el('nav', 'dpr-sidebar');
    this.sidebar.setAttribute('aria-label', 'Changed files');
    this.content = el('main', 'dpr-content');
    layout.append(this.sidebar, this.content);
    this.element.append(header, this.summary, this.error, layout);
    this.render();
    if (state.url) this.open(state.url, state.file);
  }

  getElement() { return this.element; }
  getTitle() { return this.ref ? `Difftastic PR Review: ${this.ref.key}` : 'Difftastic PR Review'; }
  onDidChangeTitle(callback) { return this.emitter.on('did-change-title', callback); }
  getURI() { return this.uri; }
  getDefaultLocation() { return 'center'; }
  getAllowedLocations() { return ['center']; }
  serialize() {
    return {deserializer: 'DifftasticPrReview', uri: this.uri, url: this.ref?.url, file: this.file?.filename};
  }

  focusAddress() {
    this.address.focus();
    this.address.select();
  }

  destroy() {
    this.request?.abort();
    this.emitter.dispose();
    this.element.remove();
  }

  showError(message = '') {
    this.error.textContent = message;
    this.error.hidden = !message;
  }

  async open(input, selected) {
    let ref;
    try {
      ref = pullRequest(input);
    } catch (error) {
      this.showError(error.message);
      return;
    }
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.ref = ref;
    this.emitter.emit('did-change-title');
    this.address.value = ref.url;
    this.analysis = null;
    this.file = null;
    this.results.clear();
    this.drafts = [];
    this.comments = [];
    this.deletingComments.clear();
    this.postedDrafts.clear();
    this.draftStore = new Drafts(atom.getConfigDirPath(), ref.key);
    this.composer = null;
    this.showDrafts = false;
    this.loading = true;
    this.showError();
    this.render();

    try {
      const gh = atom.config.get('difftastic-pr-review.ghPath') || 'gh';
      const [analysis, drafts] = await Promise.all([
        loadPullRequest(ref, gh, request.signal),
        this.draftStore.list().catch(error => {
          if (!request.signal.aborted) this.showError(`Could not read local drafts. ${error.message}`);
          return [];
        })
      ]);
      if (request.signal.aborted) return;
      let comments = [];

      try {
        comments = await loadReviewComments(ref, analysis, gh, request.signal);
      } catch (error) {
        if (!request.signal.aborted) this.showError(`Could not load GitHub comments. ${error.message}`);
      }
      if (request.signal.aborted) return;
      this.comments = comments;
      this.analysis = analysis;
      this.filesByPath = new Map(analysis.files.map(file => [file.filename, file]));
      this.drafts = drafts;

      // Preload all the things!
      analysis.files.forEach(file => this.dispatchDiff(file, request));

      this.loading = false;
      const file = analysis.files.find(candidate => candidate.filename === selected) || analysis.files[0];
      if (file) this.select(file);
      else this.render();
    } catch (error) {
      if (request.signal.aborted) return;
      request.abort();
      this.loading = false;
      this.showError(error.message);
      this.render();
    }
  }

  async select(file) {
    const same = this.file === file && !this.showDrafts;
    this.file = file;
    this.showDrafts = false;
    if (!same) {
      this.mode = 'structural';
      this.limit = pageSize;
      this.content.scrollTop = 0;
    }
    this.render();
    this.compare();
  }

  async compare() {
    const file = this.file;
    const request = this.request;
    if (!file || this.results.has(file.filename) || request.signal.aborted) return;

    if (!request.signal.aborted && this.file === file && this.mode === 'structural' && !this.showDrafts) {
      this.renderContent();
    }
  }

  dispatchDiff(file, request) {
    const binary = atom.config.get('difftastic-pr-review.difftPath') || 'difft';
    this.results.set(file.filename, null);
    const pending = diffFile(this.analysis, file, binary, this.request.signal);

    if (!request.signal.aborted) this.results.set(file.filename, {pending});
    return pending.then(result => {
      if (!request.signal.aborted) this.results.set(file.filename, result);
    }).catch(error => {
      if (!request.signal.aborted) this.results.set(file.filename, {groups: [], error: error.message});
    })
  }

  render() {
    this.renderHeader();
    this.renderFiles();
    this.renderContent();
  }

  renderHeader() {
    this.actions.replaceChildren();
    if (this.ref) {
      this.actions.append(button('Reload', 'dpr-button', () => this.open(this.ref.url, this.file?.filename)));
    }
    this.summary.replaceChildren();
    this.summary.hidden = !this.analysis;
    if (!this.analysis) return;

    const {metadata, files, head} = this.analysis;
    const state = metadata.merged ? 'Merged' : metadata.draft ? 'Draft' : metadata.state === 'closed' ? 'Closed' : 'Open';
    const titleRow = el('div', 'dpr-summary-title');
    titleRow.append(el('span', `dpr-state dpr-state-${state.toLowerCase()}`, state),
      el('h2', null, metadata.title), el('span', 'dpr-muted', `#${this.ref.number}`));
    const meta = el('div', 'dpr-meta');
    const by = metadata.user?.login ? `By ${metadata.user.login}` : 'GitHub pull request';
    meta.append(el('span', null, by), el('span', 'dpr-branches', `${metadata.base.ref} ← ${metadata.head.ref}`),
      el('code', 'dpr-sha', head.slice(0, 8)),
      el('span', null, `${files.length} changed ${files.length === 1 ? 'file' : 'files'}`),
      el('span', 'dpr-added-text', `+${metadata.additions}`), el('span', 'dpr-removed-text', `−${metadata.deletions}`));
    if (metadata.changed_files > files.length) meta.append(el('span', null, `Showing the first ${files.length} files`));
    this.summary.append(titleRow, meta);
    const show = button(`Local drafts · ${this.drafts.length}`, 'dpr-button', () => {
      if (this.showDrafts && this.file) return this.select(this.file);
      this.showDrafts = true;
      this.content.scrollTop = 0;
      this.render();
    });
    show.setAttribute('aria-pressed', String(this.showDrafts));
    this.actions.append(show, button('GitHub ↗', 'dpr-button', () => {
      shell.openExternal(this.ref.url).catch(error => this.showError(error.message));
    }));
  }

  renderFiles() {
    const scrollTop = this.sidebar.scrollTop;
    this.sidebar.replaceChildren();
    this.sidebar.hidden = !this.analysis?.files.length;
    if (this.sidebar.hidden) return;
    const title = el('div', 'dpr-sidebar-title');
    title.append(el('span', null, 'Changed files'), el('span', 'dpr-count', this.analysis.files.length));
    const list = el('ul', 'dpr-file-list');
    const tallies = new Map();
    for (const draft of this.drafts) {
      if (this.isCurrent(draft)) {
        tallies.set(draft.path, (tallies.get(draft.path) || 0) + 1);
      }
    }
    for (const file of this.analysis.files) {
      const row = el('li');
      const item = button('', 'dpr-file', () => this.select(file));
      item.title = file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename;
      if (file === this.file && !this.showDrafts) item.setAttribute('aria-current', 'true');
      const [name, ...parents] = file.filename.split('/').reverse();
      const label = el('span', 'dpr-file-label');
      label.append(el('span', 'dpr-file-name', name));
      if (parents.length) label.append(el('span', 'dpr-dir', parents.reverse().join('/')));
      item.append(statusBadge(file), label);
      if (tallies.has(file.filename)) item.append(el('span', 'dpr-count', tallies.get(file.filename)));
      row.append(item);
      list.append(row);
    }
    this.sidebar.append(title, list);
    this.sidebar.scrollTop = scrollTop;
  }

  renderContent(preservePosition = false) {
    const position = [this.content.scrollTop, this.content.scrollLeft];
    this.content.replaceChildren();
    if (this.loading) return this.message('Loading pull request...');
    if (!this.analysis) return this.message('Open a pull request', 'Paste a GitHub PR URL or owner/repo#123 above.');
    if (this.showDrafts) {
      this.renderDrafts();
    } else if (!this.file) {
      return this.message('No changed files');
    } else {
      this.renderFile();
    }
    if (preservePosition) [this.content.scrollTop, this.content.scrollLeft] = position;
  }

  message(title, description = '') {
    const empty = el('div', 'dpr-empty');
    empty.append(el('h3', null, title));
    if (description) empty.append(el('p', null, description));
    this.content.append(empty);
  }

  renderFile() {
    const file = this.file;
    const result = this.results.get(file.filename);
    const {patch} = this.fileAnchors(file);
    const toolbar = el('div', 'dpr-file-toolbar');
    const name = el('div', 'dpr-current-file');
    name.append(statusBadge(file), el('code', null, file.filename));
    if (file.previous_filename) name.append(el('small', 'dpr-muted', `from ${file.previous_filename}`));
    const modes = el('div', 'dpr-modes');
    for (const [mode, label] of [['structural', 'Difftastic'], ['patch', 'GitHub patch']]) {
      const tab = button(label, 'dpr-button', () => {
        this.mode = mode;
        this.limit = pageSize;
        this.content.scrollTop = 0;
        this.renderContent();
        this.content.querySelector('[aria-pressed="true"]')?.focus();
      });
      tab.setAttribute('aria-pressed', String(this.mode === mode));
      tab.disabled = mode === 'patch' && !patch.length;
      if (tab.disabled) tab.title = 'GitHub did not supply a text patch for this file';
      modes.append(tab);
    }
    toolbar.append(name, modes);
    this.content.append(toolbar);

    const patchMode = this.mode === 'patch';
    if (!patchMode && result.pending) {
      result.pending.then(_ => {
        this.content.replaceChildren();
        this.renderFile();
      });
      return this.message('Computing structural diff...');
    }

    const groups = patchMode ? patch : result.groups;
    if (!groups.length) {
      const message = result?.error || result?.note || 'No lines to display';
      this.message(message, patch.length ? 'Open GitHub patch to see the line-by-line changes.' : '');
      if (result?.error) {
        this.content.append(button('Retry Difftastic', 'dpr-button dpr-retry', () => {
          this.results.delete(file.filename);
          this.renderContent();
          this.compare();
        }));
      }
      return;
    }

    const diff = el('div', 'dpr-diff');
    if (patchMode) diff.classList.add('is-patch');
    const heading = el('div', 'dpr-column-labels');
    heading.append(el('span', null, 'Before'), el('span', null, 'After'));
    if (!patchMode && result.language) heading.append(el('small', null, result.language));
    diff.append(heading);

    const indexed = new Map();
    const posted = new Map();
    for (const comment of this.comments) {
      if (comment.path !== file.filename) continue;
      const key = `${comment.side}:${comment.line}`;
      if (!posted.has(key)) posted.set(key, []);
      posted.get(key).push(comment);
    }
    for (const draft of this.drafts) {
      if (draft.path !== file.filename || !this.isCurrent(draft)) continue;
      const key = `${draft.side}:${draft.line}`;
      if (!indexed.has(key)) indexed.set(key, []);
      indexed.get(key).push(draft);
    }

    let rendered = 0;
    for (const group of groups) {
      if (rendered >= this.limit) break;
      const [firstLeft, firstRight] = group.rows[0];
      const label = group.label || `Line ${firstLeft?.number ?? '—'}  /  Line ${firstRight?.number ?? '—'}`;
      diff.append(el('div', 'dpr-hunk', label));
      for (const row of group.rows.slice(0, this.limit - rendered)) {
        const line = el('div', 'dpr-diff-row');
        const comments = el('div', 'dpr-comment-row');
        const fullAdded = !row[0] && Boolean(row[1]);
        const fullRemoved = Boolean(row[0]) && !row[1];
        for (const [index, cell] of row.entries()) {
          const side = index === 0 ? 'LEFT' : 'RIGHT';
          const anchor = cell && this.anchor(side, cell.number);
          const local = anchor && indexed.get(`${side}:${cell.number}`) || [];
          const remote = anchor && posted.get(`${side}:${cell.number}`) || [];
          const emptyClass = !cell && row[1 - index]
            ? (index === 1 ? 'is-fully-removed' : 'is-fully-added')
            : null;
          const node = this.lineCell(cell, anchor, local.length + remote.length, emptyClass);
          if (cell && (fullAdded || fullRemoved)) node.classList.add('is-whole-line');
          line.append(node);
          const column = el('div', 'dpr-comment-column');
          for (const draft of local) column.append(this.draftCard(draft, false));
          for (const comment of remote) column.append(this.commentCard(comment));
          if (anchor && this.composer?.context === 'file' && sameAnchor(anchor, this.composer.anchor)) {
            column.append(this.editor());
          }
          comments.append(column);
        }
        diff.append(line);
        if (comments.querySelector('article, form')) diff.append(comments);
        rendered++;
      }
    }

    if (groups.reduce((total, group) => total + group.rows.length, 0) > rendered) {
      diff.append(button('Show more lines', 'dpr-button dpr-more', () => {
        this.limit += pageSize;
        this.renderContent(true);
      }));
    }
    this.content.append(diff);
  }

  anchor(side, line) {
    return {
      path: this.file.filename, oldPath: this.file.previous_filename || this.file.filename,
      side, line, baseline: this.fileAnchors(this.file).baseline, head: this.analysis.head
    };
  }

  fileAnchors(file) {
    if (!this.patches.has(file)) {
      const patch = patchRows(file.patch);
      const baseline = patch.length
        ? createHash('sha256').update(file.previous_filename || file.filename).update('\0').update(file.patch).digest('hex')
        : this.analysis.mergeBase || this.analysis.metadata.base.sha;
      this.patches.set(file, {patch, baseline});
    }
    return this.patches.get(file);
  }

  isCurrent(draft) {
    if (draft.head !== this.analysis.head) return false;
    const file = this.filesByPath.get(draft.path);
    return Boolean(file && draft.baseline === this.fileAnchors(file).baseline);
  }

  canComment(anchor, cell) {
    const index = anchor.side === 'LEFT' ? 0 : 1;
    return this.fileAnchors(this.file).patch.some(group => group.rows.some(row =>
      row[index]?.number === anchor.line && row[index].text === cell.text));
  }

  lineCell(cell, anchor, count, emptyClass) {
    const column = el('div', 'dpr-line');
    if (!cell) {
      if (emptyClass) column.classList.add(emptyClass);
      return column;
    }
    if (cell.changed) column.classList.add(anchor.side === 'LEFT' ? 'is-removed' : 'is-added');
    const gutter = button('', 'dpr-gutter', () => this.edit(anchor, 'file'));
    const label = `Comment on ${anchor.side === 'LEFT' ? 'before' : 'after'} line ${cell.number}`;
    gutter.disabled = !this.canComment(anchor, cell);
    gutter.title = gutter.disabled ? 'Only matching lines in the GitHub patch can be commented on' : label;
    gutter.setAttribute('aria-label', label);
    if (count) gutter.classList.add('dpr-has-comment');
    const plus = el('span', 'dpr-line-plus', '+');
    plus.setAttribute('aria-hidden', 'true');
    gutter.append(plus, el('span', 'dpr-line-number', cell.number));
    const code = el('code', 'dpr-code');
    for (const piece of segments(cell.text, cell.spans)) {
      code.append(piece.changed ? el('mark', null, piece.text) : document.createTextNode(piece.text));
    }
    if (cell.noNewline) {
      const marker = el('span', 'dpr-eof', ' ↵');
      marker.title = 'No newline at end of file';
      marker.setAttribute('aria-label', marker.title);
      code.append(marker);
    }
    column.append(gutter, code);
    return column;
  }

  renderDrafts() {
    const list = el('div', 'dpr-drafts');
    list.append(el('h3', null, 'Local drafts'));
    if (!this.drafts.length) list.append(el('p', 'dpr-muted', 'No saved local drafts. Click a diff line to post a comment to GitHub.'));
    for (const draft of this.drafts) {
      list.append(this.draftCard(draft, true));
      if (this.composer?.context === 'drafts' && this.composer.existing?.id === draft.id) {
        list.append(this.editor());
      }
    }
    this.content.append(list);
  }

  draftCard(draft, detailed) {
    const card = el('article', 'dpr-draft');
    const header = el('div', 'dpr-draft-head');
    const heading = detailed
      ? `${draft.side === 'LEFT' ? draft.oldPath : draft.path} · ${draft.side === 'LEFT' ? 'before' : 'after'} ${draft.line}`
      : 'Local draft';
    header.append(el('strong', null, heading));
    if (detailed && !this.isCurrent(draft)) {
      header.append(el('span', 'dpr-muted', `Earlier revision · ${draft.head.slice(0, 8)}`));
    }
    const actions = el('div', 'dpr-draft-actions');
    const send = button('Post to GitHub', 'dpr-button', () => this.edit(draft, detailed ? 'drafts' : 'file', draft));
    send.disabled = !this.isCurrent(draft) || this.postedDrafts.has(draft.id);
    if (send.disabled) send.title = 'Reload the PR to review this draft against the latest patch';
    actions.append(send, button('Delete', 'dpr-button', () => this.deleteDraft(draft)));
    header.append(actions);
    card.append(header, el('p', 'dpr-draft-body', draft.body));
    return card;
  }

  commentCard(comment) {
    const card = el('article', 'dpr-draft');
    const link = el('a', null, `${comment.user?.login || 'GitHub'} ↗`);
    const url = typeof comment.html_url === 'string' && comment.html_url.startsWith(`${this.ref.url}#`)
      ? comment.html_url : this.ref.url;
    link.href = url;
    link.addEventListener('click', event => {
      event.preventDefault();
      shell.openExternal(url).catch(error => this.showError(error.message));
    });
    const actions = el('div', 'dpr-draft-actions');
    const remove = button('Delete', 'dpr-button', () => this.deleteComment(comment, remove));
    remove.disabled = this.deletingComments.has(comment.id);
    actions.append(remove);
    const header = el('div', 'dpr-draft-head');
    header.append(link, actions);
    card.append(header, el('p', 'dpr-draft-body', comment.body));
    return card;
  }

  async deleteComment(comment, button) {
    if (this.deletingComments.has(comment.id)) return;
    const response = atom.confirm({
      message: 'Delete this GitHub review comment?',
      buttons: ['Cancel', 'Delete']
    });
    if (response !== 1) return;
    const request = this.request;
    const ref = this.ref;
    this.deletingComments.add(comment.id);
    button.disabled = true;
    try {
      await deleteReviewComment(ref, comment.id, atom.config.get('difftastic-pr-review.ghPath') || 'gh', request.signal);
      if (request.signal.aborted || ref !== this.ref) return;
      this.comments = this.comments.filter(item => item.id !== comment.id);
      this.showError();
      this.renderContent(true);
    } catch (error) {
      if (!request.signal.aborted && ref === this.ref) {
        this.showError(`Could not delete GitHub comment. ${error.message}`);
        button.disabled = false;
        this.deletingComments.delete(comment.id);
        this.renderContent(true);
      }
    } finally {
      this.deletingComments.delete(comment.id);
    }
  }

  async deleteDraft(draft) {
    const response = atom.confirm({
      message: 'Delete this local draft?',
      buttons: ['Cancel', 'Delete']
    });
    if (response !== 1) return;
    const store = this.draftStore;
    try {
      await store.remove(draft);
      if (store !== this.draftStore) return;
      this.drafts = this.drafts.filter(item => item.id !== draft.id);
      if (this.composer?.existing?.id === draft.id) this.composer = null;
      this.renderHeader();
      this.renderFiles();
      this.renderContent(true);
    } catch (error) {
      if (store === this.draftStore) this.showError(`Could not delete draft. ${error.message}`);
    }
  }

  edit(anchor, context, existing = null) {
    if (this.composer?.saving) return;
    const composing = this.composer;
    if (!composing || composing.body === (composing.existing?.body || '')) {
      this.composer = {anchor, context, existing, body: existing?.body || ''};
    } else if (!sameAnchor(composing.anchor, anchor) || composing.existing?.id !== existing?.id) {
      this.showError('Post or cancel the open comment first.');
      return;
    } else {
      composing.context = context;
    }
    this.showError();
    this.renderContent(true);
    this.content.querySelector('textarea')?.focus();
  }

  editor() {
    const composer = this.composer;
    const form = el('form', 'dpr-editor');
    const box = el('textarea', 'dpr-input native-key-bindings');
    box.required = true;
    box.maxLength = 65536;
    box.value = composer.body;
    box.placeholder = 'Write a GitHub review comment...';
    box.setAttribute('aria-label', 'GitHub review comment');
    box.addEventListener('input', () => { composer.body = box.value; });
    const actions = el('div', 'dpr-draft-actions');
    const save = el('button', 'dpr-button dpr-primary', 'Post to GitHub');
    save.type = 'submit';
    const cancel = button('Cancel', 'dpr-button', () => {
      this.composer = null;
      this.showError();
      this.renderContent(true);
    });
    cancel.disabled = save.disabled = box.disabled = Boolean(composer.saving);
    actions.append(cancel, save);
    form.append(box, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (composer.saving || !box.value.trim()) return;
      composer.saving = true;
      cancel.disabled = save.disabled = box.disabled = true;
      const request = this.request;
      const store = this.draftStore;
      try {
        const comment = await postReviewComment(this.ref, this.analysis, composer.anchor, box.value.trim(),
          atom.config.get('difftastic-pr-review.ghPath') || 'gh', request.signal);
        if (request.signal.aborted || store !== this.draftStore) return;
        this.comments.push(comment);
        let cleanupError;
        if (composer.existing) {
          this.postedDrafts.add(composer.existing.id);
          this.drafts = this.drafts.filter(item => item.id !== composer.existing.id);
          try { await store.remove(composer.existing); }
          catch (error) { cleanupError = error; }
        }
        if (request.signal.aborted || store !== this.draftStore) return;
        this.composer = null;
        this.showError(cleanupError ? `Comment posted, but could not remove local draft: ${cleanupError.message}` : '');
        this.renderHeader();
        this.renderFiles();
        this.renderContent(true);
      } catch (error) {
        if (request.signal.aborted || store !== this.draftStore) return;
        composer.saving = false;
        this.showError(`Could not post comment. ${error.message}`);
        this.renderContent(true);
        this.content.querySelector('textarea')?.focus();
      }
    });
    return form;
  }
}

module.exports = ReviewView;
