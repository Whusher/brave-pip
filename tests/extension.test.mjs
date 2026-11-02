// PiP, recording, and download regressions: Node 18+ and a current Brave build.
// Uses a temporary profile and local generated video; no npm packages required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, before, beforeEach, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = `<!doctype html><title>PiP regression fixture</title>
<style>
  body { margin: 20px; }
  #player { position: relative; width: 640px; height: 360px; }
  #main { width: 100%; height: 100%; }
  #overlay { position: absolute; inset: 0; }
</style>
<div id="player"><video id="main" muted autoplay></video><div id="overlay"></div></div>
<script>
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d');
  window.stream = canvas.captureStream(10);
  let frame = 0;
  setInterval(() => {
    context.fillStyle = 'hsl(' + ((frame++ * 25) % 360) + ', 80%, 50%)';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 100);
  document.querySelector('video').srcObject = window.stream;
</script>`;

let browser, browserExited, profile, downloadsDirectory, server, baseURL, extensionId, pageId, sessionId;
let sampleVideo;
let nextId = 0;
const pending = new Map();

function command(method, params = {}, targetSession) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 10000);
    pending.set(id, response => {
      clearTimeout(timeout);
      if (response.error) reject(new Error(`${method}: ${response.error.message}`));
      else resolve(response.result);
    });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId: targetSession }) + '\0');
  });
}

async function evaluate(expression, targetSession = sessionId) {
  const response = await command('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, targetSession);
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

async function waitUntil(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const waitFor = (expression, targetSession = sessionId) =>
  waitUntil(() => evaluate(expression, targetSession), expression);

async function clickElement(selector, targetSession = sessionId) {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, targetSession);
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`, targetSession);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, targetSession);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, targetSession);
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, targetSession);
}

