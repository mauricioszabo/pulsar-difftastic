'use strict';

const {CompositeDisposable} = require('atom');
const ReviewView = require('./review-view');
const {pullRequestsForEditor} = require('./branch-prs');
const PrPicker = require('./pr-picker');

module.exports = {
  config: {
    ghPath: {type: 'string', default: 'gh', title: 'GitHub CLI executable'},
    difftPath: {type: 'string', default: 'difft', title: 'Difftastic executable'}
  },

  activate() {
    this.subscriptions = new CompositeDisposable(
      atom.workspace.addOpener(uri => {
        if (uri.startsWith(`${ReviewView.uri}/`)) return new ReviewView({uri});
      }),
      atom.commands.add('atom-workspace', {
        'difftastic-pr-review:open': () => this.openReview(),
        'difftastic-pr-review:open-pr-on-current-branch': () => this.openCurrentBranch()
      })
    );
  },

  async openReview(url) {
    try {
      const review = await atom.workspace.open(ReviewView.newURI());
      if (url) review.open(url);
      else review.focusAddress();
    } catch (error) {
      atom.notifications.addError(error.message);
    }
  },

  async openCurrentBranch() {
    try {
      this.picker?.destroy();
      this.picker = null;
      const editor = atom.workspace.getActiveTextEditor();
      const gh = atom.config.get('difftastic-pr-review.ghPath');
      const {branch, prs} = await pullRequestsForEditor(editor, gh);
      if (!prs.length) {
        atom.notifications.addInfo(`No pull requests found for branch ${branch}.`);
      } else if (prs.length === 1) {
        await this.openReview(prs[0].url);
      } else {
        const picker = new PrPicker(prs, branch, pr => this.openReview(pr.url));
        picker.onClose = () => { if (this.picker === picker) this.picker = null; };
        this.picker = picker;
      }
    } catch (error) {
      atom.notifications.addError(error.message);
    }
  },

  deactivate() {
    this.picker?.destroy();
    this.picker = null;
    this.subscriptions?.dispose();
    for (const item of atom.workspace.getPaneItems()) {
      if (item instanceof ReviewView) atom.workspace.paneForItem(item)?.destroyItem(item);
    }
  },

  deserializeReview(state) {
    return new ReviewView(state);
  }
};
