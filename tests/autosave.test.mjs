import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../autosave.js', import.meta.url), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture({ save, stop } = {}) {
  class Video {
    isConnected = true;
    paused = false;
    ended = false;
    readyState = 4;
    videoWidth = 320;
    currentTime = 0;
  }
  const listeners = new Map();
  const recordings = [], saves = [], states = [], notices = [];
  let video = new Video();
  const window = { __bravePiPCreateRecorder(target, update) {
    const item = { video: target, disposed: false, state: { status: 'idle', bytes: 0, elapsedMs: 0 } };
    recordings.push(item);
    Object.assign(item, {
      start() { item.state = { status: 'recording', bytes: 0, elapsedMs: 2000 }; update(item.state); },
      stop() {
        item.signal('manual');
        return stop ? stop(item) : Promise.resolve(new Blob(['test recording']));
      },
      signal(reason) {
        item.state = { status: 'stopping', stopReason: reason, bytes: 100, elapsedMs: 2000 };
        update(item.state);
      },
      dispose() { item.disposed = true; },
      getState() { return item.state; }
    });
    return item;
  } };
  vm.runInNewContext(source, {
    window, HTMLVideoElement: Video, queueMicrotask,
    document: {
      title: 'First video', documentElement: {},
      addEventListener(type, callback) { listeners.set(type, callback); },
      removeEventListener(type) { listeners.delete(type); }
    },
    MutationObserver: class { observe() {} disconnect() {} }
  });
  const controller = window.__bravePiPCreateAutosave({
    getVideo: () => video,
    save: async (blob, title) => { saves.push({ blob, title }); await save?.(blob, title); },
    onState: state => states.push(state), notify: message => notices.push(message)
  });
  return { controller, recordings, saves, states, notices,
    get video() { return video; },
    emit(type, target = video) { listeners.get(type)?.({ target }); },
    nextVideo() { video = new Video(); return video; }
  };
}

test('autosave waits for playback, saves once on ended, and stays off when disabled', async () => {
  const f = fixture();
  f.emit('play');
  assert.equal(f.recordings.length, 0);
  f.video.paused = true;
  f.controller.setEnabled(true);
  assert.equal(f.recordings.length, 0);
  f.video.paused = false;
  f.emit('play'); f.emit('playing');
  assert.equal(f.recordings.length, 1);
  f.video.ended = true;
  f.emit('ended'); f.emit('ended');
  await nextTurn();
  assert.equal(f.saves.length, 1);
  assert.equal(f.recordings[0].disposed, true);
  f.controller.setEnabled(false);
  f.nextVideo(); f.emit('play');
  assert.equal(f.recordings.length, 1);
  f.controller.dispose();
});

test('next video records while the previous download is still pending', async () => {
  const pending = deferred();
  const f = fixture({ save: () => pending.promise });
  f.controller.setEnabled(true);
  f.video.ended = true; f.emit('ended');
  await nextTurn();
  assert.equal(f.saves.length, 1);
  f.nextVideo(); f.emit('play');
  assert.equal(f.recordings.length, 2);
  assert.equal(f.recordings[1].state.status, 'recording');
  assert.equal(f.recordings[0].disposed, false);
  f.video.ended = true; f.emit('ended');
  await nextTurn();
  assert.equal(f.saves.length, 2);
  pending.resolve(); await nextTurn();
  assert.ok(f.recordings.every(item => item.disposed));
  f.controller.dispose();
});

test('recording limits save numbered parts and immediately start the next part', async () => {
  const pending = deferred();
  const f = fixture({ save: () => pending.promise });
  f.controller.setEnabled(true);
  f.recordings[0].signal('limit');
  await nextTurn();
  assert.equal(f.saves[0].title, 'First video-part-1');
  assert.equal(f.recordings.length, 2);
  f.video.ended = true; f.emit('ended');
  await nextTurn();
  assert.equal(f.saves[1].title, 'First video-part-2');
  pending.resolve(); await nextTurn();
  f.controller.dispose();
});

test('disabling cancels pending finalization and allows a fresh enabled session', async () => {
  const pending = deferred();
  const f = fixture({ stop: () => pending.promise });
  f.controller.setEnabled(true);
  f.video.ended = true; f.emit('ended');
  await nextTurn();
  f.controller.setEnabled(false);
  pending.resolve(new Blob(['old recording']));
  f.nextVideo(); f.controller.setEnabled(true);
  await nextTurn();
  assert.equal(f.saves.length, 0);
  assert.equal(f.recordings[0].disposed, true);
  assert.equal(f.recordings[1].disposed, false);
  f.controller.dispose();
});

test('failed downloads can be retried while the next video keeps recording', async () => {
  let fail = true;
  const f = fixture({ save: () => { if (fail) throw new Error('Disk full'); } });
  f.controller.setEnabled(true);
  f.emit('loadstart');
  await nextTurn();
  assert.equal(f.saves[0].title, 'First video-partial');
  assert.equal(f.states.at(-1).retryAvailable, true);
  f.nextVideo(); f.emit('play');
  fail = false;
  assert.equal((await f.controller.saveCurrent()).ok, true);
  assert.equal(f.saves[1].title, 'First video-partial');
  assert.equal(f.recordings.length, 2);
  assert.equal(f.recordings[1].state.status, 'recording');
  f.controller.dispose();
});

test('unreadable captures are discarded instead of filling the retry queue', async () => {
  const f = fixture({ stop: () => Promise.reject(new Error('No frames')) });
  f.controller.setEnabled(true);
  f.emit('loadstart'); await nextTurn();
  assert.equal(f.recordings[0].disposed, true);
  assert.equal(f.states.at(-1).retryAvailable, false);
  assert.equal(f.saves.length, 0);
  f.nextVideo(); f.emit('play');
  assert.equal(f.recordings.length, 2);
  f.controller.dispose();
});
