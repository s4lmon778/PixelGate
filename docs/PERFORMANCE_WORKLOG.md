# SpeedGate performance and cache work · October 11, 2026

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

The thread heartbeat `pixelgate-speed-and-cache-follow-up` was deleted at the
user’s request. Do not recreate it. Preserve the completed interface/cache work, now committed and published in
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

## Extended 0.3.23 checks after publication

The two-file native-RTT fixture deliberately closes all four bulk channels after
the first 32 MiB + 111-byte file, then sends a different original on the same
primary connection. Both independently read stored copies match their respective source hashes. The first
file takes 10,538 ms payload / 11,261 ms Send to Verified with five connections.
The following file takes 10,773 / 11,480 ms with one connection at 200 ms native
RTT. Failed lanes remain unavailable, but this warmed-primary experiment shows
no meaningful speed loss. Do not promote automatic lane replacement as a speed
fix or infer that the old idle screenshot proves an in-transfer lane failure.
The isolated fixture and results are under `/tmp/pixelgate-speed-20261011`.

The published engine passes a real WebKit-to-Chromium **5 GiB + 23-byte** original
through disk-backed OPFS. Source hashing + transfer + closed staging readback take
107,223 ms; streamed folder copy + destination readback take 39,068 ms. Both the
actual download and the separately exported destination file match independent
streaming Node SHA-256. Distinct frame markers cross the 4 GiB offset boundary,
all five connections remain active, and a subsequent 128 KiB + 7-byte original
uses the same selected folder and matches its hash. These are preservation
checks, not new physical speed claims.

A genuine WebKit-to-WebKit receiver passes **768 MiB + 23 bytes** with naturally
selected IndexedDB. Source hashing + transfer + staged readback take 18,288 ms;
the actual downloaded bytes independently match. The first attempt selected a
nonexistent test name and ran zero cases; the corrected automatic-storage case
passes. No quota, storage or readback check was bypassed.

Direct phone verification is currently unavailable in this workspace: no adb or
libimobiledevice CLI is installed, xcrun has no devicectl, and read-only USB
inventory finds no iPhone or Pixel. No SDK was installed and no phone/security
setting was changed. The requested physical 0.3.22/0.3.23 timings, in-transfer
report and saved-cache confirmation remain pending. Further unmeasured transport
changes would not establish the 50% device target. Keep the goal unachieved and
the five-hour follow-up active; avoid re-requesting the same pending report.

## 0.3.24 cache presentation and open-tab cleanup

The user confirmed that 0.3.23 cleanup prevents downloading the cleared files,
but their names stay in the receiving list and Chrome’s allowance estimate does
not change. This identifies a presentation problem; it does not establish
remaining downloadable payloads. Cleared receipts now appear only in History,
while the receiving list retains unsaved files and recoverable partials.

The actual staged-byte count is now the primary storage indicator. Chrome’s
allowance remains an explicitly delayed browser estimate; no free-space increase
is invented. A file-free cross-tab signal and focus/visibility reconciliation
release prepared File references and object URLs held by other open tabs.

Regression cases exercise both durable backends, a second open tab with prepared
files, protected partials and saved originals, reload persistence, historical
receipts, and an empty file/chunk database while the browser estimate remains
constant. Browser release validation is underway.
The physical transfer-speed target is still unmeasured.

## New physical diagnostics and retained 0.3.23 transfer settings

The user reported roughly 170 KB/s on the same iPhone-to-Pixel Wi-Fi setup, then
explicitly instructed that transfer settings must not be restored until the app
versus Wi-Fi cause is identified. No rollback has been published; published
0.3.24 retains the 0.3.23 frame-selection policy and eight-MiB negotiated window.

Six current Pixel photos show Android 9, IndexedDB, all five parallel connections
open, zero reordered bytes, and a connected UDP primary route at 18 ms RTT.
Accepted bytes are 32,915,456, durable bytes 32,505,856, buffered bytes 409,600,
and queued bytes zero. At the photographed moment, frame idle is 21,643 ms and
the receiver has waited for bytes for 29,111 ms. Storage has completed 31
one-MiB batches: last 73 ms, mean 89 ms, maximum 122 ms. The 566-second route
lifetime is not a file transfer duration. These observations favor a
sender/network/transport stall at that moment over a blocked storage commit;
they do not distinguish Wi-Fi loss, sender backgrounding, or a software stall.

Code inspection identifies an independent pause-observation defect: the sender
automatically pauses when backgrounded but sends no pause notification to the
receiver. The receiver continues displaying a transfer rate through that idle
period. Receiver-requested pause also changes the sender engine without updating
its visible state/clock. The existing pause/resume messages now synchronize
visible state and clocks in both directions, and receiving reports include a
paused flag. No automatic resume or pause safeguard is removed. The user reports that the sending control said Pause. This establishes the
visible state but not the engine’s actual pause state because of the identified
UI synchronization defect. Sender backgrounding is not treated as established.

The compact connection visual labels sender and receiver device classes, always
points from sender to receiver, and animates a dot during transfer. Only a broad
phone/tablet/computer category travels in the existing direct hello; old peers
show a generic Device. Reduced-motion preferences suppress the animation.

The sender report now records its current wait stage and pause state, without
file names or byte copies. A controlled held source-read test distinguishes that
wait from receiver storage/network waits and then finishes with matching bytes.

The complete UI/transfer browser run has 72 passes, 17 capability skips and one
initial native automatic-discovery failure in Chromium. The unchanged candidate
then passes that case in isolation; the actual preserved 0.3.22 also passes the
same isolated case. Final targeted compiled checks pass 15 cases across all
three engines (3 intentional skips), including automatic pairing, mobile device
visuals, reciprocal pause, byte readback, cache deletion and modeled loss/recovery.
Actual Chromium 101 passes 4 targeted cases. A real 32 MiB synthetic transfer at
360-pixel width exercises the moving dot, reduced motion, both peer pause states
and completion without horizontal overflow. Unit checks pass 197 cases.

A new temporary native UDP experiment drops roughly 1% of encrypted application
packets with a fixed seeded generator and adds 9 ms per direction. Fresh WebKit
sends to disk-backed actual Chromium 101, which chooses IndexedDB. The first
benchmark readback incorrectly assumed OPFS from API presence; that harness
assumption was corrected to use the selected storage mode. The same correction
is made to the shared manual-transfer fixture. No product verification guard
was weakened. Independently hashed 32 MiB + 111-byte runs then take 12.152 s
end-to-end (11.770 s payload) on actual 0.3.22 and 11.967 s (11.571 s payload) on
an earlier local 0.3.23 candidate (not the exact published bundle). All five connections are proxied, with 550/566 dropped packets. This
model does not reproduce the physical 170 KB/s report and does not establish
whether the real Wi-Fi or update caused it. The iPhone’s live report is pending.

## Verified publication and extended loss controls

0.3.24 is published from **5765af4b9438bbedd908033a44fad82df42312cb**; Pages
commit **e38b6d673d9126fcaceb2b4e82b7c800b69da867** reports built with no error.
Live HTML and all four assets match the tested build byte for byte. An isolated
360-pixel live browser renders File cache: 0 B, no receiving rows, no overflow
and no page errors. The exact prior 0.3.23 build is preserved at
`https://s4lmon778.github.io/PixelGate/releases/0.3.23/`. Final reviewed-build
checks pass another four cases, including the sending wait-stage report.

The first loss comparison above used the earlier local candidate. It must not
be represented as the published 0.3.23. The exact public 0.3.23 HTML and assets
(index-CgFY7-O8.js) were fetched with source metadata 3dfe10d and served unchanged
for subsequent controls. Its two seed-7 runs take 15.475 / 14.454 s, versus
12.152 / 11.388 s on actual 0.3.22. Three more matched loss seeds give:

| Loss seed | Actual 0.3.22 | Exact published 0.3.23 |
| --------- | ------------: | ---------------------: |
| 13        |      10.411 s |               12.553 s |
| 31        |      11.877 s |               11.915 s |
| 47        |      11.421 s |               11.212 s |

All originals match independent hashes; all five paths are proxied. Across these
five runs, means are 11.450 s and 13.122 s, about 14.6% more elapsed time on
0.3.23. Outcomes depend substantially on loss pattern. This supports further
investigation of loss interaction, not a claim that the update caused the
entire reported physical slowdown or that Wi-Fi is at fault.

Two one-variable local variants, built from 3dfe10d, take 12.828 s with only the
window reduced to four MiB and 12.928 s with only the old frame-selection rule
restored, under seed 7. Each is one run with independent hashes; the evidence
does not isolate one reliable fix. These variants are not published.

