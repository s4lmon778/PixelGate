# Validation record

## GitHub Pages edition · 0.3.2

Executed on **October 6, 2026**, with synthetic fixtures:

- TypeScript, ESLint, and the production static build pass.
- **70 unit/integration tests pass**: independent SHA-256, deliberate corruption, changed source content, durable checkpoint recovery, missing staged copies, duplicate/conflict handling, destination/export readback, denied access, quota exhaustion, safe/Unicode paths, 10,000 manifest paths, and 5 GB manifest sizes.
- Isolated local Git remotes verify first-time Pages publication, deployment history preservation, and rejection of uncommitted source.
- Serverless pairing tests cover bounded compression/decompression, invalid descriptions and extra fields, ten-minute expiry, wrong session responses, explicit approval, one-sender enforcement, immediate revocation, and copied offer/answer negotiation.
- **12 Playwright browser checks pass**, exercising a real **2 MiB + 111 byte** peer transfer, independent Node/Web Crypto source/staging hashes, batch download, reselected export verification, damaged export rejection, history after refresh, URL-fragment import in an already-open tab, invalid response rejection, mobile layout, and 200% text sizing.
- Request inspection checks that static hosting receives only GET asset/document requests and no pairing tokens, filenames, hashes, or file data. Code pairing exchanges signaling frames with PeerJS; copy/paste pairing makes no signaling-service connection.
- QR regression checks decode the displayed SVG using the independent `jsQR` decoder at desktop, enlarged-dialog, and 390 px mobile sizes. The decoded link is then used for the real peer transfer. Physical phone-camera scanning still requires device testing.

The GitHub Pages edition has no application database or media API. Default pairing uses PeerJS; copy/paste pairing remains available. Tests from the earlier Sites edition’s room service are not claims about this release.

Six-digit pairing tests cover cryptographic code sampling, leading zeroes, bounded collision retries, pre-approval media rejection, connection-bound approval, one-sender enforcement, code expiry, revocation, connection timeouts, and signaling disconnection after approval. Three browser scenarios use an isolated local PeerServer with real WebRTC, independently decode the short QR, transfer **1 MiB + 37 bytes**, independently hash staged bytes, and reject a consumed code. Captured signaling frames are bounded and contain no fixture filename or SHA-256.

The Chromium six-digit scenario also passes against the real public PeerJS service. A custom signaling build verifies that the configured HTTPS/WSS origin replaces the default signaling origin in the Content Security Policy.

## Browser environment

| Engine / device           | Version / setup                                                                                      | Result                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Chromium                  | Playwright Chromium 141.0.7390.37; normal privacy for code pairing; explicit LAN for manual fixtures | Transfer and layout checks         |
| Firefox                   | Playwright Firefox 142.0.1; normal privacy for code pairing; explicit LAN for manual fixtures        | Transfer and layout checks         |
| WebKit                    | Playwright WebKit 26.0 sender to Chromium receiver                                                   | Interoperability and layout checks |
| Native desktop Safari     | Not run                                                                                              | Pending                            |
| iPhone Safari             | Record actual iOS/browser versions                                                                   | Pending                            |
| First-generation Pixel XL | Record actual Android/Chrome versions                                                                | Pending                            |

Six-digit tests use normal browser host-address privacy, including WebKit-to-Chromium, and deliberately hold back answers/ICE candidates until the receiver approves: approval must become available before the route opens, and no transfer may start before it opens. The older manual-pairing fixtures use explicit LAN candidates; a separate run of Firefox manual pairing with normal mDNS privacy failed to open a direct channel. This limitation does not affect the six-digit regression results, but demonstrates why automated checks cannot certify all device/network combinations. `PIXELGATE_TEST_EXPLICIT_LAN=1` is an optional test diagnostic; production uses normal browser discovery. WebKit’s nonpersistent macOS test contexts do not provide reliable OPFS receiving, so this does not certify native Safari receiving.

## Required physical-device and capacity validation

A **5 GB manifest is not a 5 GB byte transfer**. A 10,000-path manifest test is not a completed 10,000-file media session. Automated tests do not certify 100 GB reliability or phone hardware.

On the actual Pixel XL and iPhone, record OS/browser versions and first check OPFS worker writes plus the available saving mode. Test JPEG, HEIC, PNG, MOV/MP4, embedded metadata, nested/Unicode folders, real files over 4 GB, and realistic large queues. Independently hash source and exported destination bytes outside the app.

Exercise screen lock, backgrounding, Wi-Fi loss, refresh and reselection, real storage exhaustion, denied/revoked folder access, exports and duplicate conflicts. Use realistic batches for 100 GB sessions and record quota, free space, elapsed time, throughput, failures, and independent hashes. First-generation Pixel storage may not accommodate 100 GB at once.

Google Photos validation is separate: confirm visibility, capture dates, GPS where present, video playback, folder backup configuration, and completed backup in Google Photos. Live Photo recognition and Apple original-resource retrieval are outside the browser guarantee.

Version 0.3.2 fixes approval being disabled during route negotiation, misleading sender approval instructions during connection attempts, and stale failed-room state. Consent-before-channel-open and failed-route cleanup have unit regressions. Cloudflare STUN has a Google STUN fallback; neither is a file relay. Physical iPhone Safari-to-Arc testing is still pending.

Version 0.3.2 adds a local route report with states, candidate counts, and bounded STUN error codes. Privacy tests ensure that SDP, addresses, peer identifiers, and error text are not retained or exported. A user test on iPhone Safari to Mac Arc and Mac Safari still times out with Arc local-network permission enabled; the cause is not identified, and this release is diagnostic rather than a claim that this physical-device failure is fixed.
