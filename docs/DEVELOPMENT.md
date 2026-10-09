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

For a controlled parallel-transfer comparison, run `npm run test:browser -- tests/browser/throughput.spec.ts --project=chromium` after building. It compares optional parallel transport with the raw single-connection protocol, delays durable ACKs by 150 ms, closes a bulk lane mid-transfer, rejects extra lane creation, drops a packet, delays one bulk lane, checks previous transport capabilities, and checks local transfers without added ACK delay. Each case independently hashes stored bytes. Timing spans first payload send through finish request and excludes setup, source hashing, and final readback; it is not a physical Wi-Fi benchmark. Measurements are attached as `checkpoint-throughput.json` in `test-results/`. `tests/browser/large-saving.spec.ts` defaults to 400 MiB synthetic transfers/downloads through persistent OPFS and compatibility storage, and a 125-file selection across fresh native taps and automatically continued downloads. `PIXELGATE_TEST_LARGE_MIB=5120` selects a 5 GiB + 23-byte original generated and independently hashed in bounded blocks. `PIXELGATE_TEST_ALL_ENGINES=1 --project=webkit` enables an actual WebKit sender. Add `PIXELGATE_TEST_SAFARI_RECEIVER=1` for a separate WebKit receiver with its real storage fallback and actual downloaded-byte verification; use a size such as 768 MiB that fits the isolated context’s reported quota. This scenario does not substitute Android handoff or Photos folder APIs. Synthetic inputs and temporary receiver profiles are removed after each case. Save the attached JSON outside `test-results` before another Playwright run resets that directory. These are engine checks, not physical Android or Photos tests.

For actual-release latency comparisons, preserve an unmodified production `dist` at a second local URL. Set `PIXELGATE_TEST_BASELINE_URL=http://127.0.0.1:8788 PIXELGATE_TEST_MIB=64 PIXELGATE_TEST_COMPARE_MODES=baseline-rtt-250,pipeline-rtt-250,baseline-rtt-500,pipeline-rtt-500` before the throughput command. Those modes delay application transport receipts and cumulative replies by 250/500 ms, with 150 ms durable-checkpoint reply delay; they do not emulate a complete radio network. `PIXELGATE_TEST_ADAPTIVE_PATHS=1` checks equal, unequal, recovering, and shared bottlenecks. Keep both bundles fixed throughout a run. For both directions of old/new pairing, use `PIXELGATE_TEST_MIXED_PEERS=1`; older 0.3.16 peers use the default 16 KiB expectation, while 0.3.17 peers need `PIXELGATE_TEST_BASELINE_FRAME_BYTES=65528`. `PIXELGATE_TEST_FAULT_MIB=16 PIXELGATE_TEST_MIB=32 PIXELGATE_TEST_COMPARE_MODES=closed-lane,lost-packet,slow-lane` moves injected failures beyond warmup to exercise an already enlarged window. The `pipeline-local` case also checks report retention after disconnect/reload, excludes fixture filenames, hashes and addresses, and verifies explicit cache clearing.

React components and appearance logic live in `src/`; the transfer engine, persistence, hashing workers, and protocol types live in `lib/bridge/`. Unit/integration fixtures live in `tests/`, and real browser fixtures live in `tests/browser/`. Production output, browser reports, dependencies, and environment files are ignored.

Use synthetic files for debugging. Changes to integrity, persistence, pairing, or recovery should include independent readback or fault-injection evidence. Record actual device versions and measurements separately from browser-engine tests.

[Contributing](../CONTRIBUTING.md) · [Engineering decisions](ENGINEERING.md) · [Deployment](DEPLOYMENT.md)