The physical photos' five path-byte counters sum to 37,700,640, versus
32,915,456 delivered payload bytes: 4,785,184 excess bytes. Frame headers alone
do not explain this difference; replayed/duplicate framed data is a plausible
contributor. This does not show the sender's pending receipts or identify why
replays occurred. Its live report remains needed. No transfer tuning is restored.

## 0.3.25 green connection visual

Device icons and labels now use the existing green connection theme, with soft
circular icon badges. The moving dot is replaced by a tapered SVG beam adapted
from Magic UI's MIT-licensed Animated Beam. Its pinned source and full license
are distributed in `public/third-party-notices.txt`. A fixed SVG and CSS animation
avoid adding Motion or per-frame JavaScript. Sender-to-receiver direction,
device types, pause state, reduced motion and the compact mobile layout remain.
Transfer settings and protocol behavior are unchanged.

TypeScript, ESLint, 197 unit/integration cases and the production build pass.
Fifteen targeted browser cases pass across Chromium, Firefox and WebKit,
covering real peer transfer/readback, direction, pause, responsive layouts,
enlarged text and appearance. Isolated 32 MiB + 111-byte peer transfers also
exercise the moving beam, reduced motion and reciprocal pause/resume in modern
Chromium and actual Chromium 101. Light/dark screenshots at phone widths were
inspected; no horizontal page overflow was found. These browser checks do not
establish a physical-phone speed gain.

Published source `dfadb0b85f1e6ed3364cc23e9b7bebadfcb83364`; Pages commit
`edc99792880059020edf029a8ebc4bb22de1a4e6` reports built with no error. Live HTML,
all four assets and the distributed license match the tested build byte for
byte. A fresh 360-pixel live browser shows 0.3.25 without page errors or
horizontal overflow. Its first smoke check used an obsolete storage heading;
the fixture was corrected to the current File cache label and passed.

## 2026-10-12 loss experiments and paired-source diagnostics

The clean 0.3.25 compiled build is the control for three new isolated candidates.
Fresh WebKit senders transfer marked 32 MiB + 111-byte originals to disk-backed
actual Chromium 101 IndexedDB receivers, with 9 ms native proxy latency in each
direction and approximately 1% seeded encrypted application-packet loss. All
five connections are proxied and all twelve stored originals independently
match their source hashes. Seeds select comparable loss distributions, not
identical dropped messages across different packet sequences.

| Candidate                                                 |   Seed 7 |  Seed 13 |  Seed 31 | Mean Send-to-Verified |
| --------------------------------------------------------- | -------: | -------: | -------: | --------------------: |
| Published 0.3.25 settings                                 | 13.004 s | 12.824 s | 13.161 s |              12.996 s |
| 8 KiB messages when queue delay exceeds 150 ms            | 18.230 s | 13.158 s | 16.573 s |              15.987 s |
| 4 KiB messages under the same condition                   | 17.074 s | 20.054 s | 16.942 s |              18.023 s |
| Keep primary for control, use open bulk lanes for payload | 13.139 s | 17.909 s | 16.620 s |              15.889 s |

All three candidates are rejected: none provides a consistent improvement.
The sanitized per-run measurements are retained in
[`benchmarks/2026-10-12-loss-comparison.json`](benchmarks/2026-10-12-loss-comparison.json).
They were built under `/tmp/pixelgate-speed-20261012/`; source changes were
restored before further work. No tested speed setting is rolled back or
published. Smaller messages were investigated because the data-channel
specification describes SCTP fragmentation and possible association blocking
([RFC 8831, section 6.6](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.6));
the results above do not support this particular adaptive rule.

0.3.26 adds optional paired-source status to the receiving connection report.
The missing iPhone report has prevented distinguishing a source read, pause,
network backpressure and a missing durable acknowledgment in the physical
20-second delivery stalls. Both peers advertise an optional capability; an
older peer receives no new status messages. The sender shares only whitelisted
states, visibility and numeric transport counts over its existing approved
direct connection, at most once per two seconds, skipping a queued primary.
No names, paths, addresses, hashes, file bytes or source user agent are shared.
Status bypasses the ordered file sequence, never changes durable acknowledgment
or flow credit, and diagnostic send failures do not stop transfers. The receiver
keeps one validated sample, rate limits updates and reports its local sample age
so a frozen sender/control path is not mistaken for a current measurement.

The transfer window, frame selection, scheduling, checkpoint durability,
verification and recovery settings remain unchanged. Subsequent work below adds
source-read optimization; no physical-device speed gain is claimed.

## App-managed retry and source-read experiments

