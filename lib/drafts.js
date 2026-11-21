'use strict';

const fs = require('fs').promises;
const path = require('path');
const {createHash, randomUUID} = require('crypto');

const idPattern = /^[0-9a-f-]{36}$/;

class Drafts {
  constructor(configDirectory, key) {
    const digest = createHash('sha256').update(key).digest('hex');
    this.directory = path.join(configDirectory, 'difftastic', 'drafts', digest);
  }

  async list() {
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const drafts = await Promise.all(names.map(async name => {
      if (!name.endsWith('.json') || !idPattern.test(name.slice(0, -5))) return null;
      try {
        const draft = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
        if (draft.id + '.json' !== name || typeof draft.body !== 'string') return null;
        return draft;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }));
    return drafts.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async save(anchor, body, existing) {
    const now = new Date().toISOString();
    const draft = {
      ...anchor, id: existing ? existing.id : randomUUID(), body,
      createdAt: existing ? existing.createdAt : now, updatedAt: now
    };
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const destination = path.join(this.directory, draft.id + '.json');
    const temp = path.join(this.directory, randomUUID() + '.tmp');
    try {
      await fs.writeFile(temp, JSON.stringify(draft) + '\n', {flag: 'wx', mode: 0o600});
      await fs.rename(temp, destination);
    } finally {
      await fs.rm(temp, {force: true});
    }
    return draft;
  }

  async remove(draft) {
    if (!idPattern.test(draft.id)) throw new Error('Invalid draft ID.');
    await fs.rm(path.join(this.directory, draft.id + '.json'), {force: true});
  }
}

module.exports = Drafts;
