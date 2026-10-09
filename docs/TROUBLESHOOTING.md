# Troubleshooting

## Pairing succeeds but the direct connection times out

Confirm both devices use the current app version. Connection details are exchanged automatically; normal six-digit pairing requires no IP lookup. Diagnostics expose candidate delivery and route states without exporting addresses.

Use the same exact network on both devices. For example, a campus's guest and protected networks can have different routing and access policies. Guest, campus, hotel, and workplace Wi-Fi may allow internet access while blocking local discovery or connections between devices; sharing a network name does not guarantee reachability. A completed transfer on a hotspot but not on another network supports a network-dependent restriction, without identifying the exact policy.

Timeout messages automatically distinguish incomplete description exchange, rejected candidates, and a failed direct route. If both configured STUN services report error 701 and no local server-reflexive candidate was gathered, the message also reports their unreachability. These observations cannot establish which router or firewall rule is responsible. Ask the network administrator whether local mDNS discovery and direct WebRTC UDP traffic between your devices are allowed, or use a trusted network that permits local connections. PixelGate cannot change network access rules. No TURN relay is configured. Specific hardware and network observations are recorded in [VALIDATION.md](VALIDATION.md).

For advanced local-discovery diagnosis, the receiver can revoke the failed connection and enter the **sender's local IPv4 address** under **Advanced network settings** before creating a fresh code. Find the address in the sending device's network settings for its current Wi-Fi or wired connection. The address is used locally to try the negotiated UDP application port; it is not added to pairing metadata, history, or exported reports. This optional route cannot bypass blocked device traffic or provide IPv6-only connectivity. Normal ICE signaling already exchanges network information.

## Transfers are much slower than Wi-Fi internet downloads

Reload both devices to use the same current build. PixelGate negotiates independent parallel peer connections, reassembles their chunks in order, and overlaps up to four durable checkpoints. Older clients and failed extra connections keep a single connection; no stored files or history need to be cleared. A dropped bulk connection retransmits unreceived packets over the original route.

Internet-download speed measures a different path from device-to-device transfer. Direct transfers also depend on source reads, receiver storage, packet loss, and browser scheduling. Keep both tabs in the foreground and compare one reasonably large synthetic file; many small files include repeated hashing, file-open, and verification work. A trusted local network or hotspot can help distinguish a network-dependent slowdown from storage or device limits.

Parallel connections do not select Wi-Fi networks or combine Wi-Fi and cellular bandwidth. Browsers leave interface routing to ICE and the OS. Performance measurements and their injected latency are recorded in [Validation](VALIDATION.md); they are not a guaranteed physical-device speed.

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
