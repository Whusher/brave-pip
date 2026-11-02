// Download filenames are relative to Brave's configured downloads directory.
// Keep this module in the extension worker, where the downloads API is available.
(() => {
  const extensions = new Set(['webm', 'mp4', 'm4v', 'mov', 'ogv', 'ogg', 'mkv']);

  function authorize(sender) {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
        sender.tab.id < 0 || sender.frameId !== 0) {
      throw new Error('Only this extension in the active page can request video downloads.');
    }
  }

  function mediaURL(message, sender) {
    if (typeof message.url !== 'string') throw new Error('A video URL is required.');
    const url = new URL(message.url);
    if (message.kind !== 'capture' && message.kind !== 'original') {
      throw new Error('Choose captured playback or the original video.');
    }
    if (url.protocol === 'blob:') {
      const source = new URL(sender.url);
      if (!['http:', 'https:'].includes(source.protocol) || url.origin !== source.origin) {
        throw new Error('The video buffer must belong to the page that requested it.');
      }
    } else if (message.kind === 'capture' || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('This video source cannot be downloaded.');
    }
    if (/\.(?:m3u8?|mpd|f4m)$/i.test(decodeURIComponent(url.pathname))) {
      throw new Error('This source is a streaming playlist, not a complete video file. Use captured playback instead.');
    }
    return url.href;
  }

  function filename(message) {
    const extension = message.extension == null || message.extension === ''
      ? (message.kind === 'capture' ? 'webm' : '')
      : message.extension;
    if (typeof extension !== 'string' || (extension && !extensions.has(extension.toLowerCase()))) {
      throw new Error('Unsupported video filename extension.');
    }
    let title = typeof message.title === 'string' ? message.title.slice(0, 2000) : 'video';
    title = title.normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/\.{2,}/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '');
    // Bound both characters and UTF-8 bytes so Unicode titles fit filesystem limits.
    const characters = Array.from(title).slice(0, 100);
    while (new TextEncoder().encode(characters.join('')).length > 120) characters.pop();
    title = characters.join('').replace(/[.\s]+$/g, '') || 'video';
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = `_${title}`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `PiPBrave/${title}-${timestamp}${extension ? `.${extension.toLowerCase()}` : ''}`;
  }

  async function handle(message, sender) {
    authorize(sender);
    if (message.action === 'start') {
      const url = mediaURL(message, sender);
      const relativeName = filename(message);
      const id = await chrome.downloads.download({
        url,
        filename: relativeName,
        conflictAction: 'uniquify',
        saveAs: false
      });
      if (!Number.isInteger(id)) throw new Error('Brave did not start the video download.');
      return { ok: true, id, filename: relativeName };
    }
    if (message.action === 'status' || message.action === 'cancel') {
      if (!Number.isInteger(message.id) || message.id < 0) throw new Error('Invalid download ID.');
      // The browser's download history survives service-worker restarts. Only
      // expose downloads created by this extension, never unrelated downloads.
      const [download] = await chrome.downloads.search({ id: message.id });
      if (!download || download.byExtensionId !== chrome.runtime.id) {
        throw new Error('This video download could not be found.');
      }
      if (message.action === 'cancel') {
        if (download.state === 'in_progress') await chrome.downloads.cancel(message.id);
        return { ok: true };
      }
      return {
        ok: true,
        state: download.state,
        error: download.error || '',
        filename: download.filename
      };
    }
    throw new Error('Unknown video download action.');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'brave-pip-download') return false;
    handle(message, sender).then(sendResponse, error => {
      sendResponse({ ok: false, error: String(error.message || error) });
    });
    return true;
  });
})();
