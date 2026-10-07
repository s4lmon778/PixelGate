# README visuals

| Asset                                 | Purpose                                                                   | Source                                                         |
| ------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `logo.svg`                            | Project mark                                                              | Local SVG artwork                                              |
| `controls-demo.gif`                   | Screen-awake preference animation and Light/Dark selection                | Recorded from PixelGate 0.3.13 in a fresh Chromium profile     |
| `quick-start.gif` / `quick-start.mp4` | Six-step pairing, transfer, saving, verification, and cleanup walkthrough | Actual synthetic-file transfer between fresh Chromium profiles |
| `transfer-flow.svg`                   | Direct WebRTC payload route and separate PeerJS signaling                 | Local SVG diagram, based on the architecture reference         |
| `desktop.png`                         | Desktop Send interface                                                    | Production preview with an empty queue                         |
| `mobile.png`                          | Mobile receiving/saving controls                                          | Production preview at 390 pixels in WebKit                     |
| `awake-switch.png`                    | Screen-awake control close-up                                             | Production preview at 390 pixels in WebKit                     |

The controls GIF demonstrates interface controls. It opens no pairing room and records no media transfer, device wake-lock measurement, or throughput benchmark. Its status remains “Ready” because no connection is active. All assets are stored in this repository.

## Reproduce the controls GIF

Requires the project's Playwright Chromium binary and FFmpeg on `PATH`. Install the browser once with `npx playwright install chromium`.

```sh
npm run build
npm start
```

In a second terminal:

```sh
node scripts/record-readme-demo.mjs
```

The script opens a fresh profile against the localhost production preview, records actual controls at 10 frames per second, and encodes a 960-pixel GIF. Temporary frames and the browser context are removed afterward. It does not access an existing browser profile or create a pairing code.

## Quick-start walkthrough

The 29-second walkthrough shows six steps: create a receiver code, connect the sender, approve, choose and send files, save a download, then verify that saved copy and clear staging. It uses genuine PixelGate 0.3.13 interface captures, stationary framing at a consistent scale, click highlights, and explicit Sender/Receiver labels. There are no zooms or pans within shots. The GIF is 960 × 640 at 10 fps; the MP4 is 20 fps at the same size.

The recording performs an actual direct WebRTC transfer of a generated 144,000-byte text file between two fresh Chromium profiles. It independently compares the downloaded file's Node SHA-256 with the source, reselects that downloaded file for the app's exported-copy verification, and clears eligible staging. It also checks that captured signaling contains neither the fixture filename nor its hash.

Pairing uses an isolated local PeerServer; the displayed demo code is never registered publicly and cannot be reused. STUN and browser mDNS masking are disabled only in the recording fixture to isolate the walkthrough from network discovery. Product connection settings are unchanged. No existing user profile or personal file is accessed.

Playback timing is edited for instruction, not a transfer-speed benchmark. Native operating-system pickers are omitted; the app's before/after states are shown. This recording does not certify mobile hardware, wake-lock behavior, native sharing targets, or large-session capacity.

With the production preview running as above:

```sh
node scripts/record-quick-start.mjs
```

The script asserts the workflow before rendering either format, then closes the browser, terminates the isolated broker, and removes temporary frames and downloaded fixtures. FFmpeg must be on `PATH`.

[Project overview](../../README.md) · [Architecture](../ARCHITECTURE.md)
