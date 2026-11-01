// Native PiP and toolbar regression tests: Node 18+ and a current Brave build.
// Uses a temporary profile and local generated video; no npm packages required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  setInterval(() => {
    context.fillStyle = '#456789';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 100);
  document.querySelector('video').srcObject = window.stream;
</script>`;

let browser, browserExited, profile, server, baseURL, extensionId, pageId, sessionId;
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

async function waitFor(expression) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${expression}`);
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

async function actionStatus() {
  const { targetInfos } = await command('Target.getTargets');
  const worker = targetInfos.find(info => info.type === 'service_worker' &&
    info.url === `chrome-extension://${extensionId}/background.js`);
  assert.ok(worker, 'Extension service worker must be running');
  const { sessionId: workerSession } = await command('Target.attachToTarget', {
    targetId: worker.targetId, flatten: true,
  });
  try {
    return await evaluate(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { badge: await chrome.action.getBadgeText({ tabId: tab.id }),
        title: await chrome.action.getTitle({ tabId: tab.id }) };
    })()`, workerSession);
  } finally {
    await command('Target.detachFromTarget', { sessionId: workerSession });
  }
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
const expectError = text => waitFor(`Array.from(document.querySelectorAll('[role=status]')).some(
  node => node.style.display !== 'none' && node.textContent.includes(${JSON.stringify(text)}))`);

before(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url.startsWith('/blocked')) response.setHeader('Permissions-Policy', 'picture-in-picture=()');
    response.end(fixture);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseURL = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(join(tmpdir(), 'brave-pip-test-'));
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

test('toolbar opens, closes, and reopens native PiP without duplicate controls', async () => {
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
  await waitFor('document.querySelector("button").style.display === "block"');
  const point = await evaluate(`(() => {
    const rect = document.querySelector('button').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
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
