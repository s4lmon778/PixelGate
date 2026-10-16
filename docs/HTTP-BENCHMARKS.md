# HTTP/TCP versus original WebRTC: measured results

October 15, 2026. These are **single-Mac loopback measurements**, not iPhone → Pixel Wi-Fi results. The user's latest physical result for the previous version was approximately **3 MB/s**; device/browser versions, network details, source sizes and measurement scope were not supplied. That result is retained as a user-reported baseline only.

## Measured comparison

Original revision `cb5a570` (0.3.35) was exported with `git archive` and independently built under `/tmp/speedgate-baseline-cb5a570`. The candidate was SpeedGate 0.4.0's optional HTTP transport with default concurrency 2. Each variant used a fresh receiver profile, real Chromium, native transports, real source files, OPFS storage, source hashing and independent stored-file readback. The helper used HTTPS with a temporary test certificate, accepted only by isolated test contexts. TLS encryption remained enabled. Baseline WebRTC retained its normal encrypted data channels. External STUN was removed from both fixtures to keep the routing local.

Each dataset ran three trials per variant, alternating which variant ran first. Environment: Apple M4, arm64, ten logical CPUs, macOS, Node 22.22.2. No network latency, rate limit or packet loss was injected. End-to-end speed includes source hashing, transfer, staging and verification. Decimal MB/s is bytes / seconds / 1,000,000.

| Dataset                                         | Original WebRTC median | HTTP/TCP median | Interpretation                                            |
| ----------------------------------------------- | ---------------------: | --------------: | --------------------------------------------------------- |
| One 128 MiB + 111-byte file                     |             38.77 MB/s |      39.73 MB/s | About 2.5% faster on this host                            |
| 32 synthetic photo-sized originals, 4 MiB each  |             36.38 MB/s |      36.63 MB/s | About 0.7% faster; small difference relative to variation |
| Browser CPU seconds, large file                 |                12.36 s |          5.25 s | About 58% less aggregate browser CPU time                 |
| Browser CPU seconds, photo batch                |                12.23 s |          6.38 s | About 48% less aggregate browser CPU time                 |
| Aggregate sampled browser peak RSS, large file  |            1,074.5 MiB |     1,172.8 MiB | HTTP had higher sampled memory use                        |
| Aggregate sampled browser peak RSS, photo batch |            1,150.2 MiB |     1,266.8 MiB | HTTP had higher sampled memory use                        |

The HTTP helper adds CPU work outside the browser: median Node bridge/harness CPU was **1.87 s** for the large file and **2.07 s** for the batch, versus **0.058 s / 0.055 s** for the baseline harness. Median browser + Node/harness totals were **12.42 → 7.26 s** and **12.29 → 8.45 s**. These combine processes on this Mac, including test orchestration; they are not mobile power measurements.

**All 12 measured transfers passed independently computed SHA-256 and stored-length checks.** HTTP did not show a large throughput advantage in this setup. Reduced browser CPU is promising, but process RSS was higher and neither fact establishes better behavior on an older Pixel. No performance-dependent change was made to the browser-only WebRTC engine.

[Full per-trial measurements and connection reports](benchmarks/2026-10-15-http-comparison.json)

Browser CPU is the change in cumulative process CPU time reported by `ps` for both browser process trees. Peak RSS is a sum of RSS sampled every 250 ms, which can double-count shared pages and miss short peaks; it is not a count of application payload buffers or a strict memory cap. Bridge/harness CPU and RSS include Node, Playwright orchestration and process sampling. The raw record includes these metrics separately. Renderer processes that exit between samples can make CPU estimates incomplete. Fresh persistent receivers were used because ephemeral storage has different behavior.

An earlier 128 MiB attempt using an incognito receiver failed in the **original** OPFS checkpoint writer with “Browser storage rejected this checkpoint.” That failure was a storage issue, not evidence of a transport throughput advantage; it was retained in [the failed-run record](benchmarks/2026-10-15-incognito-storage-failure.json). The original fixture waited for success until its timeout. The comparison script now fails promptly on an explicit failed-file status and uses fresh regular receiving profiles. The host had ample disk space. It is not established that every browser's incognito mode fails at the same size.

