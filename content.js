(() => {
  if (window.__floatingVideoBrave) return { ok: true };

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '▣ PiP';
  button.setAttribute('aria-label', 'Float this video');
  button.title = 'Open this video in Picture-in-Picture';
  const buttonStyle = {
    position: 'fixed', zIndex: '2147483647', display: 'none',
    padding: '8px 12px', border: '0', borderRadius: '7px',
    background: '#191919', color: '#fff', font: 'bold 13px Arial, sans-serif',
    boxShadow: '0 2px 10px #0008', cursor: 'pointer'
  };
  Object.assign(button.style, buttonStyle);
  document.documentElement.appendChild(button);

  // Native PiP stays video-only. The one-click save control lives on the source page.
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.id = 'brave-pip-save';
  saveButton.textContent = '↓ Save playback';
  saveButton.setAttribute('aria-label', 'Save captured playback');
  Object.assign(saveButton.style, buttonStyle, { bottom: '20px', right: '20px' });
  document.documentElement.appendChild(saveButton);

  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  Object.assign(status.style, {
    position: 'fixed', zIndex: '2147483647', display: 'none',
    bottom: '64px', right: '20px', maxWidth: 'min(420px, calc(100vw - 40px))',
    padding: '12px 16px', borderRadius: '7px', background: '#191919',
    color: '#fff', font: '14px Arial, sans-serif', boxShadow: '0 2px 10px #0008'
  });
  document.documentElement.appendChild(status);
  let currentVideo = null;
  let statusTimer;
  let pending;
  let recorder = null;
  let captureVideo = null;
  let captureTitle = '';
  let saving = false;
  let downloadingOriginal = false;
  let captureState = { status: 'idle', bytes: 0, elapsedMs: 0, message: '' };
  let autosaveEnabled = false;
  let settingRevision = 0;
  const autosave = window.__bravePiPCreateAutosave({
    getVideo: () => document.pictureInPictureElement || visibleVideos().filter(video => {
      const rect = video.getBoundingClientRect();
      return rect.width >= 100 && rect.height >= 60;
    }).sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * aRect.height;
    })[0],
    save: (blob, title) => download({ url: URL.createObjectURL(blob), extension: 'webm', owned: true }, title, 'capture'),
    onState: updateAutosave,
    notify: showStatus
  });

  function setAutosave(value) {
    saveButton.dataset.autosaveEnabled = String(value);
    if (autosaveEnabled === value) return;
    autosaveEnabled = value;
    if (value) {
      // Preserve an existing manual capture for saving after autosave is off.
      // Autosave begins a separate session at the current playback position.
      void stopCapture();
    }
    autosave.setEnabled(value);
    if (!value) {
      if (document.pictureInPictureElement && !saving) beginCapture(document.pictureInPictureElement);
      updateCapture(recorder?.getState() || captureState);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.autosaveEnabled) return;
    settingRevision++;
    setAutosave(changes.autosaveEnabled.newValue === true);
  });
  const initialRevision = settingRevision;
  const settingsReady = chrome.storage.local.get({ autosaveEnabled: false }).then(settings => {
    if (settingRevision === initialRevision) setAutosave(settings.autosaveEnabled === true);
  }).catch(error => showStatus(`Could not read autosave setting: ${error.message || error}`));

  function visibleVideos() {
    return Array.from(document.querySelectorAll('video')).filter(video => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(video).visibility !== 'hidden';
    }).sort((a, b) => {
      const playing = Number(!b.paused && !b.ended) - Number(!a.paused && !a.ended);
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return playing || bRect.width * bRect.height - aRect.width * aRect.height;
    });
  }

  function hideButton() {
    currentVideo = null;
    button.style.display = 'none';
  }

  function showStatus(message) {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.style.display = 'block';
    statusTimer = setTimeout(() => { status.style.display = 'none'; }, 8000);
  }

  function updateCapture(state) {
    captureState = state;
    if (autosaveEnabled) return;
    saveButton.dataset.captureState = state.status;
    saveButton.dataset.captureBytes = String(state.bytes);
    const ready = state.status === 'stopped' && state.bytes > 0;
    const recording = state.status === 'recording';
    saveButton.style.display = recorder || saving ? 'block' : 'none';
    saveButton.disabled = saving || (!ready && !(recording && state.elapsedMs >= 1000));
    saveButton.style.opacity = saveButton.disabled ? '.65' : '1';
    saveButton.textContent = saving ? 'Saving…' : '↓ Save playback';
    const seconds = Math.floor(state.elapsedMs / 1000);
    saveButton.title = recording
      ? `Capturing automatically · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. Save playback captured since PiP opened or your last save.`
      : state.message || 'Save playback captured while PiP was open.';
  }

  function updateAutosave(state) {
    if (!autosaveEnabled) return;
    saveButton.dataset.captureState = state.status;
    saveButton.dataset.captureBytes = String(state.bytes);
    saveButton.style.display = 'block';
    saveButton.disabled = !state.retryAvailable && !(state.status === 'recording' && state.elapsedMs >= 1000);
    saveButton.style.opacity = saveButton.disabled ? '.65' : '1';
    saveButton.textContent = state.retryAvailable ? '↓ Retry save'
      : state.status === 'saving' ? 'Saving…' : state.status === 'recording' ? '↓ Save playback' : 'Autosave on';
    saveButton.title = state.retryAvailable ? 'Retry the previous download. Current playback keeps recording.'
      : state.status === 'recording' ? 'Autosave is on. Playback will save when the video ends. Click to save the captured portion now.'
      : state.message;
  }

  function beginCapture(video) {
    if (saving || autosaveEnabled) return;
    if (recorder) {
      const state = recorder.getState();
      if (captureVideo === video && ['recording', 'stopping', 'finalizing'].includes(state.status)) return;
      if (['stopping', 'finalizing', 'stopped'].includes(state.status)) {
        showStatus('Your previous playback is ready to save. Save it to start capturing this video.');
        return;
      }
      recorder.dispose();
    }
    captureVideo = video;
    captureTitle = document.title || 'Video';
    recorder = window.__bravePiPCreateRecorder(video, updateCapture);
    try {
      recorder.start();
    } catch (error) {
      showStatus(`PiP is playing. Capture unavailable: ${error.message || error}`);
    }
  }

  async function stopCapture() {
    if (!recorder || !['recording', 'stopping', 'finalizing'].includes(recorder.getState().status)) return;
    try { await recorder.stop(); }
    catch (error) { showStatus(`Capture unavailable: ${error.message || error}`); }
  }

  document.addEventListener('enterpictureinpicture', event => {
    void settingsReady.then(() => {
      if (document.pictureInPictureElement !== event.target) return;
      if (autosaveEnabled) autosave.ensure(event.target);
      else beginCapture(event.target);
    });
  }, true);
  document.addEventListener('leavepictureinpicture', () => { if (!autosaveEnabled) void stopCapture(); }, true);
  window.addEventListener('pagehide', () => { recorder?.dispose(); autosave.dispose(); });

  document.addEventListener('mousemove', event => {
    if (button.contains(event.target) || saveButton.contains(event.target)) return;
    // Player controls can cover the video. Hit-test its bounds, not the event path.
    const video = visibleVideos().find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= 100 && rect.height >= 60 &&
        event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    if (!video) return hideButton();
    const rect = video.getBoundingClientRect();
    currentVideo = video;
    button.style.display = 'block';
    button.style.top = `${Math.max(4, rect.top + 12)}px`;
    button.style.left = `${Math.max(4, Math.min(window.innerWidth - 85, rect.right - 85))}px`;
  }, true);
  document.addEventListener('scroll', hideButton, true);
  window.addEventListener('resize', hideButton);

  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (currentVideo) void toggle(currentVideo);
  });
  saveButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void savePlayback();
  });

  function extensionFor(type, url = '') {
    const types = { 'video/webm': 'webm', 'video/mp4': 'mp4', 'video/ogg': 'ogv',
      'video/quicktime': 'mov', 'video/x-matroska': 'mkv' };
    const mime = (type || '').split(';')[0].trim().toLowerCase();
    if (types[mime]) return types[mime];
    return new URL(url || location.href).pathname.match(/\.(webm|mp4|m4v|mov|ogv|ogg|mkv)$/i)?.[1].toLowerCase() || '';
  }

  async function originalSource(video) {
    if (video.mediaKeys) throw new Error('This player protects its media; the original video cannot be downloaded.');
    const unavailable = 'This player does not expose a complete video file. Use Save playback instead.';
    if (video.srcObject || !video.currentSrc) throw new Error(unavailable);
    const url = new URL(video.currentSrc, location.href);
    if (/\.(m3u8|mpd)$/i.test(url.pathname)) throw new Error(unavailable);
    if (url.protocol === 'blob:') {
      let blob;
      try {
        const response = await fetch(url.href);
        if (!response.ok) throw new Error();
        blob = await response.blob();
      } catch { throw new Error(unavailable); }
      if (!blob.size || !/^video\//i.test(blob.type)) throw new Error(unavailable);
      return { url: URL.createObjectURL(blob), extension: extensionFor(blob.type), owned: true };
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(unavailable);
    const source = Array.from(video.querySelectorAll('source')).find(item => item.src === url.href);
    return { url: url.href, extension: extensionFor(source?.type, url.href), owned: false };
  }

  async function download(source, title, kind) {
    let id;
    let terminal = false;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'brave-pip-download', action: 'start', url: source.url,
        title, extension: source.extension, kind
      });
      if (!result?.ok) throw new Error(result?.error || 'The download could not be started.');
      id = result.id;
      showStatus(`Saving to ${result.filename}. Keep this tab open until it finishes.`);
      while (true) {
        const progress = await chrome.runtime.sendMessage({ type: 'brave-pip-download', action: 'status', id });
        if (!progress?.ok) throw new Error(progress?.error || 'Could not check the download.');
        if (progress.state === 'complete') {
          terminal = true;
          showStatus(`Saved to PiPBrave: ${result.filename.split('/').pop()}`);
          return;
        }
        if (progress.state === 'interrupted') {
          terminal = true;
          throw new Error(progress.error || 'The download was interrupted.');
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      if (source.owned) {
        // Never invalidate an in-flight Blob after a status-channel failure.
        // Cancel it first; otherwise leave the URL alive until the page unloads.
        if (id != null && !terminal) {
          try {
            const result = await chrome.runtime.sendMessage({ type: 'brave-pip-download', action: 'cancel', id });
            terminal = !!result?.ok;
          } catch { /* The extension may have been reloaded during the download. */ }
        }
        if (id == null || terminal) URL.revokeObjectURL(source.url);
      }
    }
  }

  async function savePlayback() {
    if (autosaveEnabled) {
      const result = await autosave.saveCurrent();
      if (!result.ok) showStatus(result.error);
      return result;
    }
    if (saving) return { ok: false, error: 'A save is already in progress.' };
    if (!recorder) {
      const error = 'Open PiP and let the video play before saving playback.';
      showStatus(error);
      return { ok: false, error };
    }
    saving = true;
    updateCapture(captureState);
    try {
      const blob = await recorder.stop();
      await download({ url: URL.createObjectURL(blob), extension: 'webm', owned: true }, captureTitle, 'capture');
      recorder.dispose();
      recorder = null;
      captureVideo = null;
      return { ok: true };
    } catch (error) {
      showStatus(`Save failed: ${error.message || error}`);
      return { ok: false, error: String(error.message || error) };
    } finally {
      saving = false;
      if (!recorder && document.pictureInPictureElement) beginCapture(document.pictureInPictureElement);
      updateCapture(recorder?.getState() || { status: 'idle', bytes: 0, elapsedMs: 0, message: '' });
    }
  }

  async function saveOriginal() {
    if (downloadingOriginal) return { ok: false, error: 'The original video is already downloading.' };
    downloadingOriginal = true;
    try {
      const video = document.pictureInPictureElement || (captureVideo?.isConnected && captureVideo) || visibleVideos()[0];
      if (!video) throw new Error('Open a video before downloading its original file.');
      await download(await originalSource(video), document.title || 'Video', 'original');
      return { ok: true };
    } catch (error) {
      showStatus(`Save failed: ${error.message || error}`);
      return { ok: false, error: String(error.message || error) };
    } finally { downloadingOriginal = false; }
  }

  async function toggleVideo(video) {
    try {
      clearTimeout(statusTimer);
      status.style.display = 'none';
      if (document.pictureInPictureElement && (!video || document.pictureInPictureElement === video)) {
        await document.exitPictureInPicture();
      } else {
        if (!document.pictureInPictureEnabled) throw new Error('Picture-in-Picture is disabled by this browser or page.');
        if (!video) {
          const videos = visibleVideos();
          if (!videos.length) throw new Error('No video found on this page. Open a video and try again.');
          video = videos.find(candidate => candidate.readyState > 0 && candidate.videoWidth > 0);
        }
        if (!video || !video.isConnected || video.readyState === 0 || video.videoWidth === 0) {
          throw new Error('Start playing the video, then try again.');
        }
        if (video.disablePictureInPicture || typeof video.requestPictureInPicture !== 'function') {
          throw new Error('This player does not allow Picture-in-Picture.');
        }
        // Preserve native PiP and the site's video element. Capture failure must
        // never prevent playback or move the video out of its original player.
        await video.requestPictureInPicture();
      }
      hideButton();
      return { ok: true };
    } catch (err) {
      const error = err.name === 'NotAllowedError'
        ? 'Hover over the video and click the ▣ PiP button to allow Picture-in-Picture.'
        : String(err.message || err);
      showStatus(`PiP unavailable: ${error}`);
      return { ok: false, error };
    }
  }

  function toggle(video) {
    if (!pending) pending = toggleVideo(video).finally(() => { pending = null; });
    return pending;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'brave-pip-control') return false;
    const action = message.action === 'save' ? savePlayback : message.action === 'original' ? saveOriginal : null;
    if (!action) return false;
    action().then(sendResponse, error => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  });
  window.__floatingVideoBrave = { toggle };
  return { ok: true };
})();
