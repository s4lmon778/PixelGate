# PixelGate performance and cache work · October 11, 2026

## Requested outcome

Fix saved transfer cache cleanup and improve the user's iPhone-to-Pixel Wi-Fi
transfer speed by at least 50%, preserving original bytes, independent readback,
resume, compatibility storage, and existing saving and interface features.

The reported baseline is about 1.5 MB/s average, a 2.2 MB/s late peak, and an
initial six-minute estimate for an approximately 400 MB, four-minute video.
The elapsed time until Verified, exact units, app version, and connection report
are requested. A 50% increase from 1.5 MB/s means 2.25 MB/s under the same
conditions. A local browser benchmark does not establish that hardware result.

## Continuation

The thread heartbeat `pixelgate-speed-and-cache-follow-up` is active every five
hours. Continue useful work after usage resets. Preserve the completed interface/cache work, now committed and published in
0.3.22 (`0c4900d`). Do not declare the speed target achieved without a physical-device result.
Record each retained or rejected experiment and its measured conditions here.

## Starting state

- Main HEAD: `3f735c6`; local source and production bundle: 0.3.21.
- Public `build.json` still reports 0.3.20 and source `3f735c6` as of this run.
  Publication of 0.3.21 was awaiting the user's choice. This version difference
  can explain the older cache button only clearing independently verified saves.
- Immutable 0.3.21 source and built assets preserved under
  `/tmp/pixelgate-speed-20261011/baseline`, served on localhost port 8790.
- The public baseline has five SCTP connections, bounded four-MiB checkpoint
  credit, independent staged SHA-256 readback, strict IndexedDB writes, and
  recoverable one-MiB checkpoints.
- Bluetooth is unavailable as a browser-to-browser path on this device pair:
  WebKit does not expose Web Bluetooth, and Chrome's API acts as a BLE central
  connecting to GATT peripherals. No Bluetooth control is added.

## Experiments and outstanding evidence

Baseline WebKit-to-Chromium trials are running with unchanged 0.3.21 assets,
including normal local transfers, 500 ms injected transport-receipt delay, and
100 ms delayed notification of real strict IndexedDB commits. Every completed
fixture is independently hashed. The first attempted suite lost access to the
stopped 8787 preview after one baseline run; the preview was restarted and the
suite rerun. That incomplete attempt is excluded from comparisons.

Pending: reproduce cleanup on the Pixel's actual version, test real staged byte
counts and historical receipts, run controlled alternative transport builds,
and obtain physical-device timing for a measured candidate.

## Cache and timing fixes

The user confirmed the Pixel was running public **0.3.20**. A 0.3.22 cache and
timing update is being prepared independently of experimental transport builds.
The staged-byte count reads actual backend metadata, historical save controls
respect current cache availability, and the rate clock excludes pairing idle
time, source preparation, intentional pauses and resumed prefixes. None of these
display corrections count as a throughput gain. 185 unit cases and five cache
browser cases pass; WebKit's unavailable OPFS case is intentionally skipped.

## First controlled matrix

Each row compares identical marked 32 MiB + 111-byte files with independent
stored hashes. RTT delay below means application transport receipts delayed by
500 ms, not native SCTP latency. Storage delay is a 100 ms delayed callback after
real strict IndexedDB transactions; neither condition certifies phone hardware.

