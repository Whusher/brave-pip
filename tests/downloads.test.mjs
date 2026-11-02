import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../downloads.js', import.meta.url), 'utf8');
const sender = { id: 'brave-pip-test', tab: { id: 7 }, frameId: 0, url: 'https://video.example/watch' };

function worker({ downloadError, items = [] } = {}) {
  let listener;
  const requests = [];
  vm.runInNewContext(source, {
    URL, TextEncoder,
    chrome: {
      runtime: { id: sender.id, onMessage: { addListener(callback) { listener = callback; } } },
      downloads: {
        async download(options) {
          requests.push(options);
          if (downloadError) throw new Error(downloadError);
          return 42;
        },
        async search({ id }) { return items.filter(item => item.id === id); }
      }
    }
  });
  return {
    requests,
    listener,
    send(message, origin = sender) {
      return new Promise(resolve => listener({ type: 'brave-pip-download', ...message }, origin, resolve));
    }
  };
}

const capture = { action: 'start', kind: 'capture', url: 'blob:https://video.example/recording', title: 'My video' };

test('captured downloads stay inside PiPBrave and avoid filename collisions', async () => {
  const instance = worker();
  const result = await instance.send({ ...capture, title: '../../CON:\\evil?*\u202e' });
  assert.equal(result.ok, true);
  assert.equal(result.id, 42);
  const request = instance.requests[0];
  assert.match(request.filename, /^PiPBrave\/[^/\\]+\.webm$/);
  assert.ok(!request.filename.includes('..'));
  assert.ok(!/[<>:"\\|?*\u202e]/.test(request.filename));
  assert.equal(request.saveAs, false);
  assert.equal(request.conflictAction, 'uniquify');
});

test('Unicode and empty titles produce usable filesystem names', async () => {
  const instance = worker();
  await instance.send({ ...capture, title: '🎥'.repeat(1000) });
  assert.ok(Buffer.byteLength(instance.requests[0].filename.split('/')[1]) < 255);
  await instance.send({ ...capture, title: '... / ..' });
  assert.match(instance.requests[1].filename, /^PiPBrave\/video-/);
  await instance.send({ ...capture, title: 'CON.txt' });
  assert.match(instance.requests[2].filename, /^PiPBrave\/_CON\.txt-/);
});

test('direct original URLs can preserve a supplied video extension or omit an unknown one', async () => {
  const instance = worker();
  assert.equal((await instance.send({ action: 'start', kind: 'original', url: 'https://cdn.example/video.webm', title: 'Video', extension: 'webm' })).ok, true);
  assert.match(instance.requests[0].filename, /\.webm$/);
  assert.equal((await instance.send({ action: 'start', kind: 'original', url: 'https://cdn.example/play?id=123', title: 'Video' })).ok, true);
  assert.match(instance.requests[1].filename, /Z$/);
});

test('rejects untrusted contexts, unexpected schemes, foreign buffers, and manifests', async () => {
  const instance = worker();
  for (const origin of [
    { ...sender, id: 'another-extension' },
    { ...sender, tab: undefined },
    { ...sender, tab: { id: -1 } },
    { ...sender, frameId: 1 },
  ]) assert.equal((await instance.send(capture, origin)).ok, false);
  for (const changes of [
    { url: 'blob:https://other.example/recording' },
    { url: 'blob:null/recording' },
    { url: 'https://video.example/recording' },
    { kind: 'original', url: 'file:///tmp/video.mp4' },
    { kind: 'original', url: 'data:video/webm;base64,AAAA' },
    { kind: 'original', url: 'javascript:alert(1)' },
    { kind: 'original', url: 'https://cdn.example/playlist.m3u8?token=abc' },
    { kind: 'original', url: 'https://cdn.example/stream%2Empd' },
    { kind: 'other' },
    { extension: '../mp4' },
    { extension: 'exe' },
  ]) assert.equal((await instance.send({ ...capture, ...changes })).ok, false);
  assert.equal(instance.requests.length, 0);
});

test('browser download failures are reported to the PiP caller', async () => {
  const instance = worker({ downloadError: 'Download blocked by browser' });
  const result = await instance.send(capture);
  assert.equal(result.ok, false);
  assert.match(result.error, /Download blocked by browser/);
});

test('status survives worker restart and exposes only this extension\'s downloads', async () => {
  const items = [
    { id: 42, byExtensionId: sender.id, state: 'complete', filename: '/Downloads/PiPBrave/video.webm' },
    { id: 43, byExtensionId: sender.id, state: 'interrupted', error: 'USER_CANCELED', filename: '/Downloads/PiPBrave/canceled.webm' },
    { id: 44, byExtensionId: 'other-extension', state: 'complete', filename: '/Downloads/private.txt' },
  ];
  const instance = worker({ items });
  const completed = await instance.send({ action: 'status', id: 42 });
  assert.equal(completed.ok, true);
  assert.equal(completed.state, 'complete');
  assert.equal(completed.filename, items[0].filename);
  const interrupted = await instance.send({ action: 'status', id: 43 });
  assert.equal(interrupted.error, 'USER_CANCELED');
  for (const id of [44, 45, -1, '42']) assert.equal((await instance.send({ action: 'status', id })).ok, false);
  assert.equal(instance.requests.length, 0);
});

test('unrelated runtime messages are ignored', () => {
  const instance = worker();
  assert.equal(instance.listener({ type: 'some-other-feature' }, sender, () => assert.fail('Unexpected reply')), false);
});