## Integrity and interrupted recovery checks

The initial HTTP browser suite passed 12 scenarios across Chromium, Firefox and WebKit senders into Chromium receivers:

- 32 MiB + 111-byte original, Unicode filename, small photo bytes and empty file, with independent stored hashes and lengths.
- Both OPFS and IndexedDB staging, retained metadata and duplicate skipping only after receiver readback.
- 48 MiB interrupted upload, receiver refresh, fresh pairing, source reselection and exact durable-offset resume, followed by a complete stored hash comparison.
- Deliberately corrupted binary POST, which failed integrity verification and never produced a verified receipt.

These tests disable `RTCPeerConnection` entirely to establish that the HTTP route carries the transfer independently of WebRTC. They do not emulate physical iOS suspension, Android filesystem permissions, radios or thermal limits. A subsequent regular-profile HTTP test also sent a 400 MiB + 23-byte original, retained its modification timestamp, downloaded it, and compared every downloaded byte against the source in bounded Node buffers. Existing WebRTC 400 MiB OPFS and IndexedDB saving tests, 125-file saving, and cache/share checks also passed in the broader Chromium run. A further **5 GiB + 23-byte** HTTP transfer/download passed the same SHA-256, timestamp, length and complete byte-comparison checks in 114.4 seconds for the entire fixture, including source generation and download comparison ([executed record](benchmarks/2026-10-15-http-5gib-verification.json)). This is a correctness duration, not a transfer-throughput measurement. Physical-device acceptance remains separate.

## Reproduce

Build a preserved original revision separately and retain its source identity. Do not compare against a stale `dist` directory or a deployment with unknown provenance.

```sh
npm run build
SPEEDGATE_BASELINE_DIST=/path/to/original/dist \
SPEEDGATE_BASELINE_REVISION=cb5a570 \
SPEEDGATE_BENCH_TLS_KEY=/path/to/test-key.pem \
SPEEDGATE_BENCH_TLS_CERT=/path/to/test-cert.pem \
npm run bench:compare
```

Use temporary test-only TLS files. The benchmark's certificate acceptance is confined to Playwright; the application and helper do not bypass certificate checks. Omit both TLS paths for an explicitly unencrypted loopback comparison. Defaults: 128 MiB datasets, three repetitions; `SPEEDGATE_BENCH_MIB` accepts 32–512 and `SPEEDGATE_BENCH_REPETITIONS` accepts 1–10. `SPEEDGATE_BENCH_OUTPUT` selects the JSON output file. The script creates temporary synthetic sources and browser profiles and removes them after the run.

The optional large-file fixture defaults to 400 MiB; set `SPEEDGATE_HTTP_LARGE_MIB=5120` and select `--grep "large original"` to reproduce the greater-than-4-GiB check. It uses bounded source and comparison buffers and deletes its synthetic regular profile after closing it.

HTTP correctness suite:

```sh
npm run build
npx playwright test tests/browser/http-transfer.spec.ts --project=chromium --project=firefox --project=webkit
```

## Physical acceptance still needed

Use the same iPhone, Pixel, originals, Wi-Fi/hotspot, foreground state, screen-awake settings and storage backend for both variants. Record the reported ~3 MB/s baseline with precise versions and file counts/sizes, then compare at least three trials of a large original and a photo batch. Report both end-to-end verified throughput and time spent reading, sending, committing and hashing; record errors, recovery offsets and device memory/CPU with available platform tools. Compare HTTP concurrency 1, 2 and 4 without treating higher parallelism as inherently better. Keep source originals, independently verify saved outputs and test an interrupted transfer.

A helper on another Wi-Fi device adds a second network hop. A helper hosted on the Pixel changes setup and resource costs. Those results must be labeled separately from direct browser WebRTC and from Mac loopback measurements. No claim of improving the physical 3 MB/s baseline is made by this change.

Later diagnostic framing, periodic source-status publication, selector layout and helper packaging were verified separately; the original comparison JSON is retained unchanged as the performance record from the earlier 0.4.0 working build. Its HTTP `connections` field counted configured upload slots at that time; current diagnostics report one logical HTTP stream plus the explicit `parallelRequests` limit.
