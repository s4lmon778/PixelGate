# Development and testing

Requires **Node.js 22.13+** and npm.

```sh
git clone https://github.com/s4lmon778/PixelGate.git
cd PixelGate
npm ci
npm run dev
```

Open `http://127.0.0.1:8787`. Use separate browser profiles for sender and receiver tests.

| Command                | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `npm run check`        | TypeScript, ESLint, and unit/integration tests     |
| `npm run build`        | Production static build                            |
| `npm run test:browser` | Real peer transfers and browser integration checks |
| `npm start`            | Serve the production build locally                 |
| `npm run format:check` | Check repository formatting                        |

Install browser binaries with `npx playwright install chromium firefox webkit` before browser tests. Playwright starts a production preview when needed; build first. Automated six-digit connection fixtures use an isolated PeerServer and normal browser privacy defaults. Manual-pairing and compatibility-storage fixtures expose LAN candidates to separate persistence tests from mDNS discovery. Those test settings do not certify native browser networking.

An existing older Chromium executable can be selected for compatibility checks. With public signaling, the pairing fixture retains normal host-address privacy and tests the browser's real storage capabilities rather than disabling OPFS artificially:

```sh
PIXELGATE_TEST_CHROMIUM_EXECUTABLE="/path/to/Chromium" \
PIXELGATE_TEST_PUBLIC_SIGNALING=1 \
npm run test:browser -- --project=chromium --grep compatibility
```

## Working with the repository

For a controlled parallel-transfer comparison, run `npm run test:browser -- tests/browser/throughput.spec.ts --project=chromium` after building. It compares optional parallel transport with the raw single-connection protocol, delays durable ACKs by 150 ms, closes a bulk lane mid-transfer, rejects extra lane creation, and checks local transfers without added ACK delay. Each case independently hashes stored bytes. Timing spans first payload send through finish request and excludes setup, source hashing, and final readback; it is not a physical Wi-Fi benchmark. Measurements are attached as `checkpoint-throughput.json` in `test-results/`.

React components and appearance logic live in `src/`; the transfer engine, persistence, hashing workers, and protocol types live in `lib/bridge/`. Unit/integration fixtures live in `tests/`, and real browser fixtures live in `tests/browser/`. Production output, browser reports, dependencies, and environment files are ignored.

Use synthetic files for debugging. Changes to integrity, persistence, pairing, or recovery should include independent readback or fault-injection evidence. Record actual device versions and measurements separately from browser-engine tests.

[Contributing](../CONTRIBUTING.md) · [Engineering decisions](ENGINEERING.md) · [Deployment](DEPLOYMENT.md)