| Candidate                               | Local baseline / candidate (ms) | Receipt-delay baseline / candidate (ms) | Storage-delay baseline / candidate (ms) | Decision                                                       |
| --------------------------------------- | ------------------------------- | --------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Nine connections                        | 641 / 581                       | 7385 / 7372                             | 1919 / 1910                             | No meaningful gain under these models                          |
| Two connections                         | 592 / 570                       | 7390 / 10216                            | 1867 / 1862                             | Rejected: latency regression                                   |
| Always 16 KiB frames                    | 586 / 707                       | 7348 / 7278                             | 1867 / 1868                             | Rejected: no useful gain                                       |
| Always negotiated 64 KiB frames         | 591 / 536                       | 7364 / 7365                             | 1860 / 1839                             | No meaningful latency/storage gain                             |
| Larger, faster receipt batches          | 569 / 565                       | 7377 / 7369                             | 1861 / 1858                             | No meaningful gain                                             |
| Remove initial pacing delay             | 612 / 522                       | 7351 / 7364                             | 1862 / 1844                             | No meaningful latency/storage gain                             |
| Eight-MiB checkpoint window             | 595 / 579                       | 7337 / 6386                             | 1867 / 1012                             | Promising for storage; needs compatibility and device evidence |
| Eight-MiB window and transport credit   | 546 / 685                       | 7350 / 5795                             | 1860 / 1018                             | Local regression needs follow-up                               |
| Sixteen-MiB checkpoint window           | 561 / 534                       | 7359 / 6442                             | 1901 / 712                              | Promising for storage; isolated experiment only                |
| Sixteen-MiB window and transport credit | 543 / 517                       | 7373 / 4993                             | 1899 / 714                              | Promising; isolated experiment only                            |

The sixteen-MiB credit candidate is unchanged at a shared one-MiB/s bottleneck:
32,048 / 32,047 ms, roughly 345 / 350 KiB average queued, no replays, matching
stored bytes. Local sub-second timings need repeated larger-file runs before
treating small differences as improvements. Experimental constant increases are
not yet in product source; larger windows require explicit peer negotiation.

## Native latency fixture

`/tmp/pixelgate-speed-20261011/native-proxy-bench.mjs` routes native WebRTC UDP
datagrams through local proxy sockets, so SCTP itself experiences latency. The
fixture is still being validated. Its first attempts filtered WebKit's mDNS
candidate and could not pair; they are excluded. The next attempt maps that
test-only candidate to the same test machine's interface. No addresses, pairing
payloads or personal files are written to benchmark results.

The fixture now passes an all-path validation: five connections are proxied,
8 MiB + 111 bytes are independently hashed, and proxy wire totals exceed payload
bytes. The final interceptor is applied after the browser adapter initializes,
because that adapter replaces WebKit's event-handler wrapper. Earlier attempts
where only the primary connection was proxied are excluded. Native packet-delay
comparisons will run separately from the full regression suite to avoid resource
contention. The 0.3.22 cache/timing build passes the full 70 browser cases with 17
capability skips and actual Chromium 101's three targeted controls. The user
approved publishing 0.3.22 and instructed **always publish tested updates so they
can test them**. Continue honoring that authorization for this task's subsequent
validated releases; no repeated publication confirmation is needed.

## Pixel evidence

The restored five photographs are readable at their original Downloads paths.
They show 0.3.20 on Android 9 using IndexedDB, a completed 421,259,466-byte file,
401 storage commits, a final 780,490-byte batch taking 160 ms, and zero queued or
buffered bytes afterward. The last primary route is UDP host/prflx with 15 ms
RTT. Both STUN services have 701 errors. At the photographed time, the primary
route is disconnected/failed with its data channel still reported open, and
the transport counts one open connection. Its one remaining path counts only
90,640,944 bytes, while total delivered bytes correctly count the complete file.
The previously fixed closed-path diagnostic omission explains why the old
per-path totals cannot describe the whole transfer. Four-minute stage/frame idle
times are time since completion, not file transfer duration. Connection elapsed
time is 2,698 seconds, also not the file duration. None establishes average
in-transfer RTT or when the bulk lanes closed.

Next experiments should include realistic 160 ms storage commit notifications,
native packet latency, and restoring failed bulk lanes for subsequent files.

## Validated native latency experiments

All listed native trials have every connection proxied and independently matching
stored hashes. Timings below are first payload through finish request; Send to
Verified is separately captured. These are synthetic engine/proxy models.

