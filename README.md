# Hearings Recording Splitter (Test Build)

## What this does
- Load a local audio file (.m4a, .mp3, .wav, .aac, .ogg)
- Measure duration and plan segments so each part stays under a configurable MB size (default 20 MB)
- Split into M4A parts
  - Stream-copy for AAC-in-M4A (default, “same as source”)
  - Optional AAC re-encode at 96128192 kbps
- Append “(part X of Y)” to the original filename
- Immediate deletion of temporary files after export

## Run locally
- Serve `public` via any static server (e.g., `python -m http.server`, IIS, nginx)
- Open `index.html` in a modern browser (ChromeEdgeFirefoxSafari)
- Install as PWA (Add to Home Screen  Install app)

## Notes
- Size enforcement uses an average-bitrate heuristic; VBR tracks may vary.
- If any output part exceeds your limit, re-plan with a lower MB cap or choose a lower bitrate.
- All processing is client-side; no data leaves the device.