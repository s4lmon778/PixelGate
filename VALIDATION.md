# Validation record

## GitHub Pages edition · 0.2.1

Executed on **October 6, 2026**, with synthetic fixtures:

- TypeScript, ESLint, and the production static build pass.
- **56 unit/integration tests pass**: independent SHA-256, deliberate corruption, changed source content, durable checkpoint recovery, missing staged copies, duplicate/conflict handling, destination/export readback, denied access, quota exhaustion, safe/Unicode paths, 10,000 manifest paths, and 5 GB manifest sizes.
- Isolated local Git remotes verify first-time Pages publication, deployment history preservation, and rejection of uncommitted source.
- Serverless pairing tests cover bounded compression/decompression, invalid descriptions and extra fields, ten-minute expiry, wrong session responses, explicit approval, one-sender enforcement, immediate revocation, and copied offer/answer negotiation.
- **9 Playwright browser checks pass**, exercising a real **2 MiB + 111 byte** peer transfer, independent Node/Web Crypto source/staging hashes, batch download, reselected export verification, damaged export rejection, history after refresh, URL-fragment import in an already-open tab, invalid response rejection, mobile layout, and 200% text sizing.
- Request inspection checks that static hosting receives only GET asset/document requests and no application signaling calls, pairing tokens, filenames, hashes, or file data.
- QR regression checks decode the displayed SVG using the independent `jsQR` decoder at desktop, enlarged-dialog, and 390 px mobile sizes. The decoded link is then used for the real peer transfer. Physical phone-camera scanning still requires device testing.

The GitHub Pages edition has no pairing API or cloud database. Tests from the earlier Sites edition’s room service are not claims about this release.

## Browser environment

| Engine / device           | Version / setup                                                                 | Result                             |
| ------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| Chromium                  | Playwright Chromium 141.0.7390.37; explicit LAN candidates in headless tests    | Transfer and layout checks         |
| Firefox                   | Playwright Firefox 142.0.1; host-address obfuscation disabled in headless tests | Transfer and layout checks         |
| WebKit                    | Playwright WebKit 26.0 sender to Chromium receiver                              | Interoperability and layout checks |
| Native desktop Safari     | Not run                                                                         | Pending                            |
| iPhone Safari             | Record actual iOS/browser versions                                              | Pending                            |
| First-generation Pixel XL | Record actual Android/Chrome versions                                           | Pending                            |

Headless discovery exposes LAN IP candidates because mDNS discovery in this environment is unreliable. Production uses normal browser discovery and reports direct-connection failures. The Chromium receiver used with WebKit also exposes LAN candidates. WebKit’s nonpersistent macOS test contexts do not provide reliable OPFS receiving, so this does not certify native Safari receiving.

## Required physical-device and capacity validation

A **5 GB manifest is not a 5 GB byte transfer**. A 10,000-path manifest test is not a completed 10,000-file media session. Automated tests do not certify 100 GB reliability or phone hardware.

On the actual Pixel XL and iPhone, record OS/browser versions and first check OPFS worker writes plus the available saving mode. Test JPEG, HEIC, PNG, MOV/MP4, embedded metadata, nested/Unicode folders, real files over 4 GB, and realistic large queues. Independently hash source and exported destination bytes outside the app.

Exercise screen lock, backgrounding, Wi-Fi loss, refresh and reselection, real storage exhaustion, denied/revoked folder access, exports and duplicate conflicts. Use realistic batches for 100 GB sessions and record quota, free space, elapsed time, throughput, failures, and independent hashes. First-generation Pixel storage may not accommodate 100 GB at once.

Google Photos validation is separate: confirm visibility, capture dates, GPS where present, video playback, folder backup configuration, and completed backup in Google Photos. Live Photo recognition and Apple original-resource retrieval are outside the browser guarantee.
