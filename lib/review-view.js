'use strict';

const {shell} = require('electron');
const {Emitter} = require('atom');
const {createHash, randomUUID} = require('crypto');
const {pathToFileURL} = require('url');
const providers = require('./providers');
const {diffFile, diffTexts, patchRows, segments, windowSpan} = require('./diff');
const Drafts = require('./drafts');
const {localFilesForReview} = require('./local-files');

const fileStatus = {
  added: ['A', 'Added'], removed: ['D', 'Deleted'], renamed: ['R', 'Renamed'],
  copied: ['C', 'Copied'], modified: ['M', 'Modified'], changed: ['M', 'Changed']
};
const pageSize = 1500;
const sides = ['dpr-left', 'dpr-right'];
const scrollBehaviors = [['soft-wrap', 'Soft wrap'], ['individual', 'Individual scroll'], ['sync', 'Sync scroll']];

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
  static uri = 'atom://difftastic/review';

  static newURI(provider) { return `${ReviewView.uri}/${provider}/${randomUUID()}`; }

  constructor(state = {}) {
    this.providerName = state.provider || 'github';
    this.provider = providers[this.providerName];
    this.uri = state.uri || ReviewView.newURI(this.providerName);
    this.emitter = new Emitter();
    this.element = el('section', 'difftastic');
    this.element.setAttribute('aria-label', 'Difftastic');
    this.results = new Map();
    this.patches = new WeakMap();
    this.drafts = [];
    this.comments = [];
    this.deletingComments = new Set();
    this.postedDrafts = new Set();
    this.mode = state.mode || 'structural';
    this.renderedRows = [];
    this.horizontal = [0, 0];
    this.limit = pageSize;
    this.configSubscription = atom.config.onDidChange('difftastic.scrollBehavior', () => {
      this.renderHeader();
      this.scrollTarget = this.firstVisibleLine();
      this.renderContent();
    });

    const header = el('header', 'dpr-header');
    const brand = el('div', 'dpr-brand');
    const mark = el('span', 'dpr-mark', '±');
    mark.setAttribute('aria-hidden', 'true');
    brand.append(mark, el('span', null, 'Difftastic'));

    const form = el('form', 'dpr-address-form');
    this.address = el('input', 'dpr-input native-key-bindings');
    this.address.placeholder = `${this.provider.service} ${this.provider.short} URL or ${this.provider.example}`;
    this.address.setAttribute('aria-label', `${this.provider.service} ${this.provider.item}`);
    this.address.spellcheck = false;
    this.address.autocomplete = 'off';
    this.address.value = state.url || '';
    const open = el('button', 'dpr-button dpr-primary', `Load ${this.provider.short}`);
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
  getTitle() { return this.ref ? `Difftastic: ${this.ref.key}` : 'Difftastic'; }
  onDidChangeTitle(callback) { return this.emitter.on('did-change-title', callback); }
  getURI() { return this.uri; }
  getDefaultLocation() { return 'center'; }
  getAllowedLocations() { return ['center']; }
  serialize() {
    return {
      deserializer: 'Difftastic', provider: this.providerName, uri: this.uri, url: this.ref?.url,
      file: this.file?.filename, mode: this.mode
    };
  }

  focusAddress() {
    this.address.focus();
    this.address.select();
  }

  destroy() {
    this.request?.abort();
    this.resizeObserver?.disconnect();
    this.configSubscription.dispose();
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
      ref = this.provider.parse(input);
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
    this.view = 'file';
    this.blocks = new Map();
    this.toggles = new Map();
    this.loading = true;
    this.showError();
    this.render();

    try {
      const binary = atom.config.get(this.provider.setting);
      const [analysis, drafts] = await Promise.all([
        this.provider.load(ref, binary, request.signal),
        this.draftStore.list().catch(error => {
          if (!request.signal.aborted) this.showError(`Could not read local drafts. ${error.message}`);
          return [];
        })
      ]);
      if (request.signal.aborted) return;
      let comments = [];

      try {
        comments = await this.provider.loadComments(ref, analysis, binary, request.signal);
      } catch (error) {
        if (!request.signal.aborted) this.showError(`Could not load ${this.provider.service} comments. ${error.message}`);
      }
      if (request.signal.aborted) return;
      if (request.signal.aborted) return;
      const localFiles = await localFilesForReview(analysis, atom.project.getPaths());
      if (request.signal.aborted) return;
      this.localFiles = localFiles;
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
    const same = this.file === file && this.view === 'file';
    this.file = file;
    this.view = 'file';
    if (!same) {
      this.limit = pageSize;
      this.horizontal = [0, 0];
      this.content.scrollTop = 0;
    }
    this.render();
    this.compare();
  }

  async compare() {
    const file = this.file;
    const request = this.request;
    if (!file || this.results.has(file.filename) || request.signal.aborted) return;

    if (!request.signal.aborted && this.file === file && this.mode === 'structural' && this.view === 'file') {
      this.renderContent();
    }
  }

  dispatchDiff(file, request) {
    const binary = atom.config.get('difftastic.difftPath');
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
      const behavior = el('select', 'dpr-select native-key-bindings');
      behavior.setAttribute('aria-label', 'Scroll behavior');
      for (const [value, label] of scrollBehaviors) {
        const option = el('option', null, label);
        option.value = value;
        behavior.append(option);
      }
      behavior.value = atom.config.get('difftastic.scrollBehavior');
      behavior.addEventListener('change', () => atom.config.set('difftastic.scrollBehavior', behavior.value));
      this.actions.append(behavior, button('Reload', 'dpr-button', () => this.open(this.ref.url, this.file?.filename)));
    }
    this.summary.replaceChildren();
    this.summary.hidden = !this.analysis;
    if (!this.analysis) return;

    const {metadata, files, head} = this.analysis;
    const state = metadata.merged ? 'Merged' : metadata.draft ? 'Draft' : metadata.state === 'closed' ? 'Closed' : 'Open';
    const titleRow = el('div', 'dpr-summary-title');
    titleRow.append(el('span', `dpr-state dpr-state-${state.toLowerCase()}`, state),
      el('h2', null, metadata.title), el('span', 'dpr-muted', `${this.provider.symbol}${this.ref.number}`));
    const meta = el('div', 'dpr-meta');
    const by = metadata.user?.login ? `By ${metadata.user.login}` : `${this.provider.service} ${this.provider.item}`;
    meta.append(el('span', null, by), el('span', 'dpr-branches', `${metadata.base.ref} ← ${metadata.head.ref}`),
      el('code', 'dpr-sha', head.slice(0, 8)),
      el('span', null, `${files.length} changed ${files.length === 1 ? 'file' : 'files'}`),
      el('span', 'dpr-added-text', `+${metadata.additions}`), el('span', 'dpr-removed-text', `−${metadata.deletions}`));
    if (metadata.changed_files > files.length) meta.append(el('span', null, `Showing the first ${files.length} files`));
    this.summary.append(titleRow, meta);
    const show = button(`Local drafts · ${this.drafts.length}`, 'dpr-button', () => {
      if (this.view === 'drafts' && this.file) return this.select(this.file);
      this.view = 'drafts';
      this.content.scrollTop = 0;
      this.render();
    });
    show.setAttribute('aria-pressed', String(this.view === 'drafts'));
    this.actions.append(show, button(`${this.provider.service} ↗`, 'dpr-button', () => {
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
      if (file === this.file && this.view === 'file') item.setAttribute('aria-current', 'true');
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

    const resolved = this.analysis.files.filter(file => this.resolvedThreads(file).length);
    if (resolved.length) {
      const heading = el('div', 'dpr-sidebar-title');
      heading.append(el('span', null, 'Resolved issues'), el('span', 'dpr-count', resolved.length));
      const issues = el('ul', 'dpr-file-list');
      for (const file of resolved) {
        const row = el('li');
        const item = button('', 'dpr-file', () => this.openResolved(file));
        item.title = file.filename;
        if (file === this.file && this.view === 'resolved') item.setAttribute('aria-current', 'true');
        const [name, ...parents] = file.filename.split('/').reverse();
        const label = el('span', 'dpr-file-label');
        label.append(el('span', 'dpr-file-name', name));
        if (parents.length) label.append(el('span', 'dpr-dir', parents.reverse().join('/')));
        item.append(statusBadge(file), label, el('span', 'dpr-count', this.resolvedThreads(file).length));
        row.append(item);
        issues.append(row);
      }
      this.sidebar.append(heading, issues);
    }
    this.sidebar.scrollTop = scrollTop;
  }

  resolvedThreads(file) {
    const threads = new Map();
    for (const comment of this.comments) {
      if (comment.path !== file.filename || !(comment.outdated || comment.resolved)) continue;
      if (!threads.has(comment.thread)) threads.set(comment.thread, []);
      threads.get(comment.thread).push(comment);
    }
    return [...threads.values()]
      .map(list => list.slice().sort((left, right) => left.id - right.id))
      .sort((left, right) => (left[0].originalLine || 0) - (right[0].originalLine || 0));
  }

  openResolved(file) {
    this.file = file;
    this.view = 'resolved';
    this.content.scrollTop = 0;
    this.render();
  }

  renderContent(preservePosition = false) {
    const position = [this.content.scrollTop, this.content.scrollLeft];
    this.renderedRows = [];
    this.resizeObserver?.disconnect();
    this.content.replaceChildren();
    if (this.loading) return this.message('Loading pull request...');
    if (!this.analysis) {
      const {service, item, short, example} = this.provider;
      return this.message(`Open a ${item}`, `Paste a ${service} ${short} URL or ${example} above.`);
    }
    if (this.view === 'drafts') {
      this.renderDrafts();
    } else if (!this.file) {
      return this.message('No changed files');
    } else if (this.view === 'resolved') {
      this.renderResolved();
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
    this.renderedRows = [];
    const file = this.file;
    const result = this.results.get(file.filename);
    const {patch} = this.fileAnchors(file);
    const toolbar = el('div', 'dpr-file-toolbar');
    const name = el('div', 'dpr-current-file');
    name.append(statusBadge(file));
    const localPath = this.localFiles?.get(file.filename);
    if (localPath) {
      const link = el('a', 'dpr-local-file-link', file.filename);
      link.href = pathToFileURL(localPath).href;
      link.title = `Open ${file.filename} from the matching local HEAD in Pulsar`;
      link.addEventListener('click', event => {
        event.preventDefault();
        atom.workspace.open(localPath, {searchAllPanes: true}).catch(error => this.showError(error.message));
      });
      name.append(link);
    } else {
      name.append(el('code', null, file.filename));
    }
    if (file.previous_filename) name.append(el('small', 'dpr-muted', `from ${file.previous_filename}`));
    const patchMode = this.mode === 'patch' && patch.length > 0;
    const modes = el('div', 'dpr-modes');
    for (const [mode, label] of [['structural', 'Difftastic'], ['patch', 'Git Patch']]) {
      const tab = button(label, 'dpr-button', () => {
        this.scrollTarget = this.firstVisibleLine();
        this.mode = mode;
        this.limit = pageSize;
        this.content.scrollTop = 0;
        this.renderContent();
        this.content.querySelector('[aria-pressed="true"]')?.focus();
      });
      tab.setAttribute('aria-pressed', String(patchMode === (mode === 'patch')));
      tab.disabled = mode === 'patch' && !patch.length;
      if (tab.disabled) tab.title = `${this.provider.service} did not supply a text patch for this file`;
      modes.append(tab);
    }
    toolbar.append(name, modes);
    this.content.append(toolbar);

    if (!patchMode && result.pending) {
      const request = this.request;
      result.pending.then(_ => {
        if (this.request !== request || this.view !== 'file' || this.file !== file) return;
        this.content.replaceChildren();
        this.renderFile();
      });
      return this.message('Computing structural diff...');
    }

    const target = this.scrollTarget;
    this.scrollTarget = null;
    const groups = patchMode ? patch : result.groups;
    if (!groups.length) {
      const message = result?.error || result?.note || 'No lines to display';
      this.message(message, patch.length ? 'Open Git Patch to see the line-by-line changes.' : '');
      if (result?.error) {
        this.content.append(button('Retry Difftastic', 'dpr-button dpr-retry', () => {
          this.results.delete(file.filename);
          this.renderContent();
          this.compare();
        }));
      }
      return;
    }
    const rows = groups.flatMap(group => group.rows);
    name.append(el('span', 'dpr-added-text', `+${rows.filter(row => row[1]?.changed).length}`),
      el('span', 'dpr-removed-text', `−${rows.filter(row => row[0]?.changed).length}`));

    const diff = el('div', 'dpr-diff');
    if (patchMode) diff.classList.add('is-patch');
    const heading = el('div', 'dpr-column-labels');
    heading.append(el('span', null, 'Before'), el('span', null, 'After'));
    if (!patchMode && result.language) heading.append(el('small', null, result.language));
    diff.append(heading);

    const indexed = new Map();
    const posted = new Map();
    for (const comment of this.comments) {
      if (comment.path !== file.filename || comment.outdated) continue;
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

    const targetIndex = target
      ? groups.flatMap(group => group.rows).findLastIndex(row => row[target.side]?.number <= target.number)
      : -1;
    if (targetIndex >= 0) this.limit = Math.max(this.limit, (Math.floor(targetIndex / pageSize) + 1) * pageSize);

    const {grid, rendered} = this.buildGrid(groups, {limit: this.limit, indexed, posted, track: true});
    diff.append(grid);

    if (groups.reduce((total, group) => total + group.rows.length, 0) > rendered) {
      diff.append(button('Show more lines', 'dpr-button dpr-more', () => {
        this.limit += pageSize;
        this.renderContent(true);
      }));
    }
    this.content.append(diff);
    this.addHorizontalScroll(diff, grid);
    const element = this.renderedRows[targetIndex]?.element;
    if (element) {
      this.content.scrollTop += element.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom - target.offset;
    }
  }

  buildGrid(groups, {limit = Infinity, indexed = new Map(), posted = new Map(), track = false} = {}) {
    const grid = el('div', 'dpr-grid');
    let gridRow = 0;
    let blocks = [null, null];
    let rendered = 0;
    for (const group of groups) {
      if (rendered >= limit) break;
      const [firstLeft, firstRight] = group.rows[0];
      const label = group.label || `Line ${firstLeft?.number ?? '—'}  /  Line ${firstRight?.number ?? '—'}`;
      const hunk = el('div', 'dpr-hunk', label);
      hunk.style.gridRow = ++gridRow;
      grid.append(hunk);
      blocks = [null, null];
      for (const row of group.rows.slice(0, limit - rendered)) {
        gridRow++;
        const wholeLine = !row[0] || !row[1];
        const comments = row.map((_, index) => {
          const column = el('div', `dpr-comment-column ${sides[index]}`);
          column.style.gridColumn = index + 1;
          return column;
        });
        for (const [index, cell] of row.entries()) {
          if (!cell) {
            const block = blocks[index];
            if (block) {
              block.span++;
              block.element.style.gridRow = `${block.start} / span ${block.span}`;
            } else {
              const element = el('div', `dpr-line ${sides[index]} ${index === 1 ? 'is-fully-removed' : 'is-fully-added'}`);
              element.style.gridRow = gridRow;
              element.style.gridColumn = index + 1;
              grid.append(element);
              blocks[index] = {element, start: gridRow, span: 1};
            }
            continue;
          }
          blocks[index] = null;
          const side = index === 0 ? 'LEFT' : 'RIGHT';
          const anchor = track ? this.anchor(side, cell.number) : {side, line: cell.number};
          const local = indexed.get(`${side}:${cell.number}`) || [];
          const remote = posted.get(`${side}:${cell.number}`) || [];
          const node = this.lineCell(cell, anchor, local.length + remote.length, track);
          node.classList.add(sides[index]);
          if (wholeLine) node.classList.add('is-whole-line');
          node.style.gridRow = gridRow;
          node.style.gridColumn = index + 1;
          grid.append(node);
          if (track && index === (row[1] ? 1 : 0)) this.renderedRows.push({row, element: node});
          for (const draft of local) comments[index].append(this.draftCard(draft, false));
          for (const comment of remote) comments[index].append(this.commentCard(comment));
          if (track && this.composer?.context === 'file' && sameAnchor(anchor, this.composer.anchor)) {
            comments[index].append(this.editor());
          }
        }
        if (comments.some(column => column.childElementCount)) {
          gridRow++;
          for (const column of comments) {
            column.style.gridRow = gridRow;
            grid.append(column);
          }
          blocks = [null, null];
        }
        rendered++;
      }
    }
    return {grid, rendered};
  }

  addHorizontalScroll(diff, grid) {
    const behavior = atom.config.get('difftastic.scrollBehavior');
    diff.classList.add(`is-${behavior}`);
    if (behavior === 'soft-wrap') return;
    const bars = el('div', 'dpr-scrollbars');
    const scrollers = (behavior === 'sync' ? [[0, 1]] : [[0], [1]]).map(columns => {
      const bar = el('div', 'dpr-scrollbar');
      const spacer = el('div', 'dpr-scrollbar-spacer');
      const update = () => {
        for (const column of columns) {
          this.horizontal[column] = bar.scrollLeft;
          diff.style.setProperty(`--dpr-scroll-${column}`, `${bar.scrollLeft}px`);
        }
      };
      bar.append(spacer);
      bar.addEventListener('scroll', update);
      bars.append(bar);
      return {bar, spacer, columns, update};
    });
    diff.append(bars);

    grid.addEventListener('wheel', event => {
      const line = event.target.closest('.dpr-line');
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!line || !horizontal) return;
      const column = line.classList.contains('dpr-left') ? 0 : 1;
      const {bar} = scrollers.find(({columns}) => columns.includes(column));
      bar.scrollLeft += event.deltaX || event.deltaY;
      event.preventDefault();
    });

    this.resizeObserver = new ResizeObserver(() => {
      const overflow = sides.map(side => Math.max(0, ...Array.from(grid.querySelectorAll(`.${side} .dpr-code`),
        code => code.firstChild.offsetWidth - code.clientWidth)));
      for (const {bar, spacer, columns, update} of scrollers) {
        const extra = Math.max(...columns.map(column => overflow[column]));
        spacer.style.width = `${bar.clientWidth + extra}px`;
        bar.classList.toggle('is-idle', extra === 0);
        bar.scrollLeft = this.horizontal[columns[0]];
        update();
      }
    });
    this.resizeObserver.observe(grid);
  }

  firstVisibleLine() {
    const toolbar = this.content.querySelector('.dpr-file-toolbar');
    if (!toolbar) return null;
    const top = toolbar.getBoundingClientRect().bottom;
    const visible = this.renderedRows.find(({element}) => element.getBoundingClientRect().bottom > top);
    if (!visible) return null;
    const side = visible.row[1] ? 1 : 0;
    return {side, number: visible.row[side].number, offset: visible.element.getBoundingClientRect().top - top};
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

  lineCell(cell, anchor, count, commentable = true) {
    const column = el('div', 'dpr-line');
    if (cell.changed) column.classList.add(anchor.side === 'LEFT' ? 'is-removed' : 'is-added');
    const gutter = button('', 'dpr-gutter', () => commentable && this.edit(anchor, 'file'));
    const label = `Comment on ${anchor.side === 'LEFT' ? 'before' : 'after'} line ${cell.number}`;
    gutter.disabled = !commentable || !this.canComment(anchor, cell);
    if (commentable) gutter.title = gutter.disabled ? 'Only matching lines in the Git patch can be commented on' : label;
    gutter.setAttribute('aria-label', commentable ? label : `Line ${cell.number}`);
    if (count) gutter.classList.add('dpr-has-comment');
    const plus = el('span', 'dpr-line-plus', '+');
    plus.setAttribute('aria-hidden', 'true');
    gutter.append(plus, el('span', 'dpr-line-number', cell.number));
    const code = el('code', 'dpr-code');
    const text = el('span', 'dpr-code-text');
    for (const piece of segments(cell.text, cell.spans)) {
      text.append(piece.changed ? el('mark', null, piece.text) : document.createTextNode(piece.text));
    }
    if (cell.noNewline) {
      const marker = el('span', 'dpr-eof', ' ↵');
      marker.title = 'No newline at end of file';
      marker.setAttribute('aria-label', marker.title);
      text.append(marker);
    }
    code.append(text);
    column.append(gutter, code);
    return column;
  }

  renderDrafts() {
    const list = el('div', 'dpr-drafts');
    list.append(el('h3', null, 'Local drafts'));
    if (!this.drafts.length) list.append(el('p', 'dpr-muted', `No saved local drafts. Click a diff line to post a comment to ${this.provider.service}.`));
    for (const draft of this.drafts) {
      list.append(this.draftCard(draft, true));
      if (this.composer?.context === 'drafts' && this.composer.existing?.id === draft.id) {
        list.append(this.editor());
      }
    }
    this.content.append(list);
  }

  renderResolved() {
    const file = this.file;
    const threads = this.resolvedThreads(file);
    const list = el('div', 'dpr-issues');
    const heading = el('div', 'dpr-current-file');
    heading.append(statusBadge(file), el('code', null, file.filename),
      el('span', 'dpr-muted', `${threads.length} resolved ${threads.length === 1 ? 'issue' : 'issues'}`));
    list.append(heading);
    if (!threads.length) list.append(el('p', 'dpr-muted', 'This file has no resolved or outdated comments.'));
    for (const thread of threads) list.append(this.issueCard(thread));
    this.content.append(list);
  }

  issueCard(thread) {
    const [first] = thread;
    const card = el('article', 'dpr-issue');
    const head = el('div', 'dpr-issue-head');
    head.append(el('code', null, first.path),
      el('span', 'dpr-muted', `${first.side === 'LEFT' ? 'before' : 'after'} line ${first.originalLine}`));
    if (first.resolved) head.append(el('span', 'dpr-badge dpr-badge-resolved', 'Resolved'));
    if (first.outdated) head.append(el('span', 'dpr-badge dpr-badge-outdated', 'Outdated'));
    card.append(head);

    const original = this.block(`original:${first.id}`, () => this.originalBlock(first));
    card.append(this.blockNode(original, 'Loading the original diff...'));
    for (const comment of thread) card.append(this.commentCard(comment));

    const toggles = el('div', 'dpr-issue-toggles');
    const slots = el('div', 'dpr-issue-slots');
    for (const [kind, label] of [['current', 'Current code'], ['changed', 'What changed since']]) {
      const key = `${kind}:${first.id}`;
      const box = el('label', 'dpr-toggle');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = Boolean(this.toggles.get(key));
      input.addEventListener('change', () => {
        this.toggles.set(key, input.checked);
        this.renderContent(true);
      });
      box.append(input, el('span', null, label));
      toggles.append(box);
      if (!input.checked) continue;
      const result = kind === 'current'
        ? this.currentBlock(first, original)
        : this.block(key, () => this.changedBlock(first));
      slots.append(el('h4', 'dpr-issue-slot-title', label),
        this.blockNode(result, 'Comparing the comment’s revision with the head...'));
    }
    card.append(toggles, slots);
    return card;
  }

  block(key, load) {
    const cached = this.blocks.get(key);
    if (cached) return cached;
    const request = this.request;
    const entry = {pending: true};
    this.blocks.set(key, entry);
    const settle = result => {
      if (request.signal.aborted || this.blocks.get(key) !== entry) return;
      this.blocks.set(key, result);
      if (this.view === 'resolved') this.renderContent(true);
    };
    load().then(settle, error => settle({note: error.message}));
    return entry;
  }

  blockNode(result, loadingText) {
    if (result.pending) return el('p', 'dpr-muted', loadingText);
    if (!result.groups?.length) return el('p', 'dpr-muted', result.note || 'No lines to display');
    const wrapper = el('div', 'dpr-diff is-soft-wrap');
    if (result.warning) wrapper.append(el('p', 'dpr-muted', result.warning));
    wrapper.append(this.buildGrid(result.groups).grid);
    return wrapper;
  }

  currentBlock(comment, original) {
    if (original.pending) return original;
    const ranges = original.range || [original.anchor, null];
    if (!ranges.some(Boolean)) return {note: 'The original diff has no lines to anchor on.'};
    const file = this.filesByPath.get(comment.path);
    const result = this.results.get(file.filename);
    const groups = this.mode === 'patch' || !result?.groups?.length
      ? this.fileAnchors(file).patch : result.groups;
    const side = comment.side === 'LEFT' ? 0 : 1;
    const covering = windowSpan(groups, ranges,
      {side, range: [comment.originalLine, comment.originalLine]});
    if (!covering.length) return {note: 'This region is no longer part of the diff.'};
    const base = new Map();
    for (const group of original.groups) {
      for (const row of group.rows) if (row[0]) base.set(row[0].number, row[0].text);
    }
    const aligned = !base.size || groups.some(group => group.rows.some(row =>
      row[0] && base.get(row[0].number) === row[0].text));
    return {groups: covering, warning: aligned ? '' : 'The base of this file moved, so these lines may not line up.'};
  }

  // The provider only has the Git patch of the comment's revision. Rebuilding that revision's
  // structural diff gives the same lines back, with Difftastic's intra-line detail.
  async originalBlock(comment) {
    const patch = await this.provider.commentBlock(this.ref, this.analysis, comment,
      atom.config.get(this.provider.setting), this.request.signal);
    if (!patch.groups || !patch.base || !comment.originalCommit) return patch;
    const file = this.filesByPath.get(comment.path);
    try {
      const [before, after] = await Promise.all([
        this.analysis.readAt(patch.base, file.previous_filename || comment.path),
        this.analysis.readAt(comment.originalCommit, comment.path)
      ]);
      if (before.reason || after.reason) return patch;
      const result = await diffTexts({filename: comment.path, status: 'modified'}, before, after,
        atom.config.get('difftastic.difftPath'), this.request.signal);
      const side = comment.side === 'LEFT' ? 0 : 1;
      const groups = windowSpan(result.groups, patch.range,
        {side, range: [comment.originalLine, comment.originalLine]});
      return groups.length ? {...patch, groups} : patch;
    } catch {
      return patch;
    }
  }

  async changedBlock(comment) {
    const commit = comment.originalCommit;
    if (!commit || commit === this.analysis.head) {
      return {note: 'This comment was written on the current revision, so nothing changed after it.'};
    }
    const [before, after] = await Promise.all([
      this.analysis.readAt(commit, comment.path),
      this.analysis.readAt(this.analysis.head, comment.path)
    ]);
    if (before.reason || after.reason) return {note: before.reason || after.reason};
    const result = await diffTexts({filename: comment.path, status: 'modified'}, before, after,
      atom.config.get('difftastic.difftPath'), this.request.signal);
    if (!result.groups.length) {
      return {note: result.note || 'This file did not change between that revision and the head.'};
    }
    const range = [comment.originalLine, comment.originalLine];
    const covering = windowSpan(result.groups, [range, range], {side: 0, range});
    return {groups: covering.length ? covering : result.groups};
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
    const send = button(`Post to ${this.provider.service}`, 'dpr-button', () => this.edit(draft, detailed ? 'drafts' : 'file', draft));
    send.disabled = !this.isCurrent(draft) || this.postedDrafts.has(draft.id);
    if (send.disabled) send.title = `Reload the ${this.provider.short} to review this draft against the latest patch`;
    actions.append(send, button('Delete', 'dpr-button', () => this.deleteDraft(draft)));
    header.append(actions);
    card.append(header, el('p', 'dpr-draft-body', draft.body));
    return card;
  }

  commentCard(comment) {
    const card = el('article', 'dpr-draft');
    const link = el('a', null, `${comment.user?.login || this.provider.service} ↗`);
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
      message: `Delete this ${this.provider.service} review comment?`,
      buttons: ['Cancel', 'Delete']
    });
    if (response !== 1) return;
    const request = this.request;
    const ref = this.ref;
    this.deletingComments.add(comment.id);
    button.disabled = true;
    try {
      await this.provider.deleteComment(ref, comment.id, atom.config.get(this.provider.setting), request.signal);
      if (request.signal.aborted || ref !== this.ref) return;
      this.comments = this.comments.filter(item => item.id !== comment.id);
      this.showError();
      this.renderContent(true);
    } catch (error) {
      if (!request.signal.aborted && ref === this.ref) {
        this.showError(`Could not delete ${this.provider.service} comment. ${error.message}`);
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
    box.placeholder = `Write a ${this.provider.service} review comment...`;
    box.setAttribute('aria-label', `${this.provider.service} review comment`);
    box.addEventListener('input', () => { composer.body = box.value; });
    const actions = el('div', 'dpr-draft-actions');
    const save = el('button', 'dpr-button dpr-primary', `Post to ${this.provider.service}`);
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
        const comment = await this.provider.postComment(this.ref, this.analysis, composer.anchor, box.value.trim(),
          atom.config.get(this.provider.setting), request.signal);
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
