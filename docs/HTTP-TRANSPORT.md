# SpeedGate HTTP/TCP transport

SpeedGate 0.4.0 adds an optional local HTTP/TCP bridge. The public, browser-only iPhone → Pixel flow continues to use WebRTC. A web page, installed PWA, or service worker cannot listen for incoming LAN TCP connections. Downloading a temporary service does not grant it permission to execute. A native process must run the bridge; it can be stopped after a transfer, without installing a SpeedGate app on either phone.

## Choose a mode

| Mode                                     | What runs                                      | File route                                              | Setup                                              |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Browser-only (default on static hosting) | A browser on each device                       | Encrypted WebRTC directly between devices               | Open the existing HTTPS site, pair, approve        |
| Local HTTP/TCP                           | Both browsers plus one Node process on the LAN | Browser → trusted LAN helper → browser, using HTTPS/TCP | Open the same HTTPS helper address on both devices |

The helper can run on a PC/Mac, or on Android in an already provisioned Node environment such as Termux. iPhone Safari cannot run it. Running the helper on a separate PC creates two network legs and can consume extra Wi-Fi airtime. No physical iPhone/Pixel speed improvement is established by a loopback benchmark.

## Temporary helper

The optional helper can be packaged as a temporary ZIP:

```sh
npm run package:helper
```

This creates `release/SpeedGate-helper-0.4.0.zip` with the built browser app, plain JavaScript server/launcher, licenses and instructions. Extract it on a machine with an existing **Node 22.13+** runtime and run `node scripts/serve-lan.mjs` with the TLS variables below. **No npm install, repository checkout or TypeScript loader is needed inside the extracted bundle.** The helper still needs a process to launch it and a browser-trusted certificate; downloading the ZIP does not let a page run it automatically.

Alternatively, build and run directly from the checkout using existing dependencies. No new runtime dependency is introduced:

```sh
npm ci                 # only if dependencies are not already present
npm run build
SPEEDGATE_TLS_KEY=/path/to/private-key.pem \
SPEEDGATE_TLS_CERT=/path/to/certificate-chain.pem \
npm run serve:lan
```

Use a certificate covering the helper's LAN hostname or IP, issued by a CA trusted by **both** browsers. A private CA needs to be provisioned and trusted on each device; Safari on iOS requires enabling full trust for a manually installed root. A bare self-signed certificate or clicking through an error is not a dependable secure-context setup. SpeedGate does not install certificates, disable browser security, or run a downloaded executable automatically.

The command prints the local addresses. Open the **same address, including scheme and port**, on both browsers. The app discovers its same-origin bridge and selects **Local HTTP/TCP** unless a pairing link or an explicit choice selected WebRTC. Generated links include the selected transport, so both modes remain usable from the helper address. Choose Receive on the Pixel, create a six-digit code, enter it on the iPhone, and approve on the Pixel. File selection, progress, pause/resume/cancel, saving, duplicates and verification use the existing interface. Under Connection diagnostics, the sender can select 1–4 HTTP upload requests. Start with the default 2 on older Pixels.

Stop the helper with Ctrl+C after saving. The helper never writes file payloads to its disk. Received originals and resume checkpoints reside in the receiving browser as before. This is temporary execution of a service, not a browser-only HTTP server.

For **loopback development only**, `npm run serve:lan` without TLS binds `127.0.0.1`. It rejects plain HTTP LAN access, which cannot use SpeedGate's secure-context hashing and storage reliably. Use `npm run dev` / `npm start` for the static WebRTC app; neither starts the bridge.

Configuration:

| Variable                                  | Default                                         | Meaning                                                                    |
| ----------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `SPEEDGATE_TLS_KEY`, `SPEEDGATE_TLS_CERT` | unset                                           | PEM key and chain; both required together                                  |
| `SPEEDGATE_HOST`                          | `0.0.0.0` with TLS, otherwise `127.0.0.1`       | Listening interface                                                        |
| `SPEEDGATE_PORT`                          | `8787`                                          | Listening port                                                             |
| `SPEEDGATE_ALLOWED_HOSTS`                 | localhost and current local interface addresses | Additional comma-separated hostnames, without scheme or port               |
| `SPEEDGATE_BASE`                          | `./`                                            | Vite static build base; the helper serves its app at `/`                   |
| `VITE_SPEEDGATE_SIGNAL_URL`               | PeerJS public service                           | WebRTC pairing only; previous `VITE_PIXELGATE_SIGNAL_URL` remains an alias |

Use the root build (`SPEEDGATE_BASE=./`) for the helper. It is intended for a trusted LAN, without an Internet-facing reverse proxy. It does not implement the LocalSend API and cannot pair with native LocalSend clients.

