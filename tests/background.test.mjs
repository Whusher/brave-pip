import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
function fixture(initial) {
  const handlers = {}, menus = [], injections = [], updates = [];
  const storage = initial === undefined ? {} : { autosaveEnabled: initial };
  const listen = name => ({ addListener(callback) { handlers[name] = callback; } });
  vm.runInNewContext(source, { importScripts() {}, console, chrome: {
    runtime: { onInstalled: listen('install') },
    storage: { onChanged: listen('change'), local: {
      async get(defaults) { return { ...defaults, ...storage }; },
      async set(settings) {
        Object.assign(storage, settings);
        handlers.change({ autosaveEnabled: { newValue: settings.autosaveEnabled } }, 'local');
      }
    } },
    contextMenus: {
      onClicked: listen('menu'), async removeAll() { menus.length = 0; },
      create(menu) { menus.push(menu); }, async update(id, values) { updates.push({ id, ...values }); }
    },
    scripting: { async executeScript(options) { injections.push(options); return [{ result: { ok: true } }]; } },
    action: { onClicked: listen('toolbar'), async setBadgeText() {}, async setTitle() {}, async setBadgeBackgroundColor() {} }
  } });
  return { handlers, menus, injections, updates, storage };
}

test('autosave defaults off and extension updates preserve the saved checkbox preference', async () => {
  for (const initial of [undefined, true, false]) {
    const f = fixture(initial);
    await f.handlers.install();
    assert.equal(f.menus.find(menu => menu.id === 'autosave').checked, initial === true);
    assert.equal(f.menus.find(menu => menu.id === 'autosave').type, 'checkbox');
    assert.equal(f.storage.autosaveEnabled, initial);
  }
});

test('enabling autosave persists the setting and installs without toggling PiP', async () => {
  const f = fixture();
  await f.handlers.menu({ menuItemId: 'autosave', checked: true }, { id: 7 });
  assert.equal(f.storage.autosaveEnabled, true);
  assert.equal(f.injections[0].target.tabId, 7);
  assert.ok(f.injections[0].files.includes('autosave.js'));
  assert.ok(!f.injections[0].files.includes('toggle.js'));
  assert.equal(f.updates.at(-1).checked, true);
  await f.handlers.menu({ menuItemId: 'autosave', checked: false });
  assert.equal(f.storage.autosaveEnabled, false);
  assert.equal(f.injections.length, 1);
});

test('the toolbar still injects the native PiP toggle', async () => {
  const f = fixture(true);
  await f.handlers.toolbar({ id: 7 });
  assert.equal(f.injections[0].files.at(-1), 'toggle.js');
});
