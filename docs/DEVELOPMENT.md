# Development and testing

Requires **Node.js 22.13+** and npm.

```sh
git clone https://github.com/s4lmon778/SpeedGate.git
cd SpeedGate
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
SPEEDGATE_TEST_CHROMIUM_EXECUTABLE="/path/to/Chromium" \
SPEEDGATE_TEST_PUBLIC_SIGNALING=1 \
npm run test:browser -- --project=chromium --grep compatibility
```

## Working with the repository

When both peers support 0.3.26 source status, the receiver's connection report
includes `transfer.source`: the sender's current wait stage, pause/visibility
state, outstanding bytes, receipt delays, replay count and session source-read
timings (transfer reads, excluding source hashing). `sampleAgeMs` is the
receiver's local time since the last sample; an old sample cannot identify the
sender's current state. Optional snapshots travel only over the paired direct
connection, at most every two seconds, with no filenames, addresses, hashes or
file bytes. Older peers keep the existing protocol without status messages.
`tests/browser/source-status.spec.ts` holds an actual source read, observes it
from the receiver, pauses/resumes and independently hashes the completed copy.

Large-source reads start at one MiB. After two consecutive pipeline waits of
at least 40 ms on a file of at least eight MiB, the sender reads four-MiB batches
and sends the same one-MiB checkpoints. Current/prefetched source batches retain
at most eight MiB; receiver/network credit stays unchanged. `sourceReads.waitedMs`
measures actual demand waits, whereas `averageMs` measures completed native read
duration (including prefetch). A slow read hidden behind network work does not
enable batching. Source errors and short reads retain durable prefixes.
`SPEEDGATE_TEST_APP_VERSION` pins the expected report version when running the
connection fixture against an actual preserved release.

With 0.3.27 peers, `transfer.source.batch` on the receiver records the sender's
Send invocation through its verified batch outcome. `wallElapsedMs` includes
source preparation, connection warmup, intentional pauses and final verification;
it stops at completion. `payloadBytesSent` counts newly transmitted logical
payload, excluding transport replays. `resumedBytes` and `skippedBytes` identify
previously staged prefixes and existing verified copies. Use a single fresh
file with `phase: verified`, no resumed/skipped bytes, and matching requested
and sent bytes for a comparable whole-transfer timing. Route `elapsedSeconds`
remains connection lifetime and must not be used as file duration. Final timing
is pushed and retained immediately, without waiting for the ordinary two-second
sample interval, and survives a receiver refresh. No names or hashes are shared.

For a controlled parallel-transfer comparison, run `npm run test:browser -- tests/browser/throughput.spec.ts --project=chromium` after building. It compares optional parallel transport with the raw single-connection protocol, delays durable ACKs by 150 ms, closes a bulk lane mid-transfer, rejects extra lane creation, drops a packet, delays one bulk lane, checks previous transport capabilities, and checks local transfers without added ACK delay. Each case independently hashes stored bytes. Timing spans first payload send through finish request and excludes setup, source hashing, and final readback; it is not a physical Wi-Fi benchmark. Measurements are attached as `checkpoint-throughput.json` in `test-results/`. `tests/browser/large-saving.spec.ts` defaults to 400 MiB synthetic transfers/downloads through persistent OPFS and compatibility storage, and a 125-file selection across fresh native taps and automatically continued downloads. `SPEEDGATE_TEST_LARGE_MIB=5120` selects a 5 GiB + 23-byte original generated and independently hashed in bounded blocks. `SPEEDGATE_TEST_ALL_ENGINES=1 --project=webkit` enables an actual WebKit sender. Add `SPEEDGATE_TEST_SAFARI_RECEIVER=1` for a separate WebKit receiver with its real storage fallback and actual downloaded-byte verification; use a size such as 768 MiB that fits the isolated context’s reported quota. This scenario does not substitute Android handoff or Photos folder APIs. Synthetic inputs and temporary receiver profiles are removed after each case. Save the attached JSON outside `test-results` before another Playwright run resets that directory. These are engine checks, not physical Android or Photos tests.