async function clickToolbar() {
  const { targetInfos } = await command('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const url = await evaluate('location.href');
  const tab = targetInfos.find(info => info.url === url);
  assert.ok(tab, 'The fixture must have a browser tab target');
  // Browser-level invocation supplies the actual activeTab grant and user gesture.
  await command('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
}

async function workerEvaluate(expression) {
  const { targetInfos } = await command('Target.getTargets');
  const worker = targetInfos.find(info => info.type === 'service_worker' &&
    info.url === `chrome-extension://${extensionId}/background.js`);
  assert.ok(worker, 'Extension service worker must be running');
  const { sessionId: workerSession } = await command('Target.attachToTarget', {
    targetId: worker.targetId, flatten: true,
  });
  try {
    return await evaluate(expression, workerSession);
  } finally {
    await command('Target.detachFromTarget', { sessionId: workerSession });
  }
}

async function actionStatus() {
  const url = await evaluate('location.href');
  return workerEvaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(candidate => candidate.url === ${JSON.stringify(url)}) ||
        tabs.find(candidate => candidate.active);
      return { badge: await chrome.action.getBadgeText({ tabId: tab.id }),
        title: await chrome.action.getTitle({ tabId: tab.id }) };
    })()`);
}

async function expectBadge(badge) {
  for (let i = 0; i < 50; i++) {
    const status = await actionStatus();
    if (status.badge === badge) return status;
    await delay(50);
  }
  assert.fail(`Toolbar badge did not become ${JSON.stringify(badge)}`);
}

const expectPiP = id => waitFor(`document.pictureInPictureElement?.id === ${JSON.stringify(id)}`);
const expectClosed = () => waitFor('document.pictureInPictureElement === null');
const waitForCapture = () => waitFor(`document.querySelector('#brave-pip-save').dataset.captureState === 'recording' && !document.querySelector('#brave-pip-save').disabled`);
const expectError = text => waitFor(`Array.from(document.querySelectorAll('[role=status]')).some(
  node => node.style.display !== 'none' && node.textContent.includes(${JSON.stringify(text)}))`);

async function extensionDownloads() {
  return workerEvaluate(`chrome.downloads.search({}).then(items =>
    items.filter(item => item.byExtensionId === ${JSON.stringify(extensionId)}))`);
}

async function savePlayback() {
  const previousIds = new Set((await extensionDownloads()).map(item => item.id));
  await clickElement('#brave-pip-save');
  return waitUntil(async () => {
    const download = (await extensionDownloads()).find(item => !previousIds.has(item.id));
    if (download?.state === 'interrupted') assert.fail(`Download interrupted: ${download.error}`);
    return download?.state === 'complete' && download;
  }, 'a completed extension download');
}

async function control(action) {
  const url = await evaluate('location.href');
  return workerEvaluate(`(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.url === ${JSON.stringify(url)});
    return chrome.tabs.sendMessage(tab.id, { type: 'brave-pip-control', action: ${JSON.stringify(action)} });
  })()`);
}

async function downloadOriginal() {
  const previous = new Set((await extensionDownloads()).map(item => item.id));
  const result = await control('original');
  assert.equal(result.ok, true, result.error);
  return (await extensionDownloads()).find(item => !previous.has(item.id));
}

async function downloadedVideo(download, minimumDuration = 0) {
  assert.equal(dirname(download.filename), join(downloadsDirectory, 'PiPBrave'));
  assert.ok(!relative(downloadsDirectory, download.filename).startsWith('..'));
  assert.match(basename(download.filename), /\.webm$/i);
  const bytes = await readFile(download.filename);
  assert.ok(bytes.length > 64, 'The recording must contain video data');
  assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'The download must be a WebM container');
  const dataUrl = `data:video/webm;base64,${bytes.toString('base64')}`;
  const metadata = await evaluate(`new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    const timeout = setTimeout(() => finish(new Error('Saved video did not finish playback')), 8000);
    function finish(error) {
      clearTimeout(timeout);
      const result = { width: video.videoWidth, height: video.videoHeight, duration: video.duration,
        frames: video.getVideoPlaybackQuality().totalVideoFrames };
      video.pause(); video.remove();
      if (error) reject(error); else resolve(result);
    }
    video.onerror = () => finish(new Error('Saved video could not be decoded: ' + video.error?.message));
    video.onloadeddata = () => {
      video.onloadeddata = null;
      if (!Number.isFinite(video.duration) || video.duration <= 0) return finish(new Error('Recording lacks finalized duration'));
      video.onseeked = () => {
        video.onseeked = null;
        video.currentTime = 0;
        video.onended = () => finish();
        video.play().catch(finish);
      };
      video.currentTime = video.duration * 0.6;
    };
    video.src = ${JSON.stringify(dataUrl)};
    video.style.cssText = 'position:fixed;width:8px;height:8px;bottom:0;left:0';
    document.body.append(video);
  })`);
  assert.ok(metadata.width > 0 && metadata.height > 0 && Number.isFinite(metadata.duration),
    'The saved file must contain finalized video metadata');
  assert.ok(metadata.frames > 1, 'The saved file must decode multiple frames and play to the end after seeking');
  assert.ok(metadata.duration >= minimumDuration, `Expected at least ${minimumDuration}s, got ${metadata.duration}s`);
  return bytes;
}

async function setAutosave(enabled) {
  await workerEvaluate(`chrome.storage.local.set({ autosaveEnabled: ${enabled} })`);
  if (await evaluate('!!document.querySelector("#brave-pip-save")')) {
    await waitFor(`document.querySelector('#brave-pip-save').dataset.autosaveEnabled === '${enabled}'`);
  }
}

async function prepareAutosave() {
  await useOriginalFile();
  await evaluate(`(() => {
    const video = document.querySelector('#main');
    video.pause(); video.loop = false; video.currentTime = 0;
  })()`);
  await waitFor('!document.querySelector("#main").seeking');
  await setAutosave(true);
  await clickToolbar();
  await expectPiP('main');
  await waitFor(`document.querySelector('#brave-pip-save').dataset.autosaveEnabled === 'true'`);
  return new Set((await extensionDownloads()).map(item => item.id));
}

async function completedAutosaves(previous, count) {
  return waitUntil(async () => {
    const files = (await extensionDownloads()).filter(item => !previous.has(item.id));
    for (const item of files) assert.notEqual(item.state, 'interrupted', item.error);
    return files.length >= count && files.every(item => item.state === 'complete') && files;
  }, `${count} automatically saved videos`);
}

async function makeSampleVideo() {
  if (sampleVideo) return;
  const base64 = await evaluate(`new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(window.stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = event => reject(event.error);
    recorder.onstop = () => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 1000);
  })`);
  sampleVideo = Buffer.from(base64, 'base64');
}

async function useOriginalFile(kind = 'http') {
  await makeSampleVideo();
  await evaluate(`(async () => {
    const video = document.querySelector('#main');
    video.srcObject = null;
    video.loop = true;
    const fileURL = ${JSON.stringify(baseURL + '/sample.webm')};
    if (${JSON.stringify(kind)} === 'blob') {
      video.src = URL.createObjectURL(await (await fetch(fileURL)).blob());
    } else if (${JSON.stringify(kind)} === 'mse') {
      const mediaSource = new MediaSource();
      video.src = URL.createObjectURL(mediaSource);
      await new Promise(resolve => mediaSource.addEventListener('sourceopen', resolve, { once: true }));
      const buffer = mediaSource.addSourceBuffer('video/webm;codecs=vp8');
      const finished = new Promise((resolve, reject) => {
        buffer.addEventListener('updateend', resolve, { once: true });
        buffer.addEventListener('error', () => reject(new Error('Could not create MSE test media')), { once: true });
      });
      buffer.appendBuffer(await (await fetch(fileURL)).arrayBuffer());
      await finished;
      mediaSource.endOfStream();
    } else if (${JSON.stringify(kind)} === 'cross-origin') {
      video.src = fileURL.replace('127.0.0.1', 'localhost');
    } else {
      video.src = fileURL;
    }
    await video.play();
  })()`);
  await waitFor('document.querySelector("#main").readyState >= 2');
}

before(async () => {
  server = createServer((request, response) => {
    if (request.url.startsWith('/sample.webm') && sampleVideo) {
      response.setHeader('Content-Type', 'video/webm');
      response.setHeader('Content-Length', sampleVideo.length);
      response.end(sampleVideo);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (request.url.startsWith('/blocked')) response.setHeader('Permissions-Policy', 'picture-in-picture=()');
    response.end(fixture);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseURL = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(join(tmpdir(), 'brave-pip-test-'));
  downloadsDirectory = join(profile, 'Downloads');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await mkdir(downloadsDirectory);
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadsDirectory, prompt_for_download: false, directory_upgrade: true },
  }));
  browser = spawn(process.env.BRAVE_BINARY || '/usr/bin/brave-browser', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--enable-unsafe-extension-debugging',
    '--remote-debugging-pipe', '--window-size=1280,900', `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  browserExited = once(browser, 'exit');
  browser.stdio[4].setEncoding('utf8');
  let buffer = '';
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  console.log('Browser:', (await command('Browser.getVersion')).product);
  extensionId = (await command('Extensions.loadUnpacked', { path: root })).id;
});