- At 200 ms native RTT, a 32 MiB + 111-byte file took 17,536 ms on the baseline,
  19,998 ms with nine connections, 39,763 ms with forced large frames, 8,980 ms
  with forced small frames, and 19,059 ms with enlarged storage/network credit.
  Extra connections and unconditional large messages are rejected. Fragmented
  message size is a lead on this modeled link, not an established radio cause.
- A 64 MiB adaptive trial took 38,402 / 18,990 ms at 200 ms native RTT; its
  no-delay control took 1,423 / 1,787 ms. The version with a per-path rate floor
  was not retained; that floor delays large-frame warmup and is unnecessary.
- The latency-only adaptive follow-up took 12,353 ms at 200 ms native RTT.
  No-delay 64 MiB baseline / eight-MiB candidate / four-MiB candidate took
  1,554 / 1,723 / 1,565 ms, with Send-to-Verified times of 2,916 / 2,908 / 2,915
  ms. The final source retains the prior near-four-MiB network credit rather
  than expanding native queues.
- At 16 ms native RTT plus 160 ms strict IndexedDB completion notifications,
  400 MiB + 111 bytes took 34,688 / 17,462 ms, or 37,970 / 20,955 ms Send to
  Verified. Actual Chromium 101 took 33,294 / 17,191 ms, or 35,985 / 20,933 ms
  Send to Verified. The next final-build matrix compares against preserved
  published 0.3.22 assets rather than only the earlier 0.3.21 snapshot.

## Proposed 0.3.23 implementation

The bounded application window is eight MiB, explicitly advertised in the optional
`maxTransferWindowBytes` hello field. An older sender without that field receives
at most the old four-MiB window; a receiver without any window field still uses
one checkpoint. A single-connection fallback keeps its one-checkpoint limit.
Ready credit never exceeds the peer's supported cap. Stored chunks remain one
MiB and all acknowledgments still follow strict/flush completion plus manifest
commit. No database or persisted-file migration is required.

Frames remain 16 KiB on paths whose typical measured minimum receipt delay exceeds
40 ms, and can grow to negotiated 64 KiB on nearby healthy paths. Queue growth,
recovery, frame bounds and independent verification remain in force. Network
credit remains at its existing near-four-MiB limit. Connection reports add actual
receive-window size and average/maximum storage commit time. The reusable native
fixture is now `scripts/benchmark-native-transfer.mjs` and documented in the
Development guide. Publication remains authorized after final checks.

## Final build comparison against published 0.3.22

The preserved public 0.3.22 build and candidate transfer identical marked payloads
through every native proxy path. Successful results are independently hashed.

| Condition                                                                   | File          | 0.3.22 payload / Send-to-Verified (ms) | Candidate payload / Send-to-Verified (ms) |
| --------------------------------------------------------------------------- | ------------- | -------------------------------------- | ----------------------------------------- |
| 16 ms native RTT, 160 ms strict IndexedDB completion delay, modern Chromium | 400 MiB + 111 | 34,441 / 38,008                        | 18,002 / 20,923                           |
| Same condition, actual Chromium 101                                         | 400 MiB + 111 | 33,359 / 35,991                        | 17,436 / 20,962                           |
| 200 ms native RTT, ordinary OPFS                                            | 64 MiB + 111  | 29,197 / 31,036                        | 11,728 / 12,964                           |

The 400 MiB end-to-end ratios correspond to approximately 82% and 72% higher
throughput in these local delayed-storage models. No physical phone result has
yet established the requested 50% gain. Native no-delay controls, mixed actual
0.3.22 peers, shared bottlenecks and final browser regressions remain to finish.

## Fast-control failure investigation