Partially reliable bulk lanes (`maxRetransmits: 0`) were investigated using the
existing selective application receipts/retries. Control stayed reliable.
Reliable delivery and limited browser retransmissions are specified in
[WebRTC](https://www.w3.org/TR/webrtc/#rtcdatachannel). No such lane policy is
retained in the product. Ordinary 16 KiB variants took 33.570 / 35.058 s for
32 MiB, versus the approximately 13-second control. An 8 KiB variant took
27.493 s in one run and closed during another, retaining a 27 MiB prefix; it
is rejected. That fixture initially waited for Verified/Needs retry and did
not recognize Paused as terminal. Its terminal-state guard was corrected.
One PR trial overlapped an experimental build and is excluded from precise
comparison; the first completed trials already showed a substantial regression.

Retry-specific cooldown removal and a lower tail retry floor took
15.718 / 16.123 / 16.175 s, all independently matching, and were also rejected.
An ordinary reliable-lane experiment which clears cooldown only on a fresh,
unreplayed receipt near that path's established baseline took
12.955 / 11.772 / 12.410 s. Its small difference is not enough evidence to
promote another network setting. None of these changes is published.

Larger source reads were then tested without changing on-wire checkpoints.
An unconditional four-MiB cache had inconsistent timings; yielding a browser
task at cached-checkpoint boundaries made the read-delay model more consistent.
With marked 400 MiB + 111-byte originals, actual Chromium 101 IndexedDB,
18 ms native RTT, no configured packet loss and 50 ms extra notification time
per **main-thread source read**, 0.3.25 took 23.452 / 23.509 s Send-to-Verified.
The always-batched variant took 11.119 / 13.307 s with independent hashes;
source reads dropped from 400 to 100. Hashing-worker reads were not delayed.
Normal-read 400 MiB controls took 10.256 / 12.221 s versus 10.444 / 11.068 s.
However, 1% loss trials of the always-batched version took
16.036 / 13.872 / 14.444 s. It is therefore not retained unconditionally.

The selected 0.3.26 reader starts with one-MiB reads. For files at least eight
MiB, two consecutive **pipeline waits** of at least 40 ms enable bounded
four-MiB source batches for that file. Measuring demand waits rather than the
native read's duration avoids batching when prefetch already hides file I/O
behind network/storage work. Current and prefetched source buffers remain at
most eight MiB. Checkpoints, on-wire frame limits and receiver credit do not
increase. Cached checkpoints yield a browser task; ordinary reads keep the
existing pacing. Read failures remain caught even after cancellation, and
short reads cancel the attempt while retaining committed prefixes.

The adaptive reader takes 12.759 / 11.374 s in the 400 MiB read-delay model,
versus the 23.452 / 23.509 s actual-release controls: means 12.067 / 23.481 s,
about 94.6% higher throughput **in this model**, not a measured phone gain.
All originals independently match. Six matched 1% loss controls, using the
same new diagnostics and the batching gate either disabled or enabled, take
13.863 / 13.991 s (seed 31), 13.543 / 14.523 s (13), and 11.643 / 10.769 s (7).
Means are 13.016 / 13.094 s; variability is larger than the 0.6% mean difference.
No larger reads occur in these network-bound cases. The receiving report now
also retains validated session source-read counts, durations and actual
pipeline wait totals, excluding source hashing, without file identifiers.

An attempted older-source control could not typecheck against the new snapshot
tests, so it was not used. The comparison control instead disables only the
adaptive gate while keeping the exact new diagnostic/reader implementation.

Final source-reader checks pass TypeScript, ESLint and 216 unit/integration
cases, including deliberate blocking reads, ordinary reads and truncation of a
larger read with a protected two-MiB durable prefix. The production build passes.
Nine final browser cases pass with six intentional engine/capability skips,
including 400 MiB original transfers/downloads through both durable backends,
independent hashes, raw/old transport, lane failure, recovery, held source reads,
pause/resume and reconnect. Actual Chromium 101 passes four cache/storage/source
cases and both directions of pairing with actual 0.3.25 plus a new/new 16 MiB
control, all independently hashed. The earlier metadata-only full run had
75 passes, 17 skips and one WebKit timeout after verification; the unchanged
isolated case and actual 0.3.25 version-pinned control both pass in 9.8 seconds.
The first old-release control used the current-version assertion and failed;
the fixture now permits an explicit expected release version without weakening
normal current-version checks. The throughput fixture also uses the reported
storage backend for readback instead of assuming OPFS from API presence.

Per-run source-read and matched-loss measurements are retained in
[`benchmarks/2026-10-12-source-read-comparison.json`](benchmarks/2026-10-12-source-read-comparison.json).
The user cannot recover the old iPhone reports. Do not request them again;
new paired-source snapshots can accompany a future physical timing instead.
The requested physical 50% gain remains unverified.

Final no-added-read-delay 400 MiB native controls take 10.241 / 10.626 s on the
adaptive version versus 10.256 / 12.221 s on actual 0.3.25. All originals match,
all five paths are proxied, and ordinary reads stay at one MiB (401 completed
reads including the final 111-byte tail). No network-mode replacement is made.

Published 0.3.26 source `b465196a59685b4d2dac5955bc5280b0cd20ce68`; Pages commit
`1ea3d9331fa2cfe20e51626e3197a170921a2178` reports built with no error. Live HTML,
all four compiled assets and the license notice match the tested build byte
for byte. A fresh mobile-width live browser renders 0.3.26 without page errors
or horizontal overflow. Physical timing on the same iPhone/Pixel/video/Wi-Fi
remains necessary before marking the goal achieved.

## Further network-policy comparisons against published 0.3.26

The next controlled experiments target correlated throttling and fragmentation,
without changing receive credit, checkpoints, reliability or independent
verification. The control is the exact published 0.3.26 build. Temporary builds
test: (1) using lower-median queue delay when at least three paths have finite
observations, otherwise retaining maximum delay; (2) limiting warmed nearby
payload messages to 32 KiB instead of negotiated 64 KiB; (3) combining both.
Source is restored after every build; no alternative is retained or published.

Fresh WebKit-to-actual-Chromium-101 IndexedDB native trials use marked
32 MiB + 111-byte originals, 9 ms each way and approximately 1% seeded encrypted
application-packet loss. Every connection is proxied and all twelve independent
stored hashes match. Send-to-Verified results are:

| Policy                      |   Seed 7 |  Seed 13 |  Seed 31 |     Mean |
| --------------------------- | -------: | -------: | -------: | -------: |
| Published 0.3.26            | 13.526 s | 10.728 s | 12.887 s | 12.380 s |
| Lower-median queue feedback | 13.523 s | 12.674 s | 12.201 s | 12.799 s |
| Warmed 32 KiB payloads      | 12.152 s | 13.770 s | 11.459 s | 12.460 s |
| Both policies               | 10.655 s | 11.156 s | 13.076 s | 11.629 s |

The combined policy's approximately 6.5% mean throughput difference is driven
by one better run; it is slower in the other two. It does not establish a
consistent improvement. Loss seeds describe comparable distributions, not
identical dropped messages across differing packet/timing sequences.

Three further browser comparisons each independently verify eight 16 MiB +
111-byte transfers: equal paths, one much slower path, one moderately slower
path, and a shared bottleneck, with actual baseline/candidate pairs. These are
application-send queue models, not native packet-loss/phone measurements.
All 24 hashes match. Equal-path timings stay around 3.2–3.3 s, substantially
unequal paths around 4.0 s, moderate paths around 3.7–3.8 s, and shared capacity
around 16.0 s. No candidate materially improves these conditions; some add
queued bytes. All three alternatives are therefore rejected.

Sanitized numeric results are retained in
[`benchmarks/2026-10-12-network-policy-comparison.json`](benchmarks/2026-10-12-network-policy-comparison.json).
Product code and live 0.3.26 are unchanged. A fresh same-video, same-iPhone,
same-Pixel, same-Wi-Fi Send-to-Verified timing was requested asynchronously;
the old iPhone reports are not requested again. Physical success remains
unproven, so the goal is not complete.

## 0.3.27 retained Send-to-Verified timing

A new read-only USB inventory finds no iPhone, Pixel or Android device; adb and
libimobiledevice remain unavailable. Live Pages still serves verified 0.3.26.
The physical requirement cannot be proved from local benchmarks or connection
lifetime, and no fresh phone timing has arrived.

The source report previously exposed wait-stage duration and connection lifetime
but no explicit Send-to-Verified duration. 0.3.27 adds bounded, filename-free
batch timing to `transfer.source.batch` on the receiving report. The measurement
begins at Sender.run (the Send invocation) and stops after its verified outcome,
including preparation and pauses. It records newly sent logical payload,
requested bytes/files, resumed prefixes, skipped existing copies and verified
file counts. A completed duplicate or resume therefore cannot be misrepresented
as a fresh full-file speed gain. Failed/cancelled/partial batches remain labeled
incomplete. The ordinary progress clock and all byte-transfer settings remain.

The completion snapshot is shared immediately over the existing approved direct
channel, within the existing native-queue guard. The receiving report retains
it on receipt, and the sender retains its own final snapshot, so an immediate
refresh no longer loses the completed timing while awaiting the periodic poll.
Older source-status peers ignore the optional timing field; peers without that
capability receive no new status message. No server upload, new button, pairing
permission, file-store migration or network-policy change is introduced.

Timing unit checks cover preparation/pauses, stop/reset, skipped and resumed
bytes, and incomplete outcomes. Real peer browser tests retain the completed
timing through receiver reload and independently hash the stored original.
Source status validates every numeric field and count relationship, dropping
arbitrary identifiers. Further release validation is recorded below.

TypeScript, ESLint and 220 unit/integration cases pass. Three modern-browser
timing/readback/reload cases pass across Chromium, Firefox and WebKit; actual
Chromium 101 passes timing retention and two cache-cleanup cases. Six transfer
browser cases pass with six deliberate skips, covering both 400 MiB durable
backends and byte-exact downloads, recovery, raw/older transport and reconnect.
Final current-build report tests pass completion retention plus explicit
disconnect/reload/download of the retained report. A targeted unit rerun
overlapped the large browser suite and hit the five-second deadline in two
existing transfer cases; the unchanged isolated rerun passes all 52 targeted
cases, with those two transfers completing around 2.3 seconds. No deadline or
product guard was weakened. Final timing freeze/idempotence checks also pass.

This release improves measurement and report retention. It does not claim
another throughput increase; the physical 50% target is still unverified.

0.3.27 is published from `2f39a4212266d416243fb7f7d2873bfe6817babb`; Pages commit
`40f700648a2e1dbf7d02f3a138f1d593afeecba8` reports built with no error. Live HTML,
all four compiled assets and the distributed license match the tested build
byte for byte. A fresh 360-pixel live browser renders 0.3.27 without errors or
horizontal overflow. The same-phone/video/Wi-Fi timing remains pending.

## 0.3.28 recovery research and guarded optimization

The user resumed performance work, explicitly asked for more research rather
than more diagnostics, and retained standing publication authorization. No phone
report is requested again and the cancelled automation remains deleted.

Primary research revisited the [WebRTC transport specification](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.6),
[W3C queue semantics](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamount),
the [official data-transfer sample](https://github.com/webrtc/samples/blob/gh-pages/src/content/datachannel/datatransfer/js/main.js),
and [PairDrop's implementation](https://github.com/schlagmichdoch/PairDrop/blob/master/public/scripts/network.js).
Reliable unordered delivery still performs native congestion control and
retransmission. An application retry can repair an ordered stream's missing
prefix through another association, but aggressive retries can also add traffic
and replay ordinary striping skew. Browser bufferedAmount excludes some native
queues; it is not an unlimited transmission budget.

The new study retains 150 numeric comparison records, each with independent
original-byte readback. Immutable variants ran sequentially with isolated
WebKit senders and actual Chromium 101 persistent receivers. Marked files are
32 MiB + 111 bytes for 18 ms round-trip, 1%/3% encrypted UDP packet-loss models;
healthy/direct controls use 128 MiB + 111 bytes. Separate 6x Chromium source CPU
controls are explicitly synthetic and are not Safari or phone CPU measurements.
The local UDP proxy can introduce its own scheduling/queue effects. Direct
controls therefore bypass it, require zero proxy packets, and still independently
verify stored bytes. None of these runs certifies physical Wi-Fi performance.

Rejected alternatives include repairing only the first missing packet, reducing
path-scheduling allocations, distributing receipts, duplicating receipts,
duplicating and ordering durable feedback on independent paths, fixed smaller
frames, temporarily reducing frames after a replay, and partial-reliability bulk
channels with rapid application recovery. An initially promising receipt-routing
result weakened on additional loss patterns. Partial reliability improved some
lighter-loss runs but regressed heavier loss; all native channels remain fully
reliable in the retained implementation. Some rejected builds finish correctly
but add substantial traffic or sharply increase elapsed time.

The retained change accelerates gap recovery only when measured minimum receipt
latency is 8–40 ms. It scans every 20 ms there, uses a 50 ms minimum gap timeout
with measured delay and exponential backoff, and keeps all paths participating:
a single lost packet is not sufficient evidence to sideline a whole association
for five seconds. Very fast, unobserved and longer-delay links retain the previous
100 ms cadence, timeout and cooldown behavior. The 2-second missing-tail floor
and 10-second retry ceiling remain. Every pass snapshots aggregate native buffers,
respects existing send credit, sends at most eight repair packets and occupies at
most eight milliseconds. Transfer windows, original frames, strict checkpoints,
independent final readback, protocol capabilities, UI and cleanup behavior remain.

| Controlled condition                            | Baseline mean Send-to-Verified | Guarded recovery mean | Interpretation                                      |
| ----------------------------------------------- | -----------------------------: | --------------------: | --------------------------------------------------- |
| 1% loss, six matching seeds                     |                       13.642 s |              11.366 s | About 20% higher modeled throughput                 |
| 3% loss, three matching seeds                   |                       20.260 s |              19.320 s | About 5% higher modeled throughput                  |
| Zero configured loss through proxy, three seeds |                        3.581 s |               3.379 s | Proxy model only; not a healthy-link certification  |
| Direct, no proxy, three paired controls         |                        3.296 s |               3.321 s | Essentially unchanged; no added application replays |

Individual runs vary; one of the six lighter-loss patterns is slightly slower.
These are conditional gains, not a universal speed guarantee or proof of the
requested physical 50% gain. The same iPhone/Pixel/video/Wi-Fi target remains
unverified. Sanitized numeric results are retained in
[the comparison record](benchmarks/2026-10-12-recovery-research.json).

The developer benchmark now supports bounded, seeded encrypted-datagram loss,
source-read delays, optional Chromium CPU throttling, and direct controls. Its
normal WebKit-to-Chromium mode and independent hash checks remain. Direct mode
rejects configured proxy latency/loss instead of silently claiming they applied.
The updated CLI completes a byte-verified direct WebKit-to-Chromium-101 control
with all five native connections mapped and zero packets through the proxy.

TypeScript, ESLint and 222 unit/integration cases pass. Recovery checks cover
very fast/nearby/long-delay links, bounded repair bursts, aggregate native queue
credit, tail recovery and eventual receipt release. Initial unit expectations
assumed the old polling phase and exactly one nearby retry; they were revised to
check the new bounded cadence and backoff, without weakening byte verification.
Release browser checks and publication are recorded below.

Final release validation passes five Chromium browser cases, including 400 MiB
originals on both durable backends, byte-exact downloads, 125-file batches,
source pause/readback, lane loss, raw/older transport and reconnect paths. Four
Firefox/WebKit pause/readback and transfer/recovery cases pass. Actual Chromium
101 passes fourteen mobile, cache-cleanup, pause/readback and transport cases,
including a 500 ms receipt-delay control. All 23 browser cases pass; no test
deadline or verification requirement is weakened. The new CLI direct control
and three additional seeded loss runs use the final 0.3.28 build.

The release keeps the green connection visual, compact file lists, save/history
features and actual staged-cache cleanup. It adds no diagnostic UI or permission
flow. The measured physical 50% goal remains unverified; this release is a
bounded, conditional performance improvement rather than a claim of that goal.

0.3.28 is published from `133f6cb74bde0255224fcf068017d9efd9e847c1`.
GitHub Pages commit `21d0ffc226f7bb4225e3e1ecaf0b136908502457` reports built,
with no error. Live build metadata matches the source/version, and HTML, all
four compiled assets and the third-party notice match the tested distribution
byte for byte. A fresh 360-pixel live Chromium check renders 0.3.28 without
runtime errors or horizontal overflow. Its first locator used a nonexistent
`v` prefix and timed out; the corrected footer-version locator passes. The
physical 50% requirement remains unverified.

## October 13 · 0.3.29 interface corrections, unchanged transfer tuning

The supplied sender report identifies 0.3.23, while the Pixel photographs identify
0.3.28. This mixed-version run cannot measure the newer sender optimizations.
The later Pixel snapshot reports a failed primary connection, only one remaining
open channel, more than two minutes without payload, an empty storage queue and
a paused receiver. These observations do not establish why the network failed,
why the receiver paused, or a sustained storage bottleneck. Terminal connection
handling and higher-latency tuning remain investigation items; neither is changed
in this interface release, following the user's request to test the current speed
settings before further tuning. A temporary latency-scaled credit candidate was
built separately but was not measured, retained in product source or published.

The Android media picker now spans the mobile row above equal-sized files/folder
buttons. Device icons and the green directional arrow share the same vertical
center; labels sit below the icons. Local Android client hints and touch-screen
size supplement the existing user-agent classification when desktop browsing
hides the Mobile token. Only the broad device class is shared with the approved
peer. An older peer that sends no device class keeps an explicit unknown symbol,
without guessing that it is a phone or computer. Both tabs need the newer device
metadata support for both ends of the visual to identify their peers.

TypeScript, ESLint, 223 unit/integration cases and the production build pass.
Six Chromium/WebKit browser cases pass: actual peer transfer, independent stored
and exported readback, reconnect, responsive layouts and enlarged text. Five
actual Chromium 101 cases pass: Android media/files picker behavior, both staged
cache backends, stale browser allowance estimates and contained file selection.
A separate Chromium 101 visual check pairs emulated phone-to-phone and
computer-to-phone contexts, verifies both roles' device classes, measures identical
arrow/icon centers, checks 320-pixel enlarged-text overflow and captures screenshots
for inspection. No runtime errors were observed. These are desktop-engine checks,
not physical phone speed measurements. The requested 50% physical gain remains
unverified. Sender transport, receiver checkpoints, gap recovery, verification,
pause behavior, cache cleanup and saving features are unchanged in this release.

Published 0.3.29 from `e6ba6757afe4a3c10a55c346e6f186ddac1d5448`.
GitHub Pages commit `2cd5edbc792cf640396f8478b957df160b368326` reports
built with no error. Live build metadata matches; the HTML, all four compiled
assets and third-party notice match the tested distribution byte for byte.
A fresh actual Chromium 101.0.4951.15 context loads the live release at 360px,
confirms the new three-button arrangement and reports no runtime errors or
horizontal overflow. The initial exact footer-text locator failed because the
footer includes additional text; the corrected footer contains-text check passes.
The user's ongoing speed test was not refreshed or otherwise interrupted.

## October 13 · 0.3.30 path-aware recovery and dashed connection visual

The user reports both phones on 0.3.28 averaging roughly 5 MB/s, peaking at
5.2 MB/s. The sender's retained batch reports 421,259,466 bytes, one verified
file, no resumed/skipped bytes and 92,092 ms Send-to-Verified: approximately
4.57 decimal MB/s including preparation and verification. Source reads average
4 ms, maximum 10 ms, with only 3 ms of aggregate pipeline wait. The supplied
Pixel photos confirm the entire same byte count accepted and durable, IndexedDB
storage, 396 commits averaging 147 ms, and complete/unpaused receiving. Later
connection failure/zero traffic is recorded minutes after completion; it does
not invalidate the completed copy or establish a transfer-time storage stall.
This establishes a successful new physical baseline, not proof that every part
of the improvement came from software. The user explicitly asks to continue
beyond the earlier 50% target.

The sender records 736 application-level replays. These are not a packet-loss
count: a delayed original can still arrive after its replay. Native reliable
SCTP already performs retransmission and congestion control, as described by
[RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html). Application repair across
another connection can bypass a stalled path, but sending too early can add
traffic. This motivates testing each path's own observed receipt delay instead
of letting fast siblings shorten its recovery deadline.

Four immutable candidates were compared before selecting the new policy:
per-path delay doubled with a 500 ms ceiling; a smaller 1.5 multiplier with a
250 ms ceiling; a wider short-link large-frame gate; and waiting up to 200 ms to
coalesce slow IndexedDB writes. Larger frames were slower in the initial shared
capacity pairs. Waiting reduced commits from about 32 to 19–20 but produced
little timing benefit and more replays. The smaller multiplier also failed to
reduce replays reliably. These alternatives are not in product source.

Selected recovery retains the existing global deadline and also allows twice
the original path's smoothed receipt delay, capped at 500 ms, only in the existing
nearby-link mode (lower-median minimum receipt delay 8–40 ms). Missing prefixes
still have a 50 ms floor, unproven tails a two-second floor, and retries retain
exponential backoff plus the ten-second ceiling. Repair scans, eight-packet/eight-ms
work bounds, native queue checks, receive credit and retained payload limits are
unchanged. No native reliability, checkpoint ACK or readback requirement changes.

The CLI now supports a shared synthetic capacity across every proxied connection
and return packet, rather than granting each connection independent bandwidth.
Validation rejects out-of-range rates and configured capacity in direct mode.
This is a desktop-engine capacity experiment, not a physical Wi-Fi reproduction.
All runs use native WebKit sending to actual Chromium 101 receiving, marked
synthetic originals and independent stored-byte SHA-256. Comparisons run
sequentially without concurrent builds/browser suites; order alternates in some
pairs. A matching seed/settings does not guarantee an identical lost-payload
pattern once candidates generate different retransmission traffic.

The [sanitized numeric record](benchmarks/2026-10-13-path-recovery-research.json)
contains **62 successful measured transfers**, all independently byte-verified:

- Five matched clean shared-link pairs use 32 MiB + 111 bytes, 9 ms one-way delay,
  a 6 MiB/s shared medium and 150 ms notification delay after actual strict
  IndexedDB completion. Median Send-to-Verified changes from 8,179 to 7,689 ms:
  **6.37% higher throughput**. Mean replays fall from 45.8 to 3.0 (93.45%).
- The same five settings/seeds with about 1% encrypted-datagram loss change median
  timing from 12,216 to 11,841 ms (3.17%). Mean replays fall from 34.2 to 3.2.
  Individual candidate runs can be slower by roughly 7%; this is not a consistent
  loss-path speed gain or a physical-device guarantee.
- Eighteen uncapped controls cover clean, 1% and 3% loss across three seeds.
  Timings vary and do not establish another universal speed gain. Median clean
  timing is 1,442 versus 1,533 ms; 1% is 10,724 versus 10,859 ms; 3% is 17,986 versus
  17,875 ms. These include fresh-context preparation and short transfers.
- Three final-build direct pairs transfer 128 MiB + 111 bytes with zero proxy
  traffic and zero application replays. Median first-payload timing is 2,569
  versus 2,542 ms, essentially unchanged within run variation.
- Two final-build longer-route pairs use 60 ms one-way delay. Observed per-path
  minimum receipt delays are 120–122 ms, so the modified nearby branch does not
  apply. All originals verify; timing differences are not attributed to this
  change.

The visual keeps the green theme, fixed SVG/CSS animation, pause behavior and
reduced-motion preference. Its stem is dashed and responsive (80–140 px column,
32% of available width), with a solid directional head. The stroke is moved down
one CSS pixel relative to the circle centers for the requested optical alignment.
There are no additional animation timers, controls or report buttons.

TypeScript, ESLint, the production build and 225 unit/integration cases pass.
New fault-injection cases prove a slower path's packet is not copied at 100 ms,
receives its bounded learned grace, is eventually repaired on another path and
releases all retained credit after receipt. Existing fast/nearby/long-delay,
closed-lane, lost-tail, backoff and queue-bound cases remain.

Final release checks pass **16 browser cases**: four modern Chromium cases cover
400 MiB originals on each backend, byte-exact downloads, 125-file handoffs and
nine transport/compatibility/recovery modes. Six Chromium/WebKit cases cover
actual pairing, independent readback/export checks, reconnect, responsive layouts
and enlarged text. Actual Chromium 101 passes six mobile/cache/selection and
transport cases, including lost packets, closed lanes and 500 ms receipts.
A separate actual Chromium 101 visual inspection checks both roles in phone-to-phone
and computer-to-phone contexts, measures an approximately 99 px stem at 360 px,
confirms the dashed stroke and exactly one-pixel optical offset, and checks 320 px
with enlarged text. Screenshots were inspected; no runtime errors or horizontal
overflow were observed. This validates the proposed release, not a new physical
speed above the user's 5 MB/s report. Publication is recorded below.

0.3.30 is published from `4e20c44e351b13e856a7e7ddbc802d10992de659`.
Pages commit `715cdf1d93b0ca0e49fc19042203e467ae39733a` reports built with no
error. Live build metadata identifies the tested source/version. HTML, all four
compiled assets and the third-party notice match the local distribution byte for
byte. A fresh actual Chromium 101.0.4951.15 context loads the live 360 px page,
confirms the version and all three pickers, with no runtime errors or horizontal
overflow. No active user transfer was refreshed. Further physical speed above
the user's reported baseline remains to be measured; the ongoing performance
objective is not marked complete by these desktop model results.

## October 13 · 0.3.31 seven negotiated connections

The user's new iPhone-to-iPhone 0.3.30 reports show 118,271,716 original bytes,
one verified file, no resumed/skipped bytes and 32,278 ms Send-to-Verified:
approximately 3.66 decimal MB/s including preparation and verification. The
sender's source reads average 4 ms, maximum 8 ms, with only 2 ms aggregate wait.
The receiver uses OPFS, completes all bytes durably, and reports 113 commits
averaging 4 ms, maximum 9 ms. This pair/file differs from the earlier Pixel test;
the numbers do not establish a software regression. Its 87 application replays
are not a native packet-loss count. Receiver frame totals exceed the original by
about 2.4%, including duplicates and frame headers.

Three alternatives were rejected before selecting an increased negotiated lane
limit. Preserving warm sender credit through moderate queued delay and gradually
halving it both failed to improve timings consistently. A 32 KiB nearby frame
variant changed clean median timing from 15,268 to 15,007 ms, but worsened the
loss median from 24,513 to 25,243 ms. None of these policies is in product source.

The selected change raises the maximum additional native peer connections from
four to six, giving seven total when both peers advertise support. Negotiation
still chooses the smaller peer limit: 0.3.30 retains five total, while peers
without a lane limit retain three. Raw fallback and protocol/persisted-data
versions remain unchanged. A shared constant also bounds source-status parsing
at seven, so receiver reports continue showing the sender's useful state.

Source preparation, frame selection, recovery deadlines, strict checkpoint ACKs,
readback verification and aggregate retained-payload/receive credit limits are
unchanged. Two additional native connections have their own resource overhead;
the unchanged application payload limits are not a claim of identical total
browser memory usage.

The [sanitized numeric record](benchmarks/2026-10-13-ios-pair-research.json)
contains **63 successful native transfers**, each independently byte-verified.
The main comparisons transfer 64 MiB + 111 bytes with three seeds, a shared
6 MiB/s synthetic medium across every connection and return packet, and 10 ms
one-way delay. Comparisons run sequentially without concurrent builds or browser
suites. Matching settings/seeds do not guarantee identical dropped payloads
after candidates generate different traffic.

- WebKit sending to WebKit receiving: clean median Send-to-Verified changes
  from 15,941 to 14,031 ms, **13.61% higher throughput**. With about 1% encrypted
  datagram loss, 24,852 becomes 19,398 ms, **28.12% higher throughput**. Every
  matched seed improves in both groups.
- WebKit sending to actual Chromium 101, with 150 ms notification delay after
  actual strict IndexedDB completion: clean median 15,942 becomes 14,774 ms,
  **7.91% higher throughput**; 1% loss median 25,088 becomes 20,483 ms,
  **22.48% higher throughput**. Every matched seed improves in both groups.
- Final 0.3.31 WebKit controls use the repository CLI and verify seven working
  connections with sender status intact. Two uncapped/no-added-delay pairs
  change from 2,533/2,518 to 2,084/2,207 ms. Two shared-medium/3% loss pairs change
  from 39,025/40,512 to 27,214/28,185 ms. All originals match independently.

These are desktop engine models, not physical iPhone/Wi-Fi measurements. The
WebKit fixture naturally uses IndexedDB with roughly 2–3 ms commits, whereas the
user's receiving iPhone uses OPFS. The observed local gains cannot establish a
new physical speed beyond the user's reports.

The benchmark now supports a WebKit receiver using a normal context; its
unsupported persistent-context launch failed before timing and is excluded.
Earlier proxy setup failures were also excluded. The loopback-only fixture now
learns the native socket endpoint from STUN because a guessed mDNS endpoint can
differ from the socket reaching the mapped proxy. This fixes the measurement
fixture and never changes production ICE handling.

TypeScript, ESLint, formatting and 231 unit/integration cases pass. New tests
cover advertised lane limits, the aggregate credit bound, lane closure, receipt
release and seven-connection sender status. Five modern Chromium browser cases
pass, covering 400 MiB copies on OPFS and IndexedDB, byte-exact saving, 125-file
handoffs, source pause/read waits and nine transport/recovery modes. Seven actual
Chromium 101 cases pass for mobile selection, cache removal, empty saved cache,
source status and lost-packet/closed-lane/500 ms receipt modes. Mixed 0.3.30 and
0.3.31 peers pass both directions with five connections, and current peers pass
with seven, including independent readback. An initial mixed test used default
legacy frame expectations rather than 0.3.30's advertised 64 KiB frame; correcting
the fixture to its actual capabilities resolves that assertion.
Two WebKit browser cases additionally pass real pairing, independent readback,
manual export verification, reconnect and held-source/pause-to-verified behavior.

0.3.31 is published from `a922aec50008107546dda39542bbe6af4bb0a841`.
Pages commit `d9a1de7ff1cb912409564007d9a9c12ef969a27e` reports built with no
error. Live metadata identifies the tested source/version, and HTML, all four
compiled assets and the third-party notice match the local distribution byte for
byte. A fresh actual Chromium 101.0.4951.15 context confirms the live version,
all three pickers and both mobile roles at 360 px with no runtime errors or
horizontal overflow. Active user tabs and transfers were not refreshed. The
next physical comparison requires both peers on 0.3.31 with the same original,
device pair and Wi-Fi; these model gains do not yet establish that phone result.

## October 13–14 · 0.3.32 fourteen connections and bottleneck controls

The user asks to double the seven connections and the speed improvement, then
explicitly asks to check bottlenecks and limits. The candidate advertises thirteen
additional independent native peer connections, giving fourteen total when both
peers support them. The smaller advertised limit preserves seven with 0.3.31,
five with 0.3.30, and older fallback. Source-status validation shares the same
constant and accepts fourteen. No interface, saving, cache, recovery deadline,
payload frame, receive window or aggregate retained-payload bound changes.
Extra native connections have additional browser/OS resource overhead and share
the physical Wi-Fi capacity; they do not create a second physical interface.

The simple fourteen-connection candidate with concurrent native offer creation
failed two headless WebKit proxy setups before file payload, while seven-connection
controls completed. Pinning the proxy endpoint after DTLS alone did not resolve
the failure. Serializing native offer creation resolved the subsequent fourteen-
connection runs; ICE checks can still overlap. Setup stops on primary closure.
This is an observed setup improvement, not proof of the native failure's root
cause. A direct guessed-mDNS IPv4 fixture also failed pairing and is excluded.
The loopback fixture now reserves sixteen proxy pairs and prevents later STUN
checks from unused candidates from redirecting a DTLS-established endpoint.
These changes do not alter production ICE candidates.

Repeated comparisons use three seeds and 64 MiB + 111 independently verified
original bytes, without concurrent builds or browser suites. All fourteen native
connections must be mapped and proxied; no candidate receives an independent
capacity allowance. One shared medium includes return packets and every
connection. Matching loss seeds do not guarantee identical lost payloads after
candidates generate different traffic.

- WebKit pairs on a clean 6 MiB/s shared medium, with 10 ms one-way delay:
  median Send-to-Verified 13,983 → 13,625 ms, **2.63% higher throughput**. One
  paired seed is about 1% slower; this capped clean link shows little benefit.
- The same WebKit configuration with about 1% encrypted-datagram loss:
  19,559 → 15,856 ms, **23.35% higher throughput**, with every pair faster.
- Clean WebKit pairs with a 12 MiB/s shared medium and the same delay:
  10,672 → 8,385 ms, **27.27% higher throughput**, with every pair faster.
  This demonstrates headroom under different capacity settings, not a doubling
  of the earlier 0.3.31 statistic under identical conditions.
- WebKit sending to actual Chromium 101 with 150 ms notification delay after
  strict IndexedDB completion, on the 6 MiB/s medium: clean median
  14,123 → 14,023 ms, **0.71% higher throughput**; one pair is slower. With 1%
  loss, 20,375 → 15,570 ms, **30.86% higher throughput**, every pair faster.
- A 32 MiB + 111 slow-storage control uses actual Chromium 101, 1,000 ms
  completion notification delay and a clean 12 MiB/s shared medium. Timings
  are 10,952 versus 10,932 ms, essentially unchanged. Both copies verify.
  Increasing native connections does not remove this storage constraint.

These are desktop-engine models. WebKit's receiving fixture uses IndexedDB;
the user's iPhone used OPFS. Neither these gains nor the fourteen connection
count proves doubled physical phone throughput.

A 100 ms one-way / 12 MiB/s long-route control exposed a limitation of forcing
payload across all fourteen associations: 32 MiB + 111 verified bytes took
82,198 ms. The first seven-connection control failed pairing without payload.
Its retry completed and passed independent stored-byte SHA-256 with a retained
batch timing of 40,053 ms, but failed the fixture's connection-count assertion:
seven sockets mapped versus six surviving open connections. This is not a valid
strict seven-versus-fourteen speed pair, yet the large difference is a useful
regression warning and is not discarded as a pre-payload failure.

The final scheduler keeps fourteen connections open but selects at most seven
payload paths when the lower-median observed minimum receipt delay exceeds
80 ms. Nearby links retain the wider pool. Existing cooldown exclusions are
applied before selection; receipts and repair still process packets originally
sent on paths outside the selected pool. Feedback uses the selected healthy
paths. The threshold is a conservative guard for the observed long-route issue,
not a claim of an optimal path count for every network. Diagnostics separately
report bounded `activePayloadConnections` on both peers; older peers can omit it.

The guarded fourteen-connection long-route copy independently verifies in
41,596 ms, avoiding the observed 82-second behavior without expanding buffers.
A final-build nearby capacity pair still verifies all bytes using fourteen
active paths: 10,477 → 8,880 ms, **17.98% higher throughput**. This single control
does not replace the repeated earlier models or certify physical phone speed.
The [numeric record](benchmarks/2026-10-13-fourteen-connection-research.json)
keeps accepted measurements and excluded fixture attempts distinct.

The record contains **37 accepted, independently byte-verified native transfers**,
plus the separately described hash-verified control excluded for its connection
count. Final TypeScript, ESLint, build, formatting and 243 unit/integration cases
pass. New cases cover fourteen-way distribution, lower advertised peer limits,
serialized setup/cancellation, learned-delay boundaries, repair of pending bytes
from a path outside the active pool, and bounded optional active-path metadata.

Five modern Chromium browser cases pass 400 MiB OPFS/IndexedDB copies and
byte-exact downloads, 125-file handoffs, source waits/pause and nine transport
compatibility/recovery modes. Actual Chromium 101 passes six mobile/cache and
lost-packet/closed-lane/500 ms receipt cases. Its source-pause case initially
failed before a sender response existed, then passes with host-only localhost
ICE. Mixed-version checks initially lost native connectivity or stalled during
pairing; with external STUN discovery isolated, both directions pass independent
readback with seven connections, and current peers pass with fourteen.
This supports a fixture discovery issue, not proof of its exact cause. The
optional host-only wrapper changes neither real native file transport nor
production ICE configuration and does not certify internet NAT traversal.
Two final WebKit cases pass real pairing, readback/export verification,
reconnect and held-source/pause-to-verified behavior. The release has fifteen
passing browser cases in total. An optional fixture helper was renamed after
React Hooks lint mistook its initial `use` prefix for a component hook; the
helper's behavior is unchanged.

0.3.32 is published from `e8b94994fb2360bf2502826ac994a03282e2cfa1`.
Pages commit `c3b14a5e756c63c20e77ef519df53ba65d66e4ef` reports built without
error. Live metadata identifies the tested source/version. HTML, all four
compiled assets and the third-party notice match the local distribution byte
for byte. A fresh actual Chromium 101.0.4951.15 context confirms the live footer,
all three pickers and both mobile roles at 360 px with no runtime errors or
horizontal overflow. Active user tabs were not refreshed. Physical phone
throughput still needs the same-file/device/Wi-Fi comparison with both peers on
0.3.32; publication does not establish a doubled physical speed.

## October 14 · 0.3.33 saving controls and connection animation

The user's physical iPhone-to-Mac 0.3.32 report verifies 421,259,466 bytes
in 89,435 ms from Send through Verified: 4.71 decimal MB/s. All fourteen
connections carried payload. Source reads average 4 ms; Mac OPFS commits
average 3 ms. The completed sender sample retains 452 ms maximum path queue
delay and 194 recovery sends. These idle samples do not identify the limiting
path during transfer. The later sender ICE failure occurs about 264 seconds
after the batch finishes; it is not evidence of failure during that verified
transfer. Hidden visibility is also reported after completion. The physical
result justifies investigating transport queues before enlarging storage windows.

This release groups the receiver folder action, preparation, native app/location
saving, verified downloads and next-batch selection in one responsive action
group below the contained file list. Existing direct writable-folder selection
and independent destination readback remain available when the browser exposes
showDirectoryPicker. The user explicitly chose browser-only native saving for
Safari. An enabled folder action expands browser-specific saving guidance rather
than leaving a disabled control. Mac Safari uses Settings → General → File
download location → Ask for each download, then its native download/save dialog.
This is a browser setting, not a writable-folder permission granted to SpeedGate.
Apple documents this setting at
https://support.apple.com/en-ie/guide/safari/ibrw1072/mac .
Other unsupported browsers retain native sharing when available and their own
download destination settings. No native helper is introduced.

The green dashed connection visual keeps its device types and direction. A
rounded packet with a fading tail now travels inside a clipped lane and fades
before the arrowhead. The packet cannot overshoot the arrow. Pausing hides it;
reduced-motion preference makes it static. This uses CSS/SVG without JS ticks.
Actual Chromium and WebKit browser cases sample the animated packet at five
positions for 320, 390 and 1280 px viewports, test pause/reduced motion, and finish
the same real transfer with independent stored-byte SHA-256 verification.
Saving cases exercise grouped controls, native sharing cancellation, original
bytes and truthful Safari folder guidance. Seven browser cases pass, with the
existing WebKit OS-sharing mock case intentionally skipped. TypeScript, ESLint,
build and all 243 unit/integration cases pass. The packet screenshot was inspected.
No transport tuning is included in this UI release; speed research continues
against the unchanged 0.3.32/0.3.33 transport.

Actual Chromium 101 also passes the four saving/animation/source cases. Its SVG
visibility bounds initially made the pause assertion report visible despite the
computed display state. Checking computed `display: none` resolves that fixture
assertion; the rerun completes and independently verifies the original bytes.

0.3.33 is published from `4e88b7ccbd7b7be7e7a7adcf4e38a2a94c60146c`;
Pages `9e5d873817788948cab13189148caf2d61a3b29a` reports built without error.
Live HTML, all four compiled assets and notices equal the tested distribution.
A fresh actual Chromium 101 context verifies the 0.3.33 footer and receiver saving
group at 360 px without horizontal overflow or runtime errors.

## October 14 · 0.3.34 isolating minority transport queues

The next speed change addresses a sender policy found during code inspection:
any one path's excess receipt delay previously reduced aggregate sender credit,
burst size and pacing for every healthy sibling. With five or more observed
participating paths, those four sending decisions now use the upper-quartile
queue delay. Smaller pools retain the maximum. With fourteen observations this
can isolate up to three delayed paths; with five, one. Broad congestion still
reduces credit and restores timed pacing. Worst-path `queuedDelayMs` and per-path
reporting remain unchanged, so a slow connection is still visible.

The existing fourteen-connection negotiation, seven-path long-route guard,
receiver window, aggregate retained-payload limits, independent receiver
readback, checkpoints, pause/cancellation, retry and reconnect behavior remain.
This changes how the existing bounded credit is used; it does not raise the
memory or connection limits. It also leaves production ICE routes unchanged.

The research checks the protocol distinction in
[RFC 8831 section 5](https://www.rfc-editor.org/rfc/rfc8831.html#section-5):
SCTP congestion control is per association. The
[WebRTC bufferedAmount definition](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamount)
excludes OS/network buffering. These sources support retaining receipt feedback
and bounded application credit; they do not prescribe this percentile policy
or establish its performance. The policy is evaluated by the comparisons below.

Baseline 0.3.33 preserves the 0.3.32 transport. Repeated native WebKit sending
models use 64 MiB + 111 original bytes, a single shared 12 MiB/s medium including
return traffic, and 10 ms added one-way latency. All fourteen connections are
mapped and proxied; every accepted copy passes an additional independent stored
SHA-256 check. Trials alternate baseline/candidate order, without concurrent
builds or other browser suites. An initial baseline run overlapping a candidate
build is excluded as warmup. These are desktop-engine models, not phone Wi-Fi
measurements or a promise of the same improvement on the user's devices.

- Chromium OPFS receiver, three clean pairs: median Send-to-Verified
  8,444 → 7,698 ms, **9.69% higher throughput**. Every pair improves.
- One bulk path receives an extra 120 ms each way from setup, same shared medium:
  three pairs, 8,863 → 8,466 ms, **4.69% higher throughput**, all pairs improve.
- About 1% encrypted-datagram loss, three completed pairs using seeds 7, 14, 21:
  11,585 → 10,833 ms, **6.94% higher throughput**, all completed pairs improve.
  The original third pair fails: the baseline pauses before verification and the
  candidate times out after 180 seconds. Both same-seed retries complete and
  verify their stored bytes. The original failures remain in the record and are
  not counted as timings. Their cause is unresolved; successful retries do not
  prove the absence of intermittent stalls in these engine/proxy conditions.
- WebKit receiver using its actual IndexedDB backend, three clean pairs:
  8,825 → 7,917 ms, **11.47% higher throughput**, all pairs improve. This is a
  WebKit engine check; it does not substitute for the Mac/iPhone OPFS setup.
- Actual Chromium 101 with 150 ms added notification delay after strict
  IndexedDB completion, 32 MiB + 111: 4,852 → 4,588 ms (**5.75%**). Both report
  171 ms average commit time. The storage limit remains rather than disappearing.
- A 100 ms one-way long-route control, 32 MiB + 111: 30,744 → 30,580 ms,
  essentially unchanged. Both keep fourteen open and seven active paths and
  independently verify their stored bytes.

Clean Chromium models use somewhat more recovery sends (16–28 versus 2–6),
while finishing faster. The maximum shared wire queue remains under 0.8 MiB
in those runs; unchanged application bounds still apply. This tradeoff is kept
visible alongside timing rather than claiming congestion or duplicate traffic
has disappeared. The comparison fixture now supports bounded per-path delay
and retains structured failure diagnostics when a result path is supplied.

New unit cases cover minority queue growth, small-pool fallback, broad queue
growth, actual transport credit/pacing, unchanged maximum diagnostics and all
receipts being released. All 245 unit/integration cases, TypeScript and ESLint
pass. The numeric comparison is retained in
[the sanitized record](benchmarks/2026-10-14-queue-policy-research.json).

A sustained 400 MiB + 111-byte native comparison also independently verifies:
50,708 → 43,626 ms from Send to Verified, **16.23% higher throughput**. Payload
timing is 47,928 → 41,001 ms. Both use fourteen paths and the same shared 12 MiB/s
medium. Replays are 39 versus 48 and total wire bytes grow about 0.2%. This is a
single sustained model pair, not a repeated physical iPhone/Mac or Pixel result.
The research record contains thirty accepted byte-verified native copies, the
two original failed loss attempts, and a separately excluded warmup.

The final compiled candidate passes eighteen modern Chromium browser cases:
400 MiB OPFS and IndexedDB transfers, byte-exact downloads and directory readback,
125-file handoffs/batching, mobile selection, cancellation and sharing, screen
awake state, both storage-cache deletion paths, unchanged allowance estimates,
source pause/resume and nine transport compatibility/recovery modes. Optional
host-only isolation is now also available in the large-file fixture to remove
external STUN discovery from same-host checks; native transport is retained.
The final build emits the same `index-CeJyNSO8.js` as the native timing trials.

Five final actual Chromium 101 cases pass: both cache backends, unchanged browser
allowance estimates, held source/pause-to-verified behavior, and independent stored
readback after a dropped packet, closed lane, and 500 ms delayed receipts. A final
WebKit source/pause-to-verified case passes too, giving twenty-four passing browser
cases for the compiled candidate. TypeScript, ESLint, production build, formatting
and diff whitespace checks pass. The physical phone/Mac gain remains unmeasured.

0.3.34 is published from `a48765b15d9ddcff62a6aab587c1aa9457f8def0`.
Pages `f1b29c8a7176f20574f782d4b5daa91059d8b49d` reports built without error.
Live build metadata matches that exact source/version, and HTML, all four
compiled assets and third-party notices match the tested distribution byte for
byte. A fresh actual Chromium 101 context verifies the 0.3.34 footer and receiver
action group at 360 px without overflow or runtime errors. Active user tabs are
not refreshed, and the existing 8787 server is not changed.

## October 14 · 0.3.35 investigating physical regression and isolating speed measurements

The user's same-version iPhone-to-Pixel 0.3.34 run verified 421,259,466 bytes
in 186,731 ms: **2.256 MB/s decimal**, below the earlier roughly 5 MB/s
observation. A second run approached 4 MB/s. Fourteen paths carried traffic;
1,359 application replays and up to 497 ms excess receipt delay justify
investigating duplicate traffic and queue feedback. Source reads averaged 5 ms
with only 5 ms total waited time. Pixel IndexedDB commits averaged 143 ms,
close to the earlier faster report's 147 ms, so these averages alone do not
identify storage as the cause. The Pixel's failed ICE state, one remaining
connection, and hidden sender visibility were captured many minutes after
successful verification. They do not establish a mid-transfer disconnect or
background pause. No Wi-Fi capacity measurement was supplied for either run.

An unpublished experiment excluded short application-demand gaps from path
capacity estimates. It did not produce a broad repeatable gain and slowed the
100 ms one-way control from 31,443 to 36,978 ms. It was rejected before release;
0.3.34 capacity estimation is retained. Its other outcomes, including slower
400 MiB and WebKit controls and mixed repeated loss results, remain in the
benchmark record. Five- and seven-path exploratory controls also slowed the
CPU/storage-limited model, so fourteen remains the automatic nearby limit.

Two narrower unpublished candidates changed nearby-path replay grace using
smoothed delay and variation, inspired by [RFC 6298](https://www.rfc-editor.org/rfc/rfc6298.html#section-2).
The second also preserved the old delay as a floor. Both remained application
hedges above native SCTP, rather than replacing its timer. Neither produced a
consistent completion-time improvement, despite fewer duplicate frames in some
models. Both were rejected. The release retains the published retry timing and
path-capacity estimator.

The retained optimization reuses the eligible payload-path list within each
bounded synchronous send burst. Previously every frame rebuilt that list,
queried all bulk channel states and sorted unchanged receipt observations.
Scheduler weights still use each frame's updated outstanding bytes. The chosen
bulk channel's native state is checked before use; a closed selection rebuilds
the list immediately. Every burst discards its list in `finally`, including
send failures, so later tasks rediscover changed or recovered paths. Pacing,
credit, frame limits, recovery timing and connection counts remain unchanged.
A fault case closes a native path before its close event and checks that the
burst avoids it, then rediscovers it on the next burst after reopening.

Manual network checks separate three different observations:

- **Peer link:** 8 MiB synthetic bytes on the current existing sender paths,
  with no source reads, file hashing, file manifests or staging writes. Both
  peers retain bytes, duration, rate, time and used path count. A deduplication
  bitmap and session IDs reject duplicates and late payloads. A 15-second
  deadline, bounded buffers and explicit cancellation release the probe.
- **Internet download:** up to 8.25 MiB from Cloudflare, including a 256 KiB
  warmup and two parallel 4 MiB measured requests. Streaming GETs omit
  credentials and referrer, bypass caches, reject unexpected response lengths,
  and expire after 15 seconds. No SDK, upload or automatic test is used.
  The endpoint is documented by [Cloudflare](https://github.com/cloudflare/speedtest/blob/main/README.md).
  Provider IP/location response headers are neither read nor stored.
- **Browser hint:** supported Network Information API estimates are labelled
  estimates, with unsupported values omitted. This follows the distinction in
  the [Network Information specification](https://wicg.github.io/netinfo/).
  An internet result includes the ISP/server path; a peer result includes
  WebRTC/browser work. Neither is a Wi-Fi radio maximum or proof of causation.

Peer tests require both endpoints to advertise the capability, refuse active
file/save operations, and abort on file start or disconnect. The binary probe
namespace is isolated from framed file traffic, and raw fallback originals
beginning with the same four bytes remain byte-exact. Sender-only Automatic,
up-to-seven and up-to-five controls affect future payload participation on the
current connection; they do not alter protocol compatibility, close peers,
change persisted defaults or permit changing the limit mid-transfer. Sender
stage durations accumulate source preparation, reading, sending, yielding,
backpressure, acknowledgements, verification waits and pause time; final totals
stop at batch completion instead of growing during idle minutes.

Unsupported folder guidance is now a text disclosure below saving controls.
Actual writable-folder pickers remain functional on supporting browsers.
Mac Safari retains native downloads and explains Apple's
[Ask for each download setting](https://support.apple.com/en-ie/guide/safari/ibrw1072/mac).
A browser-only site cannot force Safari to display a destination dialog when
the user has configured automatic downloads. No helper app is installed.

The retained candidate is compiled as `index-DiTsAP3s.js`. Final native controls
use the same fixed 0.3.34 baseline, alternate order by trial and independently
hash every stored copy. Clean 64 MiB timing is 7,386 → 7,373 ms. The repeated
Chromium 101 receiver with main-thread CPU factor four and 150 ms added strict
IndexedDB completion delay has median 12,971 → 12,895 ms across three pairs;
every candidate finishes slightly sooner, but the roughly 0.6% median change is
small and does not establish a large gain. The seeded 1% loss control is
13,767 → 13,683 ms. The separate 400 MiB control is 44,596 → 43,768 ms (1.89% higher
throughput in one pair, insufficient to establish a general improvement). These
models do not reproduce iPhone hardware or certify restored physical 5 MB/s.
All twelve retained-candidate comparisons independently verify stored bytes.
The full record also preserves all 68 completed trials of rejected candidates,
including their negative results:
[raw comparisons](benchmarks/2026-10-14-speed-isolation-research.json).

Validation for the retained candidate: TypeScript, ESLint, all **259** unit and
integration checks and the production build pass. **32 browser cases** pass:
twenty in modern Chromium, seven in actual Chromium 101 and five in WebKit.
Coverage includes 400 MiB originals through OPFS and IndexedDB with independent
saved-byte hashes and directory readback, 125-file native handoffs/download
batches, cache deletion and retained partials, held-source/pause reporting,
nine compatibility/recovery modes plus old-engine dropped-packet, closed-path
and 500 ms receipt-delay cases. New network cases verify repeated five/seven
path probes without file manifests, a subsequent untouched original download,
manual-only bounded internet requests, cancellation and automatic internet-test
abort when a remote file transfer starts. The new close-before-event unit case
also validates burst-list refresh and rediscovery.

A separate browser smoke check completes the real Cloudflare dummy download
under the shipped CSP. A first smoke helper incorrectly expected unsupported
folder guidance in Chromium while its real folder API was available; after
explicitly disabling that API in the isolated mobile fixture, the view passes
at 360 px without overflow or runtime errors. Actual supported pickers remain
in the product. The short desktop internet sample is labelled as such and is
not used to claim phone Wi-Fi capacity. Native comparison bundles remain fixed
during timing trials; no concurrent browser suites or builds affect them.

0.3.35 is published from `b5bc41bd2535ce568bd81142e0ef9915f7bb1069`.
Pages `fdfa1096ede8aa3201a3ca2ee1157217911beb05` reports built without error.
Live build metadata matches that exact source and version. HTML, all four
compiled assets and third-party notices match the tested distribution byte for
byte. A fresh actual Chromium 101 context verifies the published 0.3.35 footer,
both roles and the unsupported-folder text disclosure at 360 px without
overflow or runtime errors. The owned 8798/8799 test servers are closed;
existing 8787 and active user tabs remain untouched.

## Verified 0.4.0 publication · October 15, 2026

Published SpeedGate **0.4.0** from source `9bb6c62520ed2eb1fd3badc2b98db0fbe84a32b0`
through Pages commit `a7a7fc6a944b7e28e883f185cc50e7f3c7bfd02b`.
[GitHub Pages deployment](https://github.com/s4lmon778/PixelGate/actions/runs/38843265581)
succeeded. The [main app](https://s4lmon778.github.io/PixelGate/) reports 0.4.0;
[the preserved 0.3.35 app](https://s4lmon778.github.io/PixelGate/releases/0.3.35/)
retains source `b5bc41bd2535ce568bd81142e0ef9915f7bb1069`.
All six prior root entries, including the complete asset tree, match the original
published Git objects. Both public pages loaded their expected brand/version
without JavaScript exceptions; fetched entry JS/CSS matched published bytes.
The real Chromium peer-transfer, staged-byte readback, export-verification and
reconnect check passed against each live URL (5.2 s for 0.4.0; 4.8 s for 0.3.35).
These are correctness checks, not physical throughput measurements.

The prepublication check passed TypeScript, ESLint, all 271 unit/integration
cases, formatting and the production build. GitHub Pages retains the no-install
WebRTC flow; HTTP/TCP requires the optional LAN helper. The user's approximately
3 MB/s iPhone-to-Pixel baseline has no new physical comparison in this deployment.
