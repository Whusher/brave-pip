importScripts('downloads.js');

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  const { autosaveEnabled } = await chrome.storage.local.get({ autosaveEnabled: false });
  chrome.contextMenus.create({ id: 'autosave', title: 'Autosave playback when videos finish',
    type: 'checkbox', checked: autosaveEnabled === true, contexts: ['action'] });
  chrome.contextMenus.create({ id: 'save-playback', title: 'Save captured playback', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'download-original', title: 'Download original video', contexts: ['action'] });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autosaveEnabled) {
    chrome.contextMenus.update('autosave', { checked: changes.autosaveEnabled.newValue === true }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'autosave') {
    await chrome.storage.local.set({ autosaveEnabled: info.checked === true });
    if (info.checked && tab?.id != null) {
      try {
        // Install listeners without opening/closing PiP or restarting playback.
        await chrome.scripting.executeScript({ target: { tabId: tab.id },
          files: ['recorder.js', 'autosave.js', 'content.js'] });
      } catch (error) {
        await chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
        await chrome.action.setTitle({ tabId: tab.id,
          title: `Autosave cannot run on this page: ${error.message || error}` }).catch(() => {});
      }
    }
    return;
  }
  if (tab?.id == null) return;
  const action = info.menuItemId === 'save-playback' ? 'save'
    : info.menuItemId === 'download-original' ? 'original' : null;
  if (!action) return;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'brave-pip-control', action });
    await chrome.action.setBadgeText({ tabId: tab.id, text: result?.ok ? '' : '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: result?.ok
      ? 'Toggle video Picture-in-Picture' : `Save unavailable: ${result?.error || 'Could not save playback.'}` });
  } catch (error) {
    console.warn('BravePiP save menu could not reach the video page:', error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
    await chrome.action.setTitle({ tabId: tab.id, title: 'Open PiP on this tab first, then use the save menu.' }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  let error = '';
  try {
    // Inject directly from the click so Brave carries the user gesture into PiP.
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["recorder.js", "autosave.js", "content.js", "toggle.js"]
    });
    if (!injection?.result?.ok) {
      throw new Error(injection?.result?.error || 'Could not open Picture-in-Picture.');
    }
  } catch (err) {
    error = String(err.message || err);
    console.warn("Floating Video cannot run on this page:", err);
  }

  // Injection can fail on restricted pages, where an in-page message is impossible.
  try {
    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#b3261e' }),
      chrome.action.setBadgeText({ tabId: tab.id, text: error ? '!' : '' }),
      chrome.action.setTitle({
        tabId: tab.id,
        title: error ? `PiP unavailable: ${error}` : 'Toggle video Picture-in-Picture'
      })
    ]);
  } catch (err) {
    console.warn('Floating Video could not update its toolbar status:', err);
  }
});
