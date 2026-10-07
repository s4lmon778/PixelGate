# README visuals

| Asset               | Purpose                                                    | Source                                                     |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `logo.svg`          | Project mark                                               | Local SVG artwork                                          |
| `controls-demo.gif` | Screen-awake preference animation and Light/Dark selection | Recorded from PixelGate 0.3.13 in a fresh Chromium profile |
| `transfer-flow.svg` | Direct WebRTC payload route and separate PeerJS signaling  | Local SVG diagram, based on the architecture reference     |
| `desktop.png`       | Desktop Send interface                                     | Production preview with an empty queue                     |
| `mobile.png`        | Mobile receiving/saving controls                           | Production preview at 390 pixels in WebKit                 |
| `awake-switch.png`  | Screen-awake control close-up                              | Production preview at 390 pixels in WebKit                 |

The GIF demonstrates interface controls. No pairing room, media transfer, device wake-lock measurement, or throughput benchmark is recorded. Its status remains “Ready” because no connection is active. All assets are stored in this repository.

## Reproduce the GIF

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

[Project overview](../../README.md) · [Architecture](../ARCHITECTURE.md)