For actual-release latency comparisons, preserve an unmodified production `dist` at a second local URL. Set `SPEEDGATE_TEST_BASELINE_URL=http://127.0.0.1:8788 SPEEDGATE_TEST_MIB=64 SPEEDGATE_TEST_COMPARE_MODES=baseline-rtt-250,pipeline-rtt-250,baseline-rtt-500,pipeline-rtt-500` before the throughput command. Those modes delay application transport receipts and cumulative replies by 250/500 ms, with 150 ms durable-checkpoint reply delay; they do not emulate a complete radio network. `SPEEDGATE_TEST_ADAPTIVE_PATHS=1` checks equal, unequal, recovering, and shared bottlenecks. Keep both bundles fixed throughout a run. For both directions of old/new pairing, use `SPEEDGATE_TEST_MIXED_PEERS=1`; older 0.3.16 peers use the default 16 KiB expectation, while 0.3.17 peers need `SPEEDGATE_TEST_BASELINE_FRAME_BYTES=65528`. `SPEEDGATE_TEST_FAULT_MIB=16 SPEEDGATE_TEST_MIB=32 SPEEDGATE_TEST_COMPARE_MODES=closed-lane,lost-packet,slow-lane` moves injected failures beyond warmup to exercise an already enlarged window. The `pipeline-local` case also checks report retention after disconnect/reload, excludes fixture filenames, hashes and addresses, and verifies explicit cache clearing.

For native SCTP latency experiments, `npm run bench:native` routes every native UDP connection through local proxy sockets in isolated WebKit contexts and a fresh persistent Chromium receiver profile. Serve an immutable baseline and the candidate separately, then run them sequentially with identical settings:

```sh
SPEEDGATE_NATIVE_URL=http://127.0.0.1:8790/ \
SPEEDGATE_NATIVE_LABEL=baseline SPEEDGATE_NATIVE_MIB=400 \
SPEEDGATE_NATIVE_ONE_WAY_MS=8 SPEEDGATE_NATIVE_STORAGE_DELAY_MS=160 \
npm run bench:native
```

Repeat with the candidate URL and label. `SPEEDGATE_NATIVE_ONE_WAY_MS=100` gives approximately 200 ms native round-trip delay; use a smaller file such as 64 MiB for that case. The storage option delays notification after actual strict IndexedDB transaction completion; it does not weaken commits or represent Pixel CPU speed. `SPEEDGATE_NATIVE_RECEIVER_EXECUTABLE=/path/to/Chromium` checks an actual older engine. The script requires localhost, bounds files to 1–512 MiB, independently hashes received bytes, requires every open connection to be proxied, and writes a JSON record to a temporary directory (or `SPEEDGATE_NATIVE_RESULT`). It reports both first-payload-to-finish-request timing and Send-to-Verified timing. Synthetic source bytes, the temporary receiver profile and isolated browser contexts are removed afterward. Proxy candidate mapping is test-only and never changes product ICE behavior. Run these comparisons without concurrent browser suites or builds; even native latency models do not certify physical Wi-Fi speed.

Use `SPEEDGATE_NATIVE_RECEIVER_ENGINE=webkit` for a separate WebKit receiver context. Its natural durable backend may be IndexedDB in the desktop fixture, rather than the OPFS reported by an iPhone; record the actual backend and do not treat it as an iOS hardware reproduction. Chromium remains the default and supports the optional executable path. The loopback proxy learns native IPv4 endpoints from STUN packets on each fixture-mapped socket instead of assuming the first mDNS host candidate identifies a usable IPv4 endpoint. Once DTLS begins, the fixture pins that endpoint against later STUN checks from unused candidates. Sixteen proxy pairs cover the fourteen-connection pool. This alters only the isolated test proxy, never product ICE behavior.

For controlled loss, `SPEEDGATE_NATIVE_LOSS_PERMILLE=10` drops approximately 1% of encrypted application datagrams; `30` models 3%. Set `SPEEDGATE_NATIVE_LOSS_SEED` to the same unsigned 32-bit seed in each comparison and repeat across multiple seeds. This affects the local UDP proxy, not the product. `SPEEDGATE_NATIVE_SOURCE_READ_DELAY_MS` delays source-page Blob reads; hashing workers are unaffected. `SPEEDGATE_NATIVE_SOURCE_CPU=6` uses a Chromium sender with CDP CPU throttling, a separate synthetic control rather than a Safari/iPhone measurement.

