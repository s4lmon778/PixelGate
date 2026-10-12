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
hours. Continue useful work after usage resets. Preserve the uncommitted 0.3.21
work. Do not declare the speed target achieved without a physical-device result.
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
