(() => {
  if (window.__bravePiPCreateAutosave) return;

  // Finalizing the previous file must not delay capture of the next video.
  window.__bravePiPCreateAutosave = function ({ getVideo, save, onState, notify }) {
    let enabled = false;
    let current = null;
    let waiting = null;
    let disposed = false;
    const sessions = new Set();
    const MAX_PENDING = 3;

    function report() {
      const retryAvailable = Array.from(sessions).some(session => session.failed && !session.finishing);
      const state = current ? current.recorder.getState() : {
        status: retryAvailable ? 'error' : sessions.size ? 'saving' : 'idle', bytes: 0, elapsedMs: 0,
        message: retryAvailable ? 'Autosave failed. Click to retry saving.'
          : sessions.size ? 'Saving completed playback…' : 'Autosave is on. Waiting for video playback.'
      };
      onState({ ...state, retryAvailable });
    }

    function ensure(video = getVideo(), part = 1, title) {
      if (!enabled || disposed || !video || !video.isConnected || video.paused || video.ended ||
          video.readyState < 2 || video.videoWidth === 0) return;
      if (current?.video === video) return;
      if (current) void finalize(current, 'source');
      if (sessions.size >= MAX_PENDING) {
        if (!waiting) notify('Autosave is waiting for previous files to save. Use Save playback to retry a failed download.');
        waiting = { video, part, title };
        return;
      }
      waiting = null;
      const session = { video, title: title || document.title || 'Video', part,
        recorder: null, finishing: null, failed: false, saveAllowed: true, hasBlob: false, reason: null };
      session.recorder = window.__bravePiPCreateRecorder(video, state => {
        if (disposed || !enabled) return;
        if (current === session) report();
        // The recorder can notice limits/source changes before page events.
        if (!session.finishing && ['stopping', 'stopped'].includes(state.status) && state.stopReason) {
          queueMicrotask(() => {
            if (!enabled || session.finishing || !sessions.has(session)) return;
            void finalize(session, state.stopReason);
            if (state.stopReason === 'limit') ensure(video, session.part + 1, session.title);
          });
        }
      });
      current = session;
      sessions.add(session);
      try {
        session.recorder.start();
        if (part === 1 && video.currentTime > 0.5) {
          notify('Autosave is recording from the current position. Enable it before playback starts to capture the beginning.');
        }
      } catch (error) {
        // Keep this session until the source changes or autosave is toggled, so
        // a blocked source does not retry on every playing event.
        notify(`Autosave unavailable: ${error.message || error}`);
      }
    }

    function finalize(session, reason = 'ended') {
      if (session.finishing) return session.finishing;
      if (current === session) current = null;
      session.reason ||= reason;
      // Assign before stop() emits updates, preventing duplicate downloads.
      session.finishing = Promise.resolve().then(async () => {
        try {
          const blob = await session.recorder.stop();
          session.hasBlob = true;
          if (!enabled || disposed || !session.saveAllowed) return { ok: false, error: 'Autosave is off.' };
          const suffix = session.reason === 'limit' || session.part > 1 ? `-part-${session.part}`
            : session.reason === 'source' ? '-partial' : '';
          await save(blob, `${session.title}${suffix}`);
          sessions.delete(session);
          session.recorder.dispose();
          return { ok: true };
        } catch (error) {
          if (enabled && !disposed && session.saveAllowed) {
            if (session.hasBlob) {
              session.failed = true;
              notify(`Autosave failed: ${error.message || error}. Use Save playback to retry.`);
            } else {
              // Invalid/empty captures cannot be fixed by retrying a download.
              sessions.delete(session);
              session.recorder.dispose();
              notify(`Autosave could not capture this video: ${error.message || error}`);
            }
          }
          return { ok: false, error: String(error.message || error) };
        } finally {
          session.finishing = null;
          if (!enabled || disposed || !session.saveAllowed) {
            sessions.delete(session);
            session.recorder.dispose();
          }
          if (enabled && !disposed) {
            if (waiting && sessions.size < MAX_PENDING) {
              const next = waiting;
              waiting = null;
              if (next.video === getVideo()) ensure(next.video, next.part, next.title);
            }
            report();
          }
        }
      });
      report();
      return session.finishing;
    }

    const onPlay = event => {
      if (event.target instanceof HTMLVideoElement && event.target === getVideo()) ensure(event.target);
    };
    const onEnd = event => {
      if (current?.video === event.target) void finalize(current, 'ended');
    };
    const onSource = event => {
      if (current?.video === event.target) void finalize(current, 'source');
    };
    for (const type of ['play', 'playing', 'loadeddata']) document.addEventListener(type, onPlay, true);
    document.addEventListener('ended', onEnd, true);
    for (const type of ['emptied', 'loadstart']) document.addEventListener(type, onSource, true);
    const observer = new MutationObserver(records => {
      if (!enabled) return;
      // Ignore our own status/button updates and unrelated page mutations.
      const changedVideo = records.some(record => [...record.addedNodes, ...record.removedNodes].some(
        node => node instanceof HTMLVideoElement || node.querySelector?.('video')));
      if (!changedVideo) return;
      if (current && !current.video.isConnected) void finalize(current, 'source');
      ensure();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    function setEnabled(value) {
      if (disposed || enabled === value) return;
      enabled = value;
      if (enabled) {
        ensure();
        report();
      } else {
        current = waiting = null;
        for (const session of sessions) {
          session.saveAllowed = false;
          session.recorder.dispose();
        }
        sessions.clear();
        onState({ status: 'idle', bytes: 0, elapsedMs: 0, message: 'Autosave is off.' });
      }
    }

    async function saveCurrent() {
      const failed = Array.from(sessions).find(session => session.failed && !session.finishing);
      const session = failed || current;
      if (!session) return { ok: false, error: 'No playback is ready to save yet.' };
      const result = finalize(session, 'manual');
      if (!failed) ensure(session.video, session.part + 1, session.title);
      return result;
    }

    function dispose() {
      setEnabled(false);
      disposed = true;
      observer.disconnect();
      for (const type of ['play', 'playing', 'loadeddata']) document.removeEventListener(type, onPlay, true);
      document.removeEventListener('ended', onEnd, true);
      for (const type of ['emptied', 'loadstart']) document.removeEventListener(type, onSource, true);
    }

    return { setEnabled, ensure, saveCurrent, dispose };
  };
})();
