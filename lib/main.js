'use strict';

const {CompositeDisposable} = require('atom');
const ReviewView = require('./review-view');
const {pullRequestsForEditor} = require('./branch-prs');
const PrPicker = require('./pr-picker');
const providers = require('./providers');

module.exports = {
  activate() {
    this.subscriptions = new CompositeDisposable(
      atom.workspace.addOpener(uri => {
        if (!uri.startsWith(`${ReviewView.uri}/`)) return;
        const provider = Object.keys(providers).find(name => uri.startsWith(`${ReviewView.uri}/${name}/`));
        return new ReviewView({uri, provider});
      }),
      atom.commands.add('atom-workspace', {
        'difftastic:open-pull-request': () => this.openReview('github'),
        'difftastic:open-current-branch-pull-request': () => this.openCurrentBranch('github'),
        'difftastic:open-merge-request': () => this.openReview('gitlab'),
        'difftastic:open-current-branch-merge-request': () => this.openCurrentBranch('gitlab')
      })
    );
  },

  async openReview(provider, url) {
    try {
      const review = await atom.workspace.open(ReviewView.newURI(provider));
      if (url) review.open(url);
      else review.focusAddress();
    } catch (error) {
      atom.notifications.addError(error.message);
    }
  },

  async openCurrentBranch(name) {
    try {
      this.picker?.destroy();
      this.picker = null;
      const provider = providers[name];
      const editor = atom.workspace.getActiveTextEditor();
      const binary = atom.config.get(provider.setting);
      const {branch, prs} = await pullRequestsForEditor(editor, (root, branch) => provider.listForBranch(root, branch, binary));
      if (!prs.length) {
        atom.notifications.addInfo(`No ${provider.item}s found for branch ${branch}.`);
      } else if (prs.length === 1) {
        await this.openReview(name, prs[0].url);
      } else {
        const picker = new PrPicker(prs, branch, provider, pr => this.openReview(name, pr.url));
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