A 128 MiB + 111-byte no-delay run initially failed on the actual 0.3.22 baseline.
The follow-up passed one baseline/candidate pair (2,791 / 3,048 ms payload,
3,671 / 3,909 ms Send to Verified), then failed both versions at the same
127-MiB durable prefix. All payload bytes reached the receiver; neither case
reported transport loss or replay. The final 1 MiB + 111-byte OPFS batch returned
an invalid native write count and was correctly blocked. These failed transfers
are excluded from speed comparisons. No storage guard was weakened.

This occurred in fresh nonpersistent Chromium receiver contexts. The reusable
fixture now uses a fresh disk-backed receiver profile and still retains real
storage/quota checks. A persistent-profile comparison remains to run. The exact
origin of the native rejection is not established by the report alone; it is
not evidence of a new transport regression or a physical Pixel storage limit.

0.3.23 passes 191 unit/integration cases, type checking and lint. A full browser
run is in progress. The final older-engine storage repeat passes a real eight-MiB
window, 102 commits averaging 165 ms, and matching stored bytes: 17,047 ms payload
/ 19,654 ms Send to Verified for 400 MiB + 111 bytes. A second native 200-ms RTT
candidate transfer passes in 16,367 / 17,295 ms with matching bytes.

The publisher now preserves prior compiled releases and provenance for actual
phone A/B trials, and retains old hashed asset URLs for already-open pages.
The user's always-publish authorization remains in force.

## Persistent-profile controls and current verification

Four disk-backed no-delay transfers of 400 MiB + 111 bytes pass independent stored
hashes through all five proxy paths. Payload / Send-to-Verified baseline versus
candidate pairs are 8,485 / 11,056 vs 8,942 / 11,495 ms, then 9,322 / 11,861 vs
9,070 / 11,648 ms. Average timing is effectively unchanged; no fast-link speed
improvement is claimed. The native OPFS rejection did not reproduce in these
four persistent transfers. This establishes context dependence in the fixture,
not a particular browser defect or a phone storage limit.

The persistent Chromium 101 storage-delay comparison takes 38,212 / 41,373 ms
on 0.3.22 versus 19,784 / 22,741 ms on the candidate. The baseline makes 201
storage commits; the candidate makes 102, averaging 192 ms after the injected
160-ms notification delay. Both independently stored hashes match and all paths
are proxied. This is about 82% higher end-to-end throughput in the local model.

Final type checking, lint, 192 unit cases and repository formatting pass. The
complete browser suite passes 70 cases with 17 capability skips and no failures
or retries. Additional mixed-version, older-engine and late-loss cases are being
finished before publishing under the user's existing authorization.

## Final compatibility and recovery checks

Actual Chromium 101 passes four targeted controls: strict eight-checkpoint
transaction rollback/refresh, Pixel media/generic picking, real IndexedDB cache
cleanup with protected partials and cancellation, and 125-file inline selection.

Real 0.3.22/0.3.23 WebKit-to-Chromium mixed peers transfer 32 MiB + 111 bytes in
579 / 533 ms payload time. Both directions actually advertise four-MiB receive
credit, use 64-KiB negotiated frames and have no replays. New peers pass with an
actual eight-MiB ready window in 607 ms. Every stored hash matches.

Five 32-MiB recovery cases pass with faults after 16 MiB of warmup: closed lane
(1 replay), interior loss (1), missing final packet (1), four dropped copies
(4), and a delayed lane (5). All files independently hash correctly and retain
the eight-MiB durable window. Source/staging/verification guarantees remain.

At an aggregate one-MiB/s application forwarding cap, baseline/candidate take
32,053 / 32,049 ms with mean queued bytes 345,042 / 346,131, no replays, and
matching hashes. Larger storage credit does not create bandwidth above a shared
network cap. There is no physical-device speed claim.

Main remains synchronized with origin before publishing. The user has authorized
publication of every tested update. The new release includes a preserved actual
0.3.22 reference for controlled same-device timing; save and clear cached copies
between real trials to prevent duplicate skipping. Use one receiver tab at a time.
The five-hour continuation remains active until the physical target is measured.
