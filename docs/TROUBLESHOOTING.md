# Troubleshooting

## Pairing succeeds but the direct connection times out

Confirm both devices use the current app version. Connection details are exchanged automatically; normal six-digit pairing requires no IP lookup. Diagnostics expose candidate delivery and route states without exporting addresses.

Use the same exact network on both devices. For example, a campus's guest and protected networks can have different routing and access policies. Guest, campus, hotel, and workplace Wi-Fi may allow internet access while blocking local discovery or connections between devices; sharing a network name does not guarantee reachability. A completed transfer on a hotspot but not on another network supports a network-dependent restriction, without identifying the exact policy.

Timeout messages automatically distinguish incomplete description exchange, rejected candidates, and a failed direct route. If both configured STUN services report error 701 and no local server-reflexive candidate was gathered, the message also reports their unreachability. These observations cannot establish which router or firewall rule is responsible. Ask the network administrator whether local mDNS discovery and direct WebRTC UDP traffic between your devices are allowed, or use a trusted network that permits local connections. PixelGate cannot change network access rules. No TURN relay is configured. Specific hardware and network observations are recorded in [VALIDATION.md](VALIDATION.md).

For advanced local-discovery diagnosis, the receiver can revoke the failed connection and enter the **sender's local IPv4 address** under **Advanced network settings** before creating a fresh code. Find the address in the sending device's network settings for its current Wi-Fi or wired connection. The address is used locally to try the negotiated UDP application port; it is not added to pairing metadata, history, or exported reports. This optional route cannot bypass blocked device traffic or provide IPv6-only connectivity. Normal ICE signaling already exchanges network information.

## Transfers are much slower than Wi-Fi internet downloads

Reload both devices to use the same current build. PixelGate negotiates independent parallel peer connections, reassembles their chunks in order, and overlaps up to four durable checkpoints. Older clients and failed extra connections keep a single connection; no stored files or history need to be cleared. New clients negotiate up to five independent connections, adapt pacing from receipts, replay gaps over another connection, and temporarily avoid a slow lane. A dropped bulk connection retransmits unreceived packets over the original route. Version 0.3.18 measures queue growth relative to each path’s own normal receipt latency. Healthy paths now grow from 512 KiB to nearly 4 MiB of credit after 8 MiB of successful delivery, with 512 KiB bursts that continually refill as receipts arrive. Stable high latency no longer forces small send windows, and a path already excluded during recovery does not throttle its healthy siblings. Growing queues still reduce credit and restore conservative pacing; hard memory bounds and durable progress are unchanged. Reload both devices before comparing speeds.

Internet-download speed measures a different path from device-to-device transfer. Direct transfers also depend on source reads, receiver storage, packet loss, and browser scheduling. Keep both tabs in the foreground and compare one reasonably large synthetic file; many small files include repeated hashing, file-open, and verification work. A trusted local network or hotspot can help distinguish a network-dependent slowdown from storage or device limits.

While the transfer is running, open **Connection diagnostics** and copy the report on both devices. It now includes the primary selected route’s candidate types, UDP/TCP, round-trip time and byte-rate samples, plus the active connection count, receipt delay, estimated queue growth above each path’s baseline, buffered bytes and packet replays. The latest report is saved locally and remains available after disconnect, reload, or file cleanup; Clear saved report removes it. Safari reports from older releases cannot be reconstructed from transfer history or cached application assets. Compare reports for the same large file on Wi-Fi and hotspot. The primary route’s byte counters cover that connection, not aggregate throughput across all five. Report the displayed speed and units; MB/s and Mb/s differ by eight. No addresses or file details are exported.

Parallel connections do not select Wi-Fi networks or combine Wi-Fi and cellular bandwidth. Browsers leave interface routing to ICE and the OS. Performance measurements and their injected latency are recorded in [Validation](VALIDATION.md); they are not a guaranteed physical-device speed.

## A large video cannot be handed to Google Photos

Try **Save to Photos folder** on Android Chrome 132 or newer. Choose or create `DCIM/PixelGate` in internal storage and allow editing. All verified browser copies save into that folder, without a fifty-file limit, and future transfers save there automatically while this tab stays open. Enable PixelGate once in Google Photos device-folder backup. Original bytes are preserved, and each destination is reread and hashed. If the button is unavailable, update Chrome through the Play Store and reopen the page; embedded browsers and other browsers may lack this API. A folder-write failure retains verified staging for retry or downloads. [Chrome folder-access documentation](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).

Chrome on Android rejects native file sharing above 50 MiB per file and limits each handoff to ten files. PixelGate routes larger files to verified downloads instead of attempting a known unsupported handoff. Choose **Download all selected** for the collection, allow multiple downloads, and keep the tab open. In Google Photos, open **Collections → On this device → Download**, then enable that folder under **Photos settings → Backup → Back up device folders**. Older versions may say Library or Downloads. Files can also move the media into `DCIM/PixelGate` for device-folder import. [Google’s folder guide](https://support.google.com/photos/answer/6193313?co=GENIE.Platform%3DAndroid&hl=en).

A website cannot force a particular app or album. Download/share requests retain verified browser copies and leave saved-copy verification pending; check playback and backup in Photos, and independently verify saved copies before clearing staging.

## Browser storage rejects a checkpoint

PixelGate stops before acknowledging an invalid native write result or missing file growth. Keep the source and retained browser data, save and verify completed files, and free space if needed. A regular browser tab may have different limits from a temporary context. Reconnect and reselect the same originals to resume from the last durable checkpoint. The app does not silently treat quota or integrity failures as missing APIs.

## What does “Estimated staging space” mean?

It is the browser-reported quota minus estimated usage for the site's origin, not reserved free disk space. Estimates vary across browsers, profiles, and devices; actual free disk space may be lower. Each file must fit alongside copies still staged in that browser, with headroom for checkpoints and records.

For larger collections of documents, media, archives, or other files, work in batches: save or download the files, verify the saved copies, then choose **Clear verified staging** to make room for the next batch. Direct folder mode retains staging until cleared, so allow disk space for both staged and destination copies. The estimate does not measure destination-folder free space or limit how much the sender can select. Clearing site data or browser eviction can remove staged files and history.

## Safari says the operation failed for an unknown transient reason

This error can occur during the browser-storage check before a pairing code is created. PixelGate now tests compatibility storage automatically when OPFS is exposed but inaccessible, and retries unsupported Blob checkpoints as bounded byte buffers. If neither storage path works, the error identifies the receiving preflight and suggests a regular tab, allowing website storage, closing older PixelGate tabs, and checking device space. Existing staged files are not automatically deleted.

A Private or temporary browser session may discard its stored files when the session closes. Save and independently verify received copies before closing it. The app tests usable storage; it does not identify, record, or upload a user's browsing mode. [WebKit's OPFS documentation](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/).

## How do I resume an interrupted transfer?

Create a fresh receiver connection, pair again, reselect the same source files, and send. The receiver reconciles retained checkpoints. Changed sources start a separate transfer; verified files are skipped only when their stored copies remain available and pass readback.

## What if the pairing service is unavailable?

Choose **Use copy/paste pairing** before creating a connection. This exchanges complete SDP descriptions through links and a copied sender response without PeerJS. It still requires a working direct WebRTC route.

[Saving and batch guide](USAGE.md) · [Validation record](VALIDATION.md) · [Report an issue](https://github.com/s4lmon778/PixelGate/issues)
