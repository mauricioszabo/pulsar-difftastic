'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {run} = require('./github');

function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function patchRows(patch) {
  const groups = [];
  let group;
  let left = 0;
  let right = 0;
  let leftRun = [];
  let rightRun = [];
  let last = [];
  function flush() {
    const size = Math.max(leftRun.length, rightRun.length);
    for (let index = 0; index < size; index++) group.rows.push([leftRun[index], rightRun[index]]);
    leftRun = [];
    rightRun = [];
  }

  for (const line of splitLines(patch || '')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (group) flush();
      group = {
        label: line, rows: [],
        starts: [Number(hunk[1]), Number(hunk[3])],
        counts: [Number(hunk[2] ?? 1), Number(hunk[4] ?? 1)]
      };
      groups.push(group);
      [left, right] = group.starts;
      last = [];
      continue;
    }
    if (!group) continue;
    const content = line.slice(1);
    switch (line[0]) {
      case '-':
        last = [{number: left++, text: content, changed: true}];
        leftRun.push(last[0]);
        break;
      case '+':
        last = [{number: right++, text: content, changed: true}];
        rightRun.push(last[0]);
        break;
      case ' ':
        flush();
        last = [{number: left++, text: content}, {number: right++, text: content}];
        group.rows.push(last);
        break;
      case '\\':
        if (content === ' No newline at end of file') last.forEach(cell => { cell.noNewline = true; });
        break;
      default: break;
    }
  }
  if (group) flush();
  return groups.filter(item => item.rows.length);
}

// A complete PR patch can recover GitHub's actual before file, even when the
// current merge base has advanced past the one used to display the PR.
function reversePatch(groups, file, headText) {
  if (!groups.length) return null;
  const head = splitLines(headText);
  const before = [];
  let cursor = 0;
  let additions = 0;
  let removals = 0;
  let tail;
  for (const group of groups) {
    const offsets = group.starts.map((start, side) => group.counts[side] ? start - 1 : start);
    if (offsets[1] < cursor || offsets[1] > head.length) return null;
    while (cursor < offsets[1]) before.push(head[cursor++]);
    if (offsets[0] !== before.length) return null;
    for (const [left, right] of group.rows) {
      if (right) {
        if (right.number !== cursor + 1 || right.text !== head[cursor]) return null;
        cursor++;
        if (cursor === head.length && Boolean(right.noNewline) === headText.endsWith('\n')) return null;
        if (right.changed) additions++;
      }
      if (left) {
        if (left.number !== before.length + 1) return null;
        before.push(left.text);
        if (left.changed) removals++;
        tail = left;
      }
    }
    if (cursor !== offsets[1] + group.counts[1] || before.length !== offsets[0] + group.counts[0]) return null;
  }
  if (additions !== file.additions || removals !== file.deletions) return null;
  while (cursor < head.length) before.push(head[cursor++]);
  if (!before.length) return '';
  const newline = tail?.number === before.length ? !tail.noNewline : headText.endsWith('\n');
  return before.join('\n') + (newline ? '\n' : '');
}

