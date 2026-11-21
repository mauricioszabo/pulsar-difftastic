'use strict';

const {execFile, spawn} = require('child_process');
const {promisify, TextDecoder} = require('util');
const runFile = promisify(execFile);
const maxBlobBytes = 1024 * 1024;

async function run(binary, args, options = {}) {
  try {
    const {stdout} = await runFile(binary, args, {
      maxBuffer: 24 * 1024 * 1024, timeout: 60000, windowsHide: true, ...options
    });
    return stdout;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error.code === 'ENOENT') {
      throw new Error(`Could not find ${binary}. Check the executable path in package settings.`);
    }
    if (error.killed) throw new Error(`${binary} timed out.`);
    const detail = String(error.stderr || '').trim().slice(0, 800);
    throw new Error(detail || `${binary} failed (${error.code || 'unknown error'}).`);
  }
}

// Send JSON over stdin so comment bodies never appear in process arguments or on disk.
function sendJSON(binary, args, data, {signal, env, service}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {signal, timeout: 60000, windowsHide: true, env});
    let output = '';
    let errorOutput = '';
    let failed = false;
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) { failed = true; child.kill(); }
    });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-4096); });
    child.stdin.on('error', () => {}); // A failed request may close stdin early; 'close' reports the error.
    child.on('error', error => {
      if (error.code === 'ENOENT') reject(new Error(`Could not find ${binary}. Check the executable path in package settings.`));
      else reject(error);
    });
    child.on('close', code => {
      if (signal?.aborted) return reject(new Error(`Request cancelled. Check ${service} before retrying.`));
      if (failed) return reject(new Error(`${service} returned an oversized response. Check ${service} before retrying.`));
      if (code !== 0) return reject(new Error(errorOutput.trim().slice(0, 800) ||
        `${service} CLI failed (${code}). Check ${service} before retrying.`));
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error(`Invalid ${service} response. Check ${service} before retrying.`)); }
    });
    child.stdin.end(JSON.stringify(data));
  });
}

function decodeText(bytes) {
  if (bytes.length > maxBlobBytes) return {reason: 'File exceeds the 1 MiB structural diff limit'};
  if (bytes.includes(0)) return {reason: 'Binary file'};
  try {
    return {bytes, text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)};
  } catch {
    return {reason: 'File is not UTF-8 text'};
  }
}

module.exports = {run, sendJSON, decodeText, maxBlobBytes};
