'use strict';

const SelectListView = require('atom-select-list');

class PrPicker {
  constructor(prs, branch, provider, onSelect) {
    this.onClose = null;
    this.list = new SelectListView({
      items: prs,
      filterKeyForItem: pr => `${provider.symbol}${pr.number} ${pr.title} ${pr.url} ${pr.state}`,
      elementForItem: pr => {
        const item = document.createElement('li');
        item.className = 'two-lines';
        const title = document.createElement('div');
        title.className = 'primary-line';
        title.textContent = `${provider.symbol}${pr.number} ${pr.title}`;
        const detail = document.createElement('div');
        detail.className = 'secondary-line';
        detail.textContent = `${pr.state}${pr.isDraft ? ' · Draft' : ''} · ${pr.url}`;
        item.append(title, detail);
        return item;
      },
      didConfirmSelection: pr => {
        this.destroy();
        onSelect(pr);
      },
      didCancelSelection: () => this.destroy(),
      emptyMessage: `No matching ${provider.item}s on ${branch}`
    });
    this.panel = atom.workspace.addModalPanel({item: this.list.element});
    this.list.focus();
  }

  destroy() {
    if (!this.panel) return;
    const panel = this.panel;
    this.panel = null;
    panel.destroy();
    this.list.destroy();
    this.onClose?.();
  }
}

module.exports = PrPicker;
