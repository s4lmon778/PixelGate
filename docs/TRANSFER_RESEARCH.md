# Transfer research and bounded per-path flow control

The October 10, 2026 Pixel diagnostic reported a roughly 479 ms selected-route
round trip while receiving into IndexedDB on Chrome 101. A strong 5 GHz signal
does not explain that delay. This investigation reproduces transport delay in
native browser WebRTC before changing the application sender.

## Findings and implementation

The previous sender used the worst path's queue delay to reduce the flight
budget for every connection, sometimes to 128 KiB. One delayed association
therefore restricted healthy siblings too. The replacement estimates each
association's application credit from its measured delivery rate and minimum
receipt delay. Credit starts at 128 KiB, has a two-message floor, and is capped
at 1 MiB per path and less than 4 MiB in total. Extra queue delay reduces credit
on that path. Native SCTP still controls congestion.

After 512 KiB of confirmed delivery, mutually capable peers use 8 KiB wire
messages when the lowest observed baseline receipt delay exceeds 100 ms.
Low-delay connections keep the existing 64 KiB wire messages. This addresses
native SCTP fragmentation behavior without increasing connection count or
changing the reliable, unordered bulk channels. A new optional hello capability
keeps smaller messages out of old receivers.

Selective receipts can release byte credit past a missing sequence. A separate
sequence credit limit prevents that hole from admitting more frames than the
transport's bounded reorder queue can hold. The receiving storage queue permits
more entries only when smaller messages are negotiated; its 4 MiB byte limit is
unchanged. Durable checkpoint acknowledgements, retransmission, resumption, and
independent stored SHA-256 verification remain in place.

There was also a startup bottleneck: the 500 ms lane preparation timeout could
expire before bulk ICE/DTLS finished on a delayed route. The first file then
negotiated a 1 MiB receiving window for its entire transfer. Capable modern peers
now wait up to five seconds, returning immediately when all negotiated lanes
open, any lane fails, or the connection closes. Older peers keep the 500 ms
fallback. No larger receive window is granted unless the bulk lanes are open.

## Research used

- [WebRTC performance experiments](https://github.com/exnimbus/webrtc) separate
  native transport throughput from application behavior and investigate message
  sizes, independent associations, and bounded queues. Their parameter search
  penalizes draining time and queue growth. This motivated testing complete
  verified transfers instead of selecting the fastest raw send loop.
- [Google BBR](https://github.com/google/bbr) and its
  [FAQ](https://github.com/google/bbr/blob/master/Documentation/bbr-faq.md)
  motivated measuring delivery rate, baseline round trip, and extra queuing.
  PixelGate implements application credit inspired by these measurements;
  it does not install BBR or change the browser's congestion controller.
- [libp2p's WebRTC stream](https://github.com/libp2p/js-libp2p/blob/main/packages/transport-webrtc/src/stream.ts)
  uses native buffer backpressure. PixelGate retains buffer checks and additionally
  bounds bytes retained beyond the browser's visible bufferedAmount.
- [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html) explains that streams
  within one SCTP association share congestion control and WebRTC does not use
  SCTP multihoming. Independent peer connections are useful here, but a browser
  cannot bind them to separate Wi-Fi or cellular interfaces like a native
  multipath program can.

No external implementation or new production dependency was imported.

## Experiments

`tests/browser/udp-impairment.ts` optionally forwards the test contexts' native
ICE/DTLS/SCTP packets through local UDP sockets. A 240 ms delay in each direction
produces approximately 480 ms native RTT. Each run checks selected-route RTT,
forwarded wire bytes, durable byte totals, and the actual stored SHA-256 against
a Node-generated source hash. Distinct frame markers catch reordering and
duplication errors. This helper changes no system routing and is absent from
the production bundle.

An initial 8 MiB comparison improved from 28.7 to 7.9 seconds, but the old peer
used a 1 MiB receiving window while the candidate used 4 MiB. To isolate flow
control, a second baseline was built from `3f735c6` with only its preparation
timeout increased to five seconds. Both sides then advertised 4 MiB. The
32 MiB comparison took 48.2 seconds on that baseline and 13.1 seconds on the
candidate. A final repeat measured 49.5 seconds versus 13.7 seconds (3.6× faster).
Both comparisons used five associations, zero application replays, and matching
stored hashes. These are individual controlled workstation measurements, not a
statistical estimate of real Pixel performance.

WebKit sending to an actual Chrome 101 executable at the same native delay
completed 16 MiB originals in 10.9 seconds, 10.9 seconds with a missing packet
recovered, and 10.2 seconds with delayed IndexedDB completion. Actual stored
hashes matched in every case. This exercises an older desktop browser build;
it does not emulate the Pixel's hardware or Android browser integration.

A separate WebKit-to-Chromium loopback run transferred a 5 GiB + 23 byte file.
Source hashing, transfer, and stored readback took 100.7 seconds; streamed folder
saving and verification took a further 39.0 seconds. The downloaded copy and
folder copy both matched the independently generated source hash. This run used
OPFS and the test folder-picker surrogate, with no artificial network delay.

Timings cover the first payload send through durable completion acknowledgement.
Pairing, source hashing, and lane preparation precede that interval. The UDP
forwarder models delay, not radio contention, loss distributions, thermal
throttling, or the Pixel's flash and CPU. It is not kernel netem; timer scheduling
and local sockets can influence the results. A physical iPhone-to-Pixel retest
is required to establish the actual Wi-Fi gain.

Rejected experiments included nine associations (worse complete-transfer time
despite a faster raw channel benchmark), a fixed 4 MiB flight allowance (more
queuing), and ordered bulk channels (no useful gain). Five associations remain.

## Reproducing validation

Build and serve the candidate, plus the startup-matched baseline, on separate
local origins. Run:

```sh
npm run check
npm run build
PIXELGATE_TEST_URL=http://127.0.0.1:8789 \
  PIXELGATE_TEST_BASELINE_URL=http://127.0.0.1:8790 \
  PIXELGATE_TEST_UDP_DELAY_MS=240 PIXELGATE_TEST_MIB=32 \
  PIXELGATE_TEST_COMPARE_MODES=baseline-local,pipeline-local \
  npx playwright test tests/browser/throughput.spec.ts --project=chromium
```

Use `PIXELGATE_TEST_ALL_ENGINES=1` and `--project=webkit` for WebKit sending to
Chromium. Set `PIXELGATE_TEST_CHROMIUM_EXECUTABLE` to a Chrome 101 executable to
exercise its native SCTP and IndexedDB fallback. Modes `pipeline-lost-packet`
and `pipeline-storage-delay-udp` check recovery and delayed strict storage
completion. `PIXELGATE_TEST_MIXED_PEERS=1` tests both directions with an older
deployed bundle. The large-saving fixture accepts
`PIXELGATE_TEST_LARGE_MIB=5120`; it verifies the stored, downloaded, and streamed
folder copies of a 5 GiB + 23 byte original. Its folder picker is a test surrogate,
so it does not establish Android picker or Google Photos behavior.
