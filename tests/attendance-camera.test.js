const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function createCameraContext(isSecureContext, getUserMedia, failVideoLoad = false) {
  const listeners = {};
  const errors = [];
  let capturedStream = null;
  let trackingStarted = false;
  let trackStopped = false;
  const stream = {
    getTracks: function() {
      return [{ stop: function() { trackStopped = true; } }];
    }
  };
  const video = {
    readyState: 0,
    videoWidth: 1280,
    videoHeight: 720,
    paused: true,
    muted: true,
    onplay: null,
    addEventListener: function(name, callback) { listeners[name] = callback; },
    removeEventListener: function(name, callback) {
      if (listeners[name] === callback) delete listeners[name];
    },
    play: async function() {
      this.paused = false;
    }
  };
  Object.defineProperty(video, 'srcObject', {
    get: function() { return capturedStream; },
    set: function(value) {
      capturedStream = value;
      if (value) {
        this.readyState = 1;
        const eventName = failVideoLoad ? 'error' : 'loadedmetadata';
        if (listeners[eventName]) listeners[eventName]();
      }
    }
  });
  const classList = {
    add: function() {},
    remove: function() {}
  };
  const elements = {
    webcamVideo: video,
    faceCanvas: { width: 0, height: 0 },
    cameraStatusText: { innerHTML: '' },
    frErrorPanel: { classList: classList },
    frLoadingOverlay: { classList: classList }
  };
  const cameraStart = html.indexOf('async function bukaKameraDepanOtomatis()');
  const cameraEnd = html.indexOf('\nfunction showCameraError', cameraStart);
  const stopStart = html.indexOf('\nfunction stopCamera()', cameraEnd);
  const stopEnd = html.indexOf('\nfunction runAIFaceTrackingLoop', stopStart);
  assert.notEqual(cameraStart, -1, 'Camera startup function is missing');
  assert.notEqual(cameraEnd, -1, 'Camera startup function boundary is missing');
  assert.notEqual(stopStart, -1, 'Camera cleanup function is missing');
  assert.notEqual(stopEnd, -1, 'Camera cleanup function boundary is missing');

  const context = {
    window: { isSecureContext: isSecureContext },
    navigator: { mediaDevices: { getUserMedia: getUserMedia } },
    document: { getElementById: function(id) { return elements[id]; } },
    cameraStream: null,
    faceTrackInterval: null,
    clearInterval: clearInterval,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: { error: function() {} },
    showCameraError: function(message) { errors.push(message); },
    runAIFaceTrackingLoop: function() { trackingStarted = true; }
  };
  vm.runInNewContext(
    html.slice(cameraStart, cameraEnd) + html.slice(stopStart, stopEnd),
    context
  );
  return {
    context: context,
    elements: elements,
    errors: errors,
    stream: stream,
    trackWasStopped: function() { return trackStopped; },
    trackingStarted: function() { return trackingStarted; }
  };
}

test('attendance camera falls back to default video constraints and starts without mirroring', async function() {
  const calls = [];
  const camera = createCameraContext(true, async function(constraints) {
    calls.push(constraints);
    if (calls.length === 1) {
      const error = new Error('Unsupported preferred constraints');
      error.name = 'OverconstrainedError';
      throw error;
    }
    return camera.stream;
  });

  await camera.context.bukaKameraDepanOtomatis();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].video.facingMode.ideal, 'user');
  assert.equal(calls[1].video, true);
  assert.equal(calls[1].audio, false);
  assert.equal(camera.elements.webcamVideo.srcObject, camera.stream);
  assert.equal(camera.elements.faceCanvas.width, 1280);
  assert.equal(camera.elements.faceCanvas.height, 720);
  assert.equal(camera.trackingStarted(), true);
  assert.deepEqual(camera.errors, []);
  assert.doesNotMatch(html, /<video[^>]*id="webcamVideo"[^>]*transform:/);
  assert.doesNotMatch(html, /captureCtx\.(?:translate|scale)\(/);
  assert.match(html, /captureCtx\.drawImage\(video, 0, 0\)/);
});

test('attendance camera reports insecure origins without requesting camera access', async function() {
  let requestCount = 0;
  const camera = createCameraContext(false, async function() {
    requestCount++;
    return camera.stream;
  });

  await camera.context.bukaKameraDepanOtomatis();

  assert.equal(requestCount, 0);
  assert.match(camera.errors[0], /HTTPS atau localhost/);
});

test('attendance camera releases its stream when video initialization fails', async function() {
  const camera = createCameraContext(true, async function() {
    return camera.stream;
  }, true);

  await camera.context.bukaKameraDepanOtomatis();

  assert.equal(camera.trackWasStopped(), true);
  assert.match(camera.errors[0], /Video kamera gagal dimuat/);
});