## Streaming and recovery

The existing file protocol sits above a new `HttpChannel`. Its manifests, path validation, hash workers, storage workers, durable checkpoint ordering, independent readback, duplicate detection, and saved-copy scopes remain unchanged.

1. A receiver requests a room and a random six-digit code. Each participant receives a separate 256-bit bearer token; the code alone cannot approve or transfer files. Approval belongs to the receiver. Codes expire after ten minutes and accept one sender.
2. Each approved browser opens a persistent streaming GET. Controls and binary frames travel through bounded concurrent POSTs in the opposite direction. Every POST has a session-relative sequence number; the helper streams it in order, even if concurrent requests arrive in a different order.
3. Binary POSTs contain up to **1 MiB**. They use `Uint8Array` bodies, not base64, multipart parsing, whole-file buffers, or browser request `ReadableStream`s. This works with Safari, which has different request-streaming support from Chromium. The helper adds a five-byte type/length header on the receiving stream. Diagnostics use a separate binary frame kind so cancelled speed-test bytes can never enter file staging. Control messages are limited to 12,000 UTF-8 bytes.
4. The helper pauses out-of-order requests and forwards the next body using Node response backpressure. It never collects a complete file or payload body. Queued sequence slots, active rooms, pairing attempts, connections and client queues are bounded. Browser/OS networking adds its own buffers; JavaScript bounds do not claim to cap total process RSS.
5. The existing sender remains one file at a time, with hashing one file ahead. Parallelism is **1–4 HTTP requests within the file**, rather than simultaneous file writers. This retains the receiver's storage ordering and keeps older devices from running multiple hash/write pipelines. The default is two requests, with a four-MiB durable receive window and the existing one-MiB checkpoints.
6. A successful POST means network forwarding completed. It never counts as a durable checkpoint or verified copy. The existing receiver sends ACK only after staging and manifest commit, then closes/rereads/hashes the completed file before reporting success. Destination files retain their separate verification scope.
7. HTTP reports label queued request bytes separately from file progress. Source stages refresh every two seconds without a server-state poll; SCTP receipt delays and ICE latency are not presented as HTTP measurements.
8. A failed or uncertain POST is **not blindly replayed**. Stream closure revokes both endpoints, aborts pending requests, and leaves durable receiving checkpoints intact. Recreate the connection, reselect/rehash the same original and resume from the receiver-owned offset. Any uncommitted tail is truncated by existing storage recovery.

File offsets and sizes remain safe JavaScript integers; transport framing uses 32-bit lengths only for individual bounded messages. Embedded metadata is preserved by retaining every file byte. Picker-provided names, relative paths, MIME type and modification time remain in manifests/reports. Browsers still cannot restore arbitrary filesystem timestamps, retrieve unavailable iCloud originals or preserve unsupplied Live Photo components.

## Trust and browser restrictions

HTTPS terminates at the helper. It can observe file bytes, paths, hashes and controls in memory while forwarding them. This mode has a different trust boundary from direct end-to-end encrypted WebRTC. The helper does not log payloads or persist them, and its API exposes no saved files. Six-digit codes are temporary lookup, not device identity authentication; approve only the intended device on a trusted LAN.

Both devices load the app and API from one origin, avoiding mixed-content fetches from a public HTTPS page to an HTTP LAN address, unrestricted CORS, address probing and cross-origin local-network permission problems. Host/Origin checks and bearer authorization restrict access; there is no wildcard CORS or certificate bypass. Browsers must remain open and foregrounded. Network isolation, browser storage quotas, permissions and OS suspension still apply.

## Storage and rebrand compatibility

Public UI, package metadata and active configuration use **SpeedGate**. Existing IndexedDB names (`pixelbridge-v1`, `pixelgate-staging-v1`), OPFS directory (`pixelbridge`), preference/report keys, lock names, picker identifiers, and legacy WebRTC wire labels are deliberately stable. Existing preferences, receipts, duplicate identities and resume data stay readable **on the same origin**. Old environment configuration aliases remain supported.

A different helper origin has separate browser storage. Moving from the public site to a helper, changing its hostname/port, or renaming a Pages path does **not** migrate browser data. Existing files remain at the old origin; save/export them there first. The GitHub repository and published URLs remain their actual existing `PixelGate` addresses until renamed by the owner. Historical measurement JSON remains unchanged; current interface recordings and screenshots were refreshed for SpeedGate 0.4.0.

See [LocalSend research](LOCALSEND-RESEARCH.md) and [measured comparison](HTTP-BENCHMARKS.md).