beforeEach(async () => {
  pageId = (await command('Target.createTarget', { url: `${baseURL}/?test=${Date.now()}` })).targetId;
  sessionId = (await command('Target.attachToTarget', { targetId: pageId, flatten: true })).sessionId;
  await waitFor('document.querySelector("video")?.readyState >= 2');
});

afterEach(async () => {
  await workerEvaluate('chrome.storage.local.set({ autosaveEnabled: false })');
  if (pageId) await command('Target.closeTarget', { targetId: pageId });
});

after(async () => {
  if (browser) {
    await command('Browser.close');
    await browserExited;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('toolbar opens, closes, and reopens PiP without duplicate controls', async () => {
  for (let i = 0; i < 2; i++) {
    await clickToolbar();
    await expectPiP('main');
    await clickToolbar();
    await expectClosed();
  }
  assert.equal(await evaluate(`document.querySelectorAll('button[aria-label="Float this video"]').length`), 1);
});

test('hover button works above a player overlay', async () => {
  await clickToolbar();
  await expectPiP('main');
  await clickToolbar();
  await expectClosed();
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 200 }, sessionId);
  await waitFor(`document.querySelector('button[aria-label="Float this video"]').style.display === 'block'`);
  await clickElement('button[aria-label="Float this video"]');
  await expectPiP('main');
});

test('selects loaded playing video over larger paused or unloaded videos', async () => {
  await evaluate(`(() => {
    const playing = document.createElement('video');
    playing.id = 'playing'; playing.muted = true; playing.autoplay = true;
    playing.style.cssText = 'width:200px;height:120px';
    playing.srcObject = window.stream;
    document.body.append(playing);
    document.querySelector('#main').pause();
    const unloaded = document.createElement('video');
    unloaded.style.cssText = 'width:1000px;height:600px';
    document.body.append(unloaded);
    return playing.play();
  })()`);
  await waitFor('document.querySelector("#playing").readyState >= 2 && !document.querySelector("#playing").paused');
  await clickToolbar();
  await expectPiP('playing');
});

test('no-video error recovers when video is added to the page', async () => {
  await evaluate('window.savedVideo = document.querySelector("video"); savedVideo.remove()');
  await clickToolbar();
  await expectError('No video found');
  assert.match((await expectBadge('!')).title, /No video found/);
  await evaluate('document.querySelector("#player").prepend(savedVideo)');
  await clickToolbar();
  await expectPiP('main');
  await waitFor('document.querySelector("[role=status]").style.display === "none"');
  assert.equal((await expectBadge('')).title, 'Toggle video Picture-in-Picture');
});

test('unloaded video explains that playback is required', async () => {
  await evaluate('document.querySelector("video").srcObject = null');
  await waitFor('document.querySelector("video").readyState === 0');
  await clickToolbar();
  await expectError('Start playing the video');
});

test('player restriction is reported', async () => {
  await evaluate('document.querySelector("video").disablePictureInPicture = true');
  await clickToolbar();
  await expectError('This player does not allow');
  await expectClosed();
});

test('permissions policy failure is reported', async () => {
  await command('Page.navigate', { url: `${baseURL}/blocked` }, sessionId);
  await waitFor('document.querySelector("video")?.readyState >= 2 && !document.pictureInPictureEnabled');
  await clickToolbar();
  await expectError('disabled by this browser or page');
});

test('restricted browser pages report injection failure in the toolbar', async () => {
  await command('Page.navigate', { url: 'chrome://version/' }, sessionId);
  await waitFor('location.protocol !== "http:"');
  await clickToolbar();
  assert.match((await expectBadge('!')).title, /PiP unavailable:.*(?:access|inject)/i);
});

test('native PiP does not move the video or add controls to a document window', async () => {
  await evaluate(`window.originalVideo = document.querySelector('#main');
    window.originalParent = originalVideo.parentNode;
    window.originalSibling = originalVideo.nextSibling;
    window.originalAttributes = JSON.stringify(Array.from(originalVideo.attributes, attr => [attr.name, attr.value]));`);
  await clickToolbar();
  await expectPiP('main');
  assert.equal(await evaluate('document.querySelector("#main") === originalVideo && originalVideo.parentNode === originalParent && originalVideo.nextSibling === originalSibling'), true);
  assert.equal(await evaluate('JSON.stringify(Array.from(originalVideo.attributes, attr => [attr.name, attr.value])) === originalAttributes'), true);
  assert.equal(await evaluate('!!documentPictureInPicture.window'), false);
  assert.equal(await evaluate('!!document.querySelector("#brave-pip-save-mode")'), false);
  await clickToolbar();
  await expectClosed();
  assert.equal(await evaluate('window.stream.getTracks().every(track => track.readyState === "live")'), true);
});

test('one-click Save creates seekable playback and automatically begins the next capture', async () => {
  await evaluate(`document.title = '../outside\\\\folder:<video>|?*'`);
  await clickToolbar();
  await expectPiP('main');
  await waitForCapture();
  const saved = await savePlayback();
  await downloadedVideo(saved);
  assert.doesNotMatch(basename(saved.filename), /[<>:"\\|?*]/);
  await expectPiP('main');
  await waitForCapture();
  const next = await savePlayback();
  assert.notEqual(next.filename, saved.filename);
  await downloadedVideo(next);
  assert.equal(await evaluate('window.stream.getTracks().every(track => track.readyState === "live")'), true);
});

test('closing PiP retains finalized playback for one-click saving afterwards', async () => {
  await clickToolbar();
  await expectPiP('main');
  await waitForCapture();
  await clickToolbar();
  await expectClosed();
  await waitFor(`document.querySelector('#brave-pip-save').dataset.captureState === 'stopped'`);
  await downloadedVideo(await savePlayback());
  await waitFor(`document.querySelector('#brave-pip-save').style.display === 'none'`);
  assert.equal(await evaluate('window.stream.getTracks().every(track => track.readyState === "live")'), true);
});

test('separate save menu downloads the original HTTP video without re-encoding', async () => {
  await useOriginalFile();
  await clickToolbar();
  await expectPiP('main');
  assert.deepEqual(await downloadedVideo(await downloadOriginal()), sampleVideo);
  await expectPiP('main');
});

test('playback captured from an HTTP video file is seekable and plays to the end', async () => {
  await useOriginalFile();
  await clickToolbar();
  await expectPiP('main');
  await waitForCapture();
  await downloadedVideo(await savePlayback());
  await expectPiP('main');
  assert.equal(await evaluate('!document.querySelector("#main").paused'), true);
});

test('captured playback preserves audio and never stops the source audio track', async () => {
  const setup = await command('Runtime.evaluate', {
    userGesture: true, awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      window.fixtureAudio = new AudioContext();
      const output = fixtureAudio.createMediaStreamDestination();
      const tone = fixtureAudio.createOscillator();
      tone.frequency.value = 440;
      tone.connect(output); tone.start();
      window.fixtureAudioTrack = output.stream.getAudioTracks()[0];
      window.stream.addTrack(fixtureAudioTrack);
      const video = document.querySelector('#main');
      video.srcObject = null; video.srcObject = window.stream;
      await fixtureAudio.resume(); await video.play();
    })()`,
  }, sessionId);
  assert.equal(setup.exceptionDetails, undefined, JSON.stringify(setup.exceptionDetails));
  await waitFor('document.querySelector("#main").readyState >= 2');
  await clickToolbar();
  await expectPiP('main');
  await waitForCapture();
  const bytes = await downloadedVideo(await savePlayback());
  const dataUrl = `data:video/webm;base64,${bytes.toString('base64')}`;
  const audioTracks = await evaluate(`(async () => {
    const video = document.createElement('video'); video.muted = true;
    const loaded = new Promise((resolve, reject) => {
      video.onloadeddata = resolve; video.onerror = () => reject(new Error('Audio/video decode failed'));
    });
    video.src = ${JSON.stringify(dataUrl)}; document.body.append(video);
    await loaded; await video.play();
    const output = video.captureStream(); const count = output.getAudioTracks().length;
    for (const track of output.getTracks()) track.stop();
    video.pause(); video.remove(); return count;
  })()`);
  assert.equal(audioTracks, 1);
  assert.equal(await evaluate('fixtureAudioTrack.readyState'), 'live');
  await clickToolbar();
  await expectClosed();
  assert.equal(await evaluate('fixtureAudioTrack.readyState'), 'live');
});

test('separate menu downloads an original Blob file', async () => {
  await useOriginalFile('blob');
  await clickToolbar();
  await expectPiP('main');
  assert.deepEqual(await downloadedVideo(await downloadOriginal()), sampleVideo);
});

test('MediaSource download failure leaves native PiP playing', async () => {
  await useOriginalFile('mse');
  await clickToolbar();
  await expectPiP('main');
  const before = (await extensionDownloads()).map(item => item.id);
  const result = await control('original');
  assert.equal(result.ok, false);
  assert.match(result.error, /does not expose/);
  assert.deepEqual((await extensionDownloads()).map(item => item.id), before);
  await expectPiP('main');
});

test('source navigation closes native PiP', async () => {
  await clickToolbar();
  await expectPiP('main');
  await command('Page.navigate', { url: `${baseURL}/?navigated` }, sessionId);
  await waitFor('document.querySelector("video")?.readyState >= 2');
  await expectClosed();
});

test('capture restrictions never prevent native PiP playback', async () => {
  await useOriginalFile('cross-origin');
  await clickToolbar();
  await expectPiP('main');
  await waitFor(`document.querySelector('#brave-pip-save').dataset.captureState === 'error'`);
  assert.equal(await evaluate('document.querySelector("#brave-pip-save").disabled'), true);
  assert.equal(await evaluate('!document.querySelector("#main").paused'), true);
  assert.match(await evaluate('document.querySelector("#brave-pip-save").title'), /cross-origin|record/i);
});

test('autosave captures from the beginning through ended even after PiP closes', async () => {
  const previous = await prepareAutosave();
  await evaluate('document.querySelector("#main").play()');
  await waitFor(`document.querySelector('#brave-pip-save').dataset.captureState === 'recording'`);
  await clickToolbar();
  await expectClosed();
  const files = await completedAutosaves(previous, 1);
  assert.equal(files.length, 1);
  assert.equal(await evaluate('document.querySelector("#main").ended'), true);
  const duration = await evaluate('document.querySelector("#main").duration');
  await downloadedVideo(files[0], duration * 0.8);
  // A decoder preview must not become another autosave target.
  assert.equal((await extensionDownloads()).filter(item => !previous.has(item.id)).length, 1);
});

test('consecutive videos each save automatically without another PiP click', async () => {
  const previous = await prepareAutosave();
  await evaluate(`(() => {
    const video = document.querySelector('#main');
    document.title = 'Playlist first';
    video.addEventListener('ended', () => {
      document.title = 'Playlist second';
      video.src = '/sample.webm?next';
      void video.play();
    }, { once: true });
    return video.play();
  })()`);
  const files = await completedAutosaves(previous, 2);
  assert.equal(files.length, 2);
  assert.ok(files.some(item => basename(item.filename).startsWith('Playlist first-')));
  assert.ok(files.some(item => basename(item.filename).startsWith('Playlist second-')));
  const duration = await evaluate('document.querySelector("#main").duration');
  for (const file of files) await downloadedVideo(file, duration * 0.8);
});

test('disabling autosave mid-video prevents the automatic download and preserves PiP', async () => {
  const previous = await prepareAutosave();
  await evaluate('document.querySelector("#main").play()');
  await waitFor(`document.querySelector('#brave-pip-save').dataset.captureState === 'recording'`);
  await setAutosave(false);
  await expectPiP('main');
  await waitFor('document.querySelector("#main").ended');
  await waitFor(`['stopped', 'error'].includes(document.querySelector('#brave-pip-save').dataset.captureState)`);
  assert.equal((await extensionDownloads()).filter(item => !previous.has(item.id)).length, 0);
});

test('autosave preference survives navigation and is read when the extension is activated again', async () => {
  await prepareAutosave();
  await command('Page.navigate', { url: `${baseURL}/?autosave-navigation` }, sessionId);
  await waitFor('document.querySelector("#main")?.readyState >= 2');
  assert.equal(await workerEvaluate('chrome.storage.local.get("autosaveEnabled").then(settings => settings.autosaveEnabled)'), true);
  assert.equal(await evaluate('!!document.querySelector("#brave-pip-save")'), false);
  await clickToolbar();
  await expectPiP('main');
  await waitFor(`document.querySelector('#brave-pip-save').dataset.autosaveEnabled === 'true' && document.querySelector('#brave-pip-save').dataset.captureState === 'recording'`);
});
