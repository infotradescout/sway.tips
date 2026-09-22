import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { newNativePlayerJournal, validateNativePlayerJournal } from './native-player-session.mjs';

// One process owns each journal. A crash-left lock is fail-closed: never delete
// it merely because it is old. Recovery requires verifying its process exited.
export function openNativePlayerStore({ filename, actorId }) {
  if (!path.isAbsolute(filename)) throw new Error('Player journal requires an absolute path.');
  const directory = path.dirname(filename);
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Player journal directory must be local and not a symlink.');
  if (process.platform !== 'win32' && (parent.uid !== process.getuid() || (parent.mode & 0o022))) {
    throw new Error('Player journal directory must be owned by this user and not writable by others.');
  }
  const lockPath = filename + '.lock';
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  const identity = fs.fstatSync(lock);
  let closed = false;
  const release = () => {
    if (closed) return; closed = true;
    try {
      const actual = fs.lstatSync(lockPath);
      if (actual.ino !== identity.ino || actual.dev !== identity.dev) throw new Error('Player lock ownership changed.');
      fs.unlinkSync(lockPath);
    } finally { fs.closeSync(lock); }
  };
  let journal;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); fs.fsyncSync(lock);
    let descriptor;
    try { descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (descriptor !== undefined) {
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024
          || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
          throw new Error('Player journal must be a private, bounded regular file.');
        }
        journal = validateNativePlayerJournal(JSON.parse(fs.readFileSync(descriptor, 'utf8')), actorId);
      } finally { fs.closeSync(descriptor); }
    } else journal = newNativePlayerJournal(actorId);
  } catch (error) { release(); throw error; }
  const persist = () => {
    if (closed) throw new Error('Player journal is closed.');
    const temporary = filename + '.' + randomUUID() + '.tmp';
    let descriptor;
    try {
      validateNativePlayerJournal(journal, actorId);
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(journal)); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, filename);
      if (process.platform !== 'win32') {
        const dir = fs.openSync(directory, fs.constants.O_RDONLY);
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  return { journal, persist, close: release };
}
