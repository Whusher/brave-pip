chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  let error = '';
  try {
    // Inject directly from the click so Brave carries the user gesture into PiP.
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
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
