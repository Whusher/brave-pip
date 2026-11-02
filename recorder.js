(() => {
  if (window.__bravePiPCreateRecorder) return;

  const MAX_BYTES = 256 * 1024 * 1024;
  // Without timeslices Chromium can finalize duration and seek metadata. Bound
  // the internal recorder buffer by time and target bitrate instead of flushing
  // partial files with requestData(), which disables that finalization.
  const MAX_DURATION_MS = 10 * 60 * 1000;
  const VIDEO_BITS_PER_SECOND = 2500000;
  const AUDIO_BITS_PER_SECOND = 128000;

  window.__bravePiPCreateRecorder = function createRecorder(video, onUpdate) {
    let recorder = null;
    let stream = null;
    let timer = null;
    let chunks = [];
    let blob = null;
    let bytes = 0;
    let startedAt = 0;
    let elapsedMs = 0;
    let status = 'idle';
    let message = '';
    let failure = null;
    let completion = null;
    let resolveCompletion = null;
    let rejectCompletion = null;
    let disposed = false;
    let listeners = [];
    let cancelValidation = null;
    let stopReason = null;

    function getState() {
      return {
        status,
        bytes,
        elapsedMs: status === 'recording' || status === 'stopping'
          ? Date.now() - startedAt : elapsedMs,
        message,
        stopReason,
      };
    }

    function update() {
      try {
        onUpdate?.(getState());
      } catch (error) {
        console.warn('BravePiP could not update recording controls:', error);
      }
    }

    function listen(target, name, handler) {
      target.addEventListener(name, handler);
      listeners.push(() => target.removeEventListener(name, handler));
    }

    function releaseCapture() {
      clearInterval(timer);
      timer = null;
      for (const remove of listeners) remove();
      listeners = [];
      // Record cloned tracks: Chromium can return the input MediaStream's tracks
      // directly from captureStream(). Stopping those would stop page playback.
      for (const track of stream?.getTracks() || []) track.stop();
      stream = null;
    }

    function readableError(error) {
      if (video.mediaKeys) return 'This protected video cannot be recorded.';
      if (error.name === 'SecurityError') {
        return "This video's source does not allow recording (cross-origin restrictions).";
      }
      return String(error.message || error);
    }

    function validateRecording(recording) {
      return new Promise((resolve, reject) => {
        const preview = document.createElement('video');
        const url = URL.createObjectURL(recording);
        let settled = false;
        const done = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cancelValidation = null;
          preview.onloadeddata = preview.onerror = null;
          preview.removeAttribute('src');
          preview.load();
          URL.revokeObjectURL(url);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => done(new Error('The recorded video could not be validated. Try saving a longer playback.')), 10000);
        cancelValidation = () => done(new Error('The recording session was closed.'));
        preview.muted = true;
        preview.onloadeddata = () => {
          if (!preview.videoWidth || !Number.isFinite(preview.duration) || preview.duration <= 0) {
            done(new Error('The recording has no playable video or finalized duration. Start playback and try again with an updated Brave browser.'));
          } else done();
        };
        preview.onerror = () => done(new Error('The browser produced an unreadable recording. Start playback and try again.'));
        preview.src = url;
      });
    }

    async function finish() {
      if (disposed || !resolveCompletion) return;
      elapsedMs = Date.now() - startedAt;
      const mimeType = recorder.mimeType || 'video/webm';
      releaseCapture();
      recorder = null;
      // A timeslice is not necessarily a playable file. Keep every chunk,
      // including the final dataavailable event that precedes the stop event.
      let recording = bytes > 0 && bytes <= MAX_BYTES ? new Blob(chunks, { type: mimeType }) : null;
      chunks = [];
      const stopMessage = message;
      status = 'finalizing';
      message = 'Preparing recorded playback…';
      update();
      if (recording) {
        try {
          await validateRecording(recording);
        } catch (error) {
          failure = error;
          recording = null;
        }
      } else if (bytes > MAX_BYTES) {
        failure = new Error('The recording exceeds 256 MiB. Save a shorter playback.');
      }
      if (disposed || !resolveCompletion) return;
      blob = recording;
      const resolve = resolveCompletion;
      const reject = rejectCompletion;
      resolveCompletion = null;
      rejectCompletion = null;
      if (blob) {
        status = 'stopped';
        if (failure) message = `${readableError(failure)} The captured portion is available to save.`;
        else message = stopMessage || 'Captured playback is ready to save.';
        resolve(blob);
      } else {
        status = 'error';
        message = failure ? readableError(failure)
          : 'No video has been captured yet. Start playback and record again.';
        failure = new Error(message);
        reject(failure);
      }
      update();
    }

    function requestStop(reason = '', code = 'manual') {
      if (status !== 'recording') return;
      stopReason = code;
      if (reason) message = reason;
      status = 'stopping';
      clearInterval(timer);
      timer = null;
      try {
        // An inactive recorder may already have its final events queued.
        if (recorder.state !== 'inactive') recorder.stop();
      } catch (error) {
        failure = error;
        finish();
        return;
      }
      update();
    }

    function start() {
      if (disposed) throw new Error('This recording session has been closed.');
      if (['recording', 'stopping', 'finalizing'].includes(status)) {
        throw new Error('A recording is already in progress.');
      }
      releaseCapture();
      chunks = [];
      blob = null;
      bytes = 0;
      elapsedMs = 0;
      failure = null;
      message = '';
      stopReason = null;
      completion = null;
      resolveCompletion = null;
      rejectCompletion = null;

      try {
        if (video.mediaKeys) throw new Error('This protected video cannot be recorded.');
        if (typeof video.captureStream !== 'function' || typeof MediaRecorder !== 'function') {
          throw new Error('This browser does not support recording video playback.');
        }
        if (video.readyState === 0 || video.videoWidth === 0) {
          throw new Error('Start playing the video before recording.');
        }
        const captured = video.captureStream();
        const sourceIds = new Set(video.srcObject?.getTracks?.().map(track => track.id) || []);
        stream = new MediaStream(captured.getTracks().map(track => track.clone()));
        for (const track of captured.getTracks()) {
          if (!sourceIds.has(track.id)) track.stop();
        }
        if (!stream.getVideoTracks().some(track => track.readyState === 'live')) {
          throw new Error('This video has no available video track to record.');
        }
        const formats = stream.getAudioTracks().length
          ? ['video/webm;codecs=vp8,opus', 'video/webm']
          : ['video/webm;codecs=vp8', 'video/webm'];
        const mimeType = formats.find(type => MediaRecorder.isTypeSupported(type));
        if (!mimeType) throw new Error('This browser cannot record video in WebM format.');
        recorder = new MediaRecorder(stream, {
          mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
          audioBitsPerSecond: AUDIO_BITS_PER_SECOND
        });
        completion = new Promise((resolve, reject) => {
          resolveCompletion = resolve;
          rejectCompletion = reject;
        });
        // Automatic limits or source errors can stop before anyone presses Save.
        // Keep that rejection handled until stop() is called by the UI.
        completion.catch(() => {});

        listen(recorder, 'dataavailable', event => {
          if (disposed || !event.data?.size) return;
          chunks.push(event.data);
          bytes += event.data.size;
          if (bytes >= MAX_BYTES && status === 'recording') {
            requestStop('The 256 MiB recording limit was reached. Save this recording to continue.', 'limit');
          } else {
            update();
          }
        });
        listen(recorder, 'stop', finish);
        listen(recorder, 'error', event => {
          failure = event.error || new Error('The browser could not continue recording.');
          requestStop(readableError(failure), 'error');
        });
        for (const track of stream.getVideoTracks()) {
          listen(track, 'ended', () => {
            if (!stream?.getVideoTracks().some(candidate => candidate.readyState === 'live')) {
              requestStop('The video ended or its source changed. Captured playback is ready to save.', video.ended ? 'ended' : 'source');
            }
          });
        }
        for (const event of ['emptied', 'loadstart', 'ended']) {
          listen(video, event, () => requestStop('The video ended or its source changed. Preparing captured playback.', event === 'ended' ? 'ended' : 'source'));
        }

        startedAt = Date.now();
        // A timeslice produces a live WebM without normal duration/index metadata.
        // Let the browser write a complete, seekable file when the capture stops.
        recorder.start();
        status = 'recording';
        timer = setInterval(() => {
          if (Date.now() - startedAt >= MAX_DURATION_MS) {
            requestStop('The 10 minute recording limit was reached. Save this recording to continue.', 'limit');
          } else {
            update();
          }
        }, 1000);
        update();
        return getState();
      } catch (error) {
        releaseCapture();
        status = 'error';
        message = readableError(error);
        failure = new Error(message);
        rejectCompletion?.(failure);
        resolveCompletion = null;
        rejectCompletion = null;
        update();
        throw failure;
      }
    }

    function stop() {
      if (disposed) return Promise.reject(new Error('This recording session has been closed.'));
      if (blob) return Promise.resolve(blob);
      if (!completion) return Promise.reject(failure || new Error('No playback has been recorded yet.'));
      requestStop();
      return completion;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelValidation?.();
      releaseCapture();
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* The source may already be gone. */ }
      }
      rejectCompletion?.(new Error('The recording session was closed.'));
      resolveCompletion = null;
      rejectCompletion = null;
      completion = null;
      recorder = null;
      chunks = [];
      blob = null;
      bytes = 0;
      elapsedMs = 0;
      status = 'idle';
      message = 'Recording buffer cleared.';
      update();
    }

    return { start, stop, dispose, getState };
  };
})();
