# Browser transfer speed · 0.3.36

The latest saving, history, wake-lock, diagnostics, integrity, duplicate detection
and resumable-transfer features remain. There is no HTTP helper or native app.

## Recovered physical reference

The work log identifies **both phones on 0.3.28** for the earlier iPhone → Pixel
report: approximately 5 MB/s on screen, peaking at 5.2 MB/s. Its retained batch
contains 421,259,466 bytes and 92,092 ms from Send to Verified: **4.57 decimal
MB/s** including preparation and verification. The later approximately 3 MB/s
report is not a controlled same-file comparison. See the October 13 / 0.3.30
section of [the work log](PERFORMANCE_WORKLOG.md).

## Retained changes

- Updated phone pairs start with **five actual connections**, matching that
  physical reference. Computers keep the wider pool. The full protocol limit is
  still advertised, so older peers remain compatible and a sender can explicitly
  expand to seven or fourteen connections in diagnostics between transfers.
  Automatic restores the five-path payload budget for phones. Previously opened
  connections remain available until this connection is revoked.
- Setup and file preparation use the requested pool size. They do not wait for
  unused possible lanes or recreate existing connections when a limit changes.
- The per-frame scheduler walks its rotating order without allocating temporary
  path/rate arrays or repeatedly reading the winning queue. Its tie order,
  learned weights, five-percent hysteresis and idle-path probing remain.
- Durable storage ACKs, receipt/replay timing, memory/window limits, frame
  negotiation, independent SHA-256 readback and resume offsets stay intact.

These defaults prioritize the available physical phone evidence. They do not
establish that five connections are universally faster. In these desktop-engine
models, the fourteen-connection reference wins some conditions; that option
remains available rather than being removed.

## Matched browser-engine comparison

All copies use original synthetic bytes, native WebRTC data channels and fresh
receiving profiles. In the final phone-budget comparison, WebKit sends and Chromium receives. Fixed phone user agents
select the phone policy; they **do not emulate iOS, Android hardware or Wi-Fi**.
A loopback UDP proxy applies one shared capacity to every connection and return
packet, validates that every connection is mapped, and can apply seeded loss.
Every completed copy passes a separate stored-byte SHA-256 comparison.

The table reports decimal MB/s from Send to Verified. Rows one through three
are medians of three alternating 0.3.28 / 0.3.36 pairs. The fourteen-connection
0.3.35 reference has one contextual run per row and is not a repeated median.
The 400 MiB row has one copy per version, so it is a sustained control rather
than a statistical speed claim.

| Model                                                                                            | 0.3.28, five connections | 0.3.36, five connections | 0.3.35, fourteen connections |
| ------------------------------------------------------------------------------------------------ | -----------------------: | -----------------------: | ---------------------------: |
| 64 MiB, shared 6 MiB/s, 10 ms each way                                                           |                     4.44 |                     4.71 |                         5.30 |
| 64 MiB, Chromium 101, main-thread factor four, 150 ms strict-IDB completion delay, 5 ms each way |                     5.12 |                     5.21 |                         5.21 |
| 64 MiB, shared 6 MiB/s, 10 ms each way, 1% seeded datagram loss                                  |                     2.68 |                     2.77 |                         4.82 |
| 400 MiB, shared 12 MiB/s, 10 ms each way                                                         |                     5.81 |                     5.96 |                         9.54 |

The repeated five-connection comparisons improve completion throughput by
**6.14%, 1.70% and 3.11%** respectively against 0.3.28. All 24 final comparison
copies verify. These results **do not prove an improvement on the physical
phone pair or prove 0.3.36 is the fastest possible configuration**.

The isolated Node/V8 scheduler check makes the same 20,000 decisions as the
previous implementation, then alternates six timed pairs of 300,000 choices
across fourteen paths. Median time falls from about 88.95 ms to 41.39 ms. This is
a scheduler-kernel measurement, not whole-app CPU, memory or phone throughput.
The earlier matched transfer trials of the scheduler alone show small/mixed
completion-time differences; they are not described as a major speed gain.

## Rejected experiment

Batching up to sixteen transport receipts with an eight-ms tail timer helped
the seeded-loss model, but the single long-route control slowed from 31,835 to
33,930 ms and the 400 MiB control from 43,718 to 44,592 ms. That experiment is
not shipped. The original four-receipt / 25-ms policy remains. An intermediate
hard-cap phone experiment was replaced before completion so explicit wider
connection controls remain usable; its partial timings are excluded.

[The numeric record](benchmarks/2026-10-16-browser-speed-research.json) retains
70 completed byte-verified native trials, including rejected experiments,
individual timings, all connection mappings and the scheduler check. No new
physical throughput, mobile CPU/memory, radio capacity or thermal claim is made.

## Reproduce and compare

Serve the actual preserved release bundles at separate localhost ports and run
`scripts/benchmark-native-transfer.mjs` against each using the same
`SPEEDGATE_NATIVE_*` settings; use `SPEEDGATE_NATIVE_PHONE=1` to select the phone
policy. [Developer controls](DEVELOPMENT.md) describe the bounded proxy.

The [unchanged 0.3.28 build](https://s4lmon778.github.io/SpeedGate/releases/0.3.28/)
and [0.3.35 build](https://s4lmon778.github.io/SpeedGate/releases/0.3.35/) remain
available for actual device comparisons. Use both peers on the same version,
the same original, foreground state, storage backend and network conditions.
A duplicate skip or resumed prefix is not a full-file speed result. Save any
needed originals before using the existing verified-staging cleanup; do not
clear history or unfinished checkpoints to measure speed. The peer-link probe
excludes source reads, hashing and storage, so its result is distinct from
file completion throughput.
