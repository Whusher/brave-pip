(() => {
  // Each toolbar click toggles PiP; install the hover controls only once per page.
  if (window.__floatingVideoBrave) return window.__floatingVideoBrave.toggle();

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '▣ PiP';
  button.setAttribute('aria-label', 'Float this video');
  button.title = 'Open this video in Picture-in-Picture';
  Object.assign(button.style, {
    position: 'fixed', zIndex: '2147483647', display: 'none',
    padding: '8px 12px', border: '0', borderRadius: '7px',
    background: '#191919', color: '#fff', font: 'bold 13px Arial, sans-serif',
    boxShadow: '0 2px 10px #0008', cursor: 'pointer'
  });
  document.documentElement.appendChild(button);

  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  Object.assign(status.style, {
    position: 'fixed', zIndex: '2147483647', display: 'none',
    bottom: '20px', left: '20px', maxWidth: 'min(420px, calc(100vw - 40px))',
    padding: '12px 16px', borderRadius: '7px', background: '#191919',
    color: '#fff', font: '14px Arial, sans-serif', boxShadow: '0 2px 10px #0008'
  });
  document.documentElement.appendChild(status);
  let currentVideo = null;
  let statusTimer;
  let pending;

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

  function showError(message) {
    clearTimeout(statusTimer);
    status.textContent = `PiP unavailable: ${message}`;
    status.style.display = 'block';
    statusTimer = setTimeout(() => { status.style.display = 'none'; }, 6000);
  }

  document.addEventListener('mousemove', (event) => {
    if (button.contains(event.target)) return;
    // Players such as YouTube put controls/overlays above the <video>. Hit-test
    // its bounds instead of requiring the video to be in the event's path.
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

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (currentVideo) void toggle(currentVideo);
  });

  async function toggleVideo(video) {
    try {
      if (document.pictureInPictureElement && (!video || document.pictureInPictureElement === video)) {
        await document.exitPictureInPicture();
      } else {
        if (!document.pictureInPictureEnabled) {
          throw new Error('Picture-in-Picture is disabled by this browser or page.');
        }
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
        // Do not await playback or messaging before this user-gesture-sensitive call.
        await video.requestPictureInPicture();
      }
      hideButton();
      clearTimeout(statusTimer);
      status.style.display = 'none';
      return { ok: true };
    } catch (err) {
      const error = err.name === 'NotAllowedError'
        ? 'Hover over the video and click the ▣ PiP button to allow Picture-in-Picture.'
        : String(err.message || err);
      showError(error);
      return { ok: false, error };
    }
  }

  function toggle(video) {
    if (!pending) pending = toggleVideo(video).finally(() => { pending = null; });
    return pending;
  }

  window.__floatingVideoBrave = { toggle };
  return toggle();
})();
