# Phone Away

A local camera app that notices a phone in your hand, draws a yellow box around it, and plays an audio reminder. It uses pretrained **YOLO26n + MediaPipe Hand Landmarker** in your browser. No model training, API key, cloud account, or paid inference is required.

## Setup and run

Requirements:

- **Python 3.9 or newer** to serve the app. The server uses only the standard library.
- A recent **Chrome** browser with camera access. Chrome on macOS is the verified configuration; other browsers depend on their Web Worker, OffscreenCanvas, and WebAssembly support.
- A webcam. A MacBook's built-in camera works.

Clone the repository with a GitHub account that has access:

```sh
git clone https://github.com/galiniecodes/phone-away.git
cd phone-away
python3 scripts/download_realtime_models.py --verify
python3 server.py --open
```

Open **http://127.0.0.1:8765** if it does not open automatically. On macOS, you can also double-click **Start Phone Away.command** from the project folder.

1. Click **Start monitoring** and allow camera access. The bundled models load on the first start.
2. Keep your phone and hands visible in the camera preview. A yellow box means the detector sees a phone; audio requires evidence that it is held.
3. Use **Play audio** to check your speakers, or **Choose audio file** to use your own clip.
4. **Pause** stops the camera; **Resume** continues the session. **End session** resets it. Press **Control-C** in the server terminal to stop the server.

There is no frontend build step, npm installation, Python package installation, or model download during normal startup. All runtime files and models are bundled (approximately 60 MB). After cloning, inference works offline.

If port 8765 is busy:

```sh
python3 server.py --port 8766 --open
```

Use `--no-open` to run without opening a browser. Custom audio is stored per browser and address, so changing the hostname or port uses separate audio storage.

## Detection and audio

- **Sensitivity:** defaults to Very high (phone score of 0.25 or higher). High, Balanced, and Low require stronger scores. Higher sensitivity can produce more false alerts.
- **Confirmation:** defaults to one second of phone-in-hand evidence before playing audio.
- **Check speed:** targets 10, 5, or 2 checks per second. Actual speed depends on your device. Only one fresh frame is processed at a time; frames are never queued.
- **Repeat alerts:** one alert per pickup. One second of clear observations rearms the next alert. A single missed detection or an obscured hand does not immediately rearm it.
- **Custom audio:** up to 30 seconds and 10 MB. The original clip is saved locally in IndexedDB and restored after refresh. Each new pickup plays it from the beginning. Clearing browser site data removes it; **Use default** restores the bundled goat scream (1.8 seconds).
- **Test alert (no camera):** simulates a phone-use incident to test timing and audio. It does not test model accuracy.

Monitoring continues when you switch tabs while the browser permits execution. Keep the page open and your Mac awake: browser suspension, background throttling, and computer sleep can delay or stop checks.

## Privacy and limitations

Camera frames are processed in a browser worker, never uploaded or saved. The Python server only serves bundled files on `127.0.0.1`; it has no analysis API, provider integration, or image-upload endpoint. The app does not request microphone access. Custom audio stays in your browser.

YOLO26 finds phones and MediaPipe finds hands. Their overlap estimates whether a phone is being held; it cannot tell whether the phone is being used for work or determine attention. Small or obscured phones, hidden hands, poor lighting, and unusual camera angles can cause misses. A hand beside a desk phone can cause a false alert. Test with your camera angle and adjust sensitivity or confirmation time as needed.

YOLO uses WebGPU when available and falls back to WebAssembly. Hand tracking uses WebGL when available and falls back to the CPU. If model loading times out, reload the page in a recent Chrome browser and verify the assets using the command below.

## Development and checks

Edit files in `public/` and refresh the page. Restart `server.py` after changing Python code. Static responses disable caching so updates are picked up on refresh.

Use **Node.js 22.18 or newer** for the JavaScript tests. Node is not needed to run the app.

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/download_realtime_models.py --verify
```

The tests cover detection geometry, alert timing and rearming, background sessions, pause/resume, custom-audio persistence and replay, and the local server. Tests use simulated frames and worker results; they do not access your camera or measure real-world accuracy.

For a camera-free runtime check, open **http://127.0.0.1:8765/vision-check.html**. It loads the actual local models and measures 20 checks on an empty frame or a still image you select. An empty frame verifies loading and execution, not detection accuracy.

### Restoring model assets

The normal clone contains all model/runtime assets. Their source URLs, versions, file sizes, and SHA-256 hashes are pinned in `scripts/realtime-assets.json`.

Restore missing or changed downloaded runtime files with:

```sh
python3 scripts/download_realtime_models.py
```

The generated YOLO ONNX file can also be restored from Git. Re-exporting it is an optional maintenance task, not normal setup. It requires the pinned build environment (Python 3.12, verified on macOS ARM64):

```sh
python3.12 -m venv work/model-export
work/model-export/bin/python -m pip install -r scripts/realtime-export-requirements.txt
python3 scripts/download_realtime_models.py --export-python work/model-export/bin/python
```

The restore tool verifies the official pretrained checkpoint and the exported model checksum. It performs no training. These maintenance downloads require internet access; model execution does not.

## Project layout

```text
server.py                    Loopback-only static file server
Start Phone Away.command     macOS launcher
public/app.js                Camera, session controls, overlays, and audio wiring
public/detection.js          Worker client and once-per-pickup alert gate
public/detection-worker.js   YOLO and MediaPipe inference worker
public/realtime-vision.js    Frame conversion, boxes, and hand-contact checks
public/audio-*.js            Audio playback and IndexedDB persistence
public/models/              Bundled pretrained models
public/vendor/              Bundled inference runtimes and licenses
public/vision-check.*        Camera-free runtime diagnostic
scripts/                    Pinned asset verification, restore, and export tools
tests/                      JavaScript and Python tests
```

## Third-party assets

See [THIRD_PARTY.txt](THIRD_PARTY.txt) for sources and included license files. The YOLO26 model is AGPL-3.0, ONNX Runtime is MIT, and MediaPipe is Apache-2.0. Keep their license notices with redistributed assets.

The bundled spoken sample was generated locally with the macOS Samantha voice and converted to mono 22.05 kHz WAV. This attribution does not grant a separate license to Apple's system voice.