async function diffFile(analysis, file, binary, signal) {
  const right = await analysis.readHead(file);
  if (right.reason && !right.oid) return {groups: [], note: right.reason};
  const patch = patchRows(file.patch);
  const reconstructed = right.reason ? null : reversePatch(patch, file, right.text);
  const before = file.status === 'added' ? '' : reconstructed;
  const left = before !== null ? {text: before, bytes: Buffer.from(before, 'utf8')} : await analysis.readBase(file);
  const limitations = [left, right].filter(side => side.reason);
  if (limitations.length) {
    const commits = [left, right].map(side => side.oid?.slice(0, 12) || '—');
    const note = limitations.some(side => side.oid)
      ? `Submodule commit · ${commits[0]} → ${commits[1]}`
      : [...new Set(limitations.map(side => side.reason))].join(' · ');
    return {groups: [], note};
  }
  if (before === null && patch.length) {
    const lines = [splitLines(left.text), splitLines(right.text)];
    const matches = patch.every(group => group.rows.every(row => row.every((cell, side) =>
      !cell || cell.text === lines[side][cell.number - 1])));
    if (!matches) return {groups: [], note: 'The available snapshots differ from GitHub’s PR patch.'};
  }
  if (signal.aborted) return {groups: []};

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'difftastic-'));
  try {
    const name = path.posix.basename(file.filename);
    const safeName = process.platform === 'win32' && (/[<>:"/\\|?*]|[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
      ? `source${path.posix.extname(name).replace(/[^.\w-]/g, '')}` : name;
    await Promise.all(['before', 'after'].map(side => fs.mkdir(path.join(temp, side))));
    const before = path.join(temp, 'before', safeName);
    const after = path.join(temp, 'after', safeName);
    await Promise.all([fs.writeFile(before, left.bytes), fs.writeFile(after, right.bytes)]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DFT_')));
    let output;
    try {
      output = await run(binary, ['--display', 'json', '--color', 'never', '--tab-width', '1', '--', before, after],
        {signal, env: {...env, DFT_UNSTABLE: 'yes'}});
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Difftastic could not compare this file. ${error.message}`);
    }

    let result;
    try {
      result = JSON.parse(output);
      if (Array.isArray(result)) result = result[0];
      if (!result || typeof result.status !== 'string') throw new Error('Invalid JSON record');
    } catch {
      throw new Error('Unsupported Difftastic JSON output. Use a recent Difftastic release.');
    }
    return structuralRows(result, file, splitLines(left.text), splitLines(right.text));
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
}

function structuralRows(result, file, left, right) {
  const language = result.language || '';
  if (file.status === 'added' || file.status === 'removed') {
    const added = file.status === 'added';
    const rows = (added ? right : left).map((text, index) => {
      const cell = {number: index + 1, text, changed: true};
      return added ? [null, cell] : [cell, null];
    });
    return {language, groups: rows.length ? [{rows}] : [], note: rows.length ? '' : 'Empty file'};
  }
  if (result.status === 'unchanged') {
    return {language, groups: [], note: 'Difftastic found no structural changes.'};
  }
  if (result.status === 'binary' || language.toLowerCase() === 'binary') {
    return {language: '', groups: [], note: 'Difftastic detected a binary file.'};
  }
  if (!Array.isArray(result.chunks) || !Array.isArray(result.aligned_lines)) {
    return {language, groups: [], note: 'Difftastic did not return structural line details for this file.'};
  }

  const changes = [new Map(), new Map()];
  for (const chunk of result.chunks) {
    for (const row of chunk) {
      for (const [side, entry] of [row.lhs, row.rhs].entries()) {
        if (entry?.changes?.length) changes[side].set(entry.line_number, entry.changes);
      }
    }
  }

  const aligned = result.aligned_lines;
  const visible = new Set();
  aligned.forEach(([oldLine, newLine], index) => {
    if (changes[0].has(oldLine) || changes[1].has(newLine)) {
      for (let context = Math.max(0, index - 3); context <= Math.min(index + 3, aligned.length - 1); context++) {
        visible.add(context);
      }
    }
  });

  function cell(side, number) {
    const text = (side === 0 ? left : right)[number];
    if (!Number.isInteger(number) || text === undefined) return null;
    const spans = changes[side].get(number);
    return {number: number + 1, text, changed: Boolean(spans), spans};
  }

  const groups = [];
  let group;
  let previous;
  let previousIndex;
  aligned.forEach(([oldLine, newLine], index) => {
    if (!visible.has(index)) return;
    const row = [cell(0, oldLine), cell(1, newLine)];
    if (!row.some(Boolean)) return;
    const skippedLines = previous && row.some((current, side) =>
      current && previous[side] && current.number > previous[side].number + 1);
    if (!group || index !== previousIndex + 1 || skippedLines) {
      group = {rows: []};
      groups.push(group);
    }
    group.rows.push(row);
    previous = row;
    previousIndex = index;
  });
  return {language, groups, note: groups.length ? '' : 'Difftastic returned no renderable changes.'};
}

function segments(text, spans = []) {
  if (!spans.length) return [{text}];
  const bytes = Buffer.from(text, 'utf8');
  const pieces = [];
  let cursor = 0;
  for (const {start, end, content} of [...spans].sort((left, right) => left.start - right.start)) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor ||
        end <= start || end > bytes.length) continue;
    const changed = bytes.toString('utf8', start, end);
    if (changed !== content && changed.replace(/\t/g, ' ') !== content) continue;
    if (cursor < start) pieces.push({text: bytes.toString('utf8', cursor, start)});
    pieces.push({text: changed, changed: true});
    cursor = end;
  }
  if (cursor < bytes.length) pieces.push({text: bytes.toString('utf8', cursor)});
  return pieces;
}

module.exports = {diffFile, patchRows, segments};