Set `SPEEDGATE_NATIVE_LINK_BYTES_PER_SECOND=6291456` to serialize all proxied traffic across one synthetic 6 MiB/s medium, including return packets and every parallel connection. Zero disables this capacity model; accepted nonzero rates are 1 MiB/s–1 GiB/s. Combine it with latency, seeded loss and storage-delay controls to test shared congestion rather than assuming each connection gets independent bandwidth. The result records the configured capacity. This is not a physical Wi-Fi model or a claim about its usable speed.

Use `SPEEDGATE_NATIVE_DIRECT=1` with zero proxy latency/loss/capacity for a direct native control. The test-only candidate mapper uses the observed local interface and original endpoint ports; no packets traverse the proxy. The record distinguishes mapped connections from proxied connections and asserts zero proxy traffic. These local direct transfers also do not certify phone hardware or Wi-Fi. Never run these comparisons alongside builds or other browser suites.

React components and appearance logic live in `src/`; the transfer engine, persistence, hashing workers, and protocol types live in `lib/bridge/`. Unit/integration fixtures live in `tests/`, and real browser fixtures live in `tests/browser/`. Production output, browser reports, dependencies, and environment files are ignored.

Use synthetic files for debugging. Changes to integrity, persistence, pairing, or recovery should include independent readback or fault-injection evidence. Record actual device versions and measurements separately from browser-engine tests.

[Contributing](../CONTRIBUTING.md) · [Engineering decisions](ENGINEERING.md) · [Deployment](DEPLOYMENT.md)

For same-host throughput and source-status browser fixtures,
`SPEEDGATE_TEST_HOST_ONLY=1` removes external STUN discovery through an isolated
native-constructor wrapper. Real host ICE, SCTP, data channels, stored-byte
hashing and all assertions remain. Production ICE configuration is unchanged;
this mode does not validate NAT traversal or physical Wi-Fi performance.

For asymmetric native-path experiments, set `SPEEDGATE_NATIVE_SLOW_PATHS`
(0–13), `SPEEDGATE_NATIVE_SLOW_PATH_START` (default 1, leaving the primary path
unchanged), and `SPEEDGATE_NATIVE_SLOW_PATH_MS` (0–1000 extra milliseconds in
each direction). The total selected path range must fit fourteen connections.
All connections still share the same configured link capacity. Direct mode
rejects added delays. When `SPEEDGATE_NATIVE_RESULT` is provided, a failed run
also saves a `.failure.json` with isolated-fixture states before cleanup. These
controls change the developer proxy only, not the production ICE selection.

For a slower receiver main-thread control, `SPEEDGATE_NATIVE_RECEIVER_CPU=4`
uses CDP CPU throttling on the Chromium receiver only. Workers and the physical
radio are not throttled; this is not Pixel hardware emulation. Values 1–20 are
accepted; WebKit receiver runs reject a value above 1. The result records the
configured factor. `SPEEDGATE_NATIVE_PAYLOAD_LIMIT=5`, `7`, or `14` selects the new
sender-side diagnostic control before the synthetic transfer. The automatic
setting starts phone pairs with five connections and computers with up to fourteen, and retains its long-route
guard. A smaller active pool is an experiment, not an assumed improvement.

`tests/browser/network-tests.spec.ts` checks no automatic internet requests,
exact bounded dummy downloads, cancellation, repeated peer tests at five and
seven paths, no staged probe files, and a subsequent independently hashed
original download. It mocks the internet provider for deterministic checks;
a separate live smoke check verifies the real endpoint. Peer probes require
capability negotiation on both devices and never enter the file protocol.

`SPEEDGATE_NATIVE_PHONE=1` applies fixed iPhone/Pixel user agents to the WebKit
sender and Chromium receiver so the native fixture exercises the phone default.
It does not emulate phone hardware, its operating system, or its Wi-Fi radio.
The CLI still verifies all mapped native connections and independently hashes
the stored copy. Pair preserved builds using identical file size, capacity,
delays and seeded loss; alternate execution order and keep builds fixed.
