# Engineering decisions

Design rationale, implementation entry points, and regression evidence for PixelGate. For a runtime reference, see [Architecture](ARCHITECTURE.md).

## 1. Bound the transfer pipeline and apply backpressure

The versioned `Control` discriminated union separates JSON control messages from binary file frames. A `hello` handshake precedes manifests and payloads; the sender validates receiver offsets and checkpoint acknowledgments before advancing.

| Mechanism           | Current behavior                                                  | Reason                                                                               |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| File concurrency    | One active transfer; one subsequent file hashes ahead             | Overlap preparation with transfer while limiting payload work                        |
| Hashing reads       | Incremental 1 MiB slices in a worker                              | Hash large sources without allocating the entire file on the UI thread               |
| Transport frames    | Maximum 16 KiB                                                    | Bound each data-channel message and validate incoming frame sizes                    |
| Sender backpressure | Wait while `bufferedAmount` exceeds 512 KiB                       | Avoid continuously feeding a slower receiver or network                              |
| Durable checkpoints | Up to 1 MiB, with acknowledgment before the next block            | Bound unacknowledged payload and make restart offsets explicit                       |
| Receiver dispatch   | Serialized processing; close if more than 160 messages are queued | Prevent asynchronous writes from reordering the receive stream and bound queued work |

These bounds concern payload processing, not total browser memory: queue metadata, runtime overhead, and browser-managed buffers still consume resources. Throughput depends on hashing, storage, the browser, and the network; the repository does not claim an unmeasured performance target.

**Code:** [protocol types and constants](../lib/bridge/model.ts), [sender/receiver engine](../lib/bridge/transfer.ts), [incremental hash worker](../lib/bridge/hash.worker.ts).

## 2. Acknowledge persisted progress, not just received bytes

Checkpoint acknowledgment follows this order on browsers with synchronous OPFS:

```text
OPFS write -> access-handle flush -> IndexedDB transaction commit -> ACK(offset)
```

OPFS and IndexedDB are separate persistence systems, not a single atomic transaction. Writing bytes before committing metadata allows recovery to truncate an uncommitted tail to the last retained checkpoint. On reconnection, the sender reselects and rehashes its sources; the receiver checks the retained staged file and supplies the resume offset. Missing partials or files shorter than the committed offset restart instead of trusting a history entry. Complete-file readback still determines final integrity.

Browsers with unavailable OPFS use a capability-selected IndexedDB fallback. The staging worker commits each checkpoint and its stored byte length in one transaction, requesting `strict` durability when supported. Blob checkpoints are preferred; if the browser rejects Blob cloning, the failed transaction must abort before one retry using an ArrayBuffer of at most 1 MiB. Quota and permission errors are not retried as format changes. Both formats are readable without a database migration. Only after that transaction completes does the receiver commit the manifest offset/history and acknowledge it. The byte store is separate from manifest history; reconnection removes uncommitted tails in a transaction and rejects missing or noncontiguous chunks. Readback wraps each stored buffer as a Blob before retaining it, constructs a File from those Blob references, then hashes 1 MiB slices; the application does not concatenate a whole file into a JavaScript byte array. Browser memory use and quota still require device testing.

Preflight writes and independently rereads a full 1 MiB checkpoint before registering a receiver. An absent or unsupported file-system API, or a context-level OPFS UnknownError or SecurityError, triggers an independently tested compatibility backend. Quota, lock, and readback failures do not switch backends; failed compatibility preflight blocks receiving. Existing staged copies are found in either backend, including after a browser upgrade. Downloads and reselected-export verification work with both storage modes.

File identity is derived from content and path:

```text
fileId = SHA-256(UTF-8(sourceSha256 + "\n" + relativePath))
```

Changed source bytes receive a different identity. A retained verified file is skipped only after its stored bytes are reread and match. Receiver file records and their corresponding history entries are written in the same IndexedDB transaction.

**Code:** [identity derivation](../lib/bridge/hash.ts), [staging worker](../lib/bridge/staging.worker.ts), [chunk storage](../lib/bridge/indexed-staging.ts), [manifest transactions](../lib/bridge/database.ts). **Regression evidence:** [interruption and resume tests](../tests/transfer.test.ts), [real IndexedDB recovery and quota tests](../tests/browser/indexed-staging.spec.ts).

## 3. Model integrity as a property of a specific copy

`RecordFile` separates transfer `phase` from verification `scope`: `none`, `browser`, `destination`, or `exported`. Receiving all bytes is not enough to mark a copy verified.

- **Browser scope:** flush and close the staged file, reread its actual bytes, and compare size and SHA-256 against the source manifest. A mismatch removes the invalid staged copy and blocks saving.
- **Destination scope:** revalidate staged bytes, copy them through a destination writer, close it, and independently hash the saved file. A destination failure retains verified staging for retry.
- **Exported scope:** download initiation leaves verification pending. A reselected saved file must match before the exported copy is marked verified.

Native app handoff prepares `File` objects from staged Blobs after a fresh size/SHA-256 check, without a file-sized JavaScript buffer. Preparation and sharing use separate taps so a long hash does not consume the Web Share API's transient user activation. When available, `navigator.canShare({files})` probes the prepared payload before `navigator.share({files})` is invoked directly in the click handler. Browsers without the optional probe can attempt native sharing; unsupported payloads retain a verified-download fallback. Cancellation and unsupported payloads retain staging. A successful API result sets local `shared` metadata, never destination verification; reports explicitly distinguish the handoff from the saved-copy check. User-selected batches cap preparation at 20 files and render the list in pages of 50.

History clearing targets only the IndexedDB `history` store, in one transaction. Session clearing uses a cursor rather than deleting receiver manifests or staging chunks; interruption recovery does not depend on the presentation log.

Incoming manifests cannot assign their own verification status: receiver validation resets phase, scope, offsets, and destination state. Existing destination files are skipped only after size/hash readback; conflicting content receives a numbered filename. Relative paths reject traversal, absolute paths, control characters, and ambiguous separators before filesystem access.

**Code:** [record validation](../lib/bridge/model.ts), [saving and readback](../lib/bridge/storage.ts). **Regression evidence:** [corruption and path tests](../tests/core.test.ts), [destination/export tests](../tests/storage.test.ts).

## 4. Make asynchronous connection failures reproducible

An ICE candidate can arrive before the peer's remote description is installed. In PeerJS 1.5.5, independently dispatched `ANSWER` and `CANDIDATE` messages could cause an early `addIceCandidate()` rejection to abort negotiation.

The per-connection `CandidateInbox` queues candidates until SDP is ready, deduplicates them, serializes additions, and accepts at most 64 distinct candidates. An unusable route records a fixed error category while subsequent routes continue. Activation, failure, and revocation clear queued work and remove listeners.

A browser fixture deliberately delivers candidates before the answer. It reproduced the 0.3.3 failure (`have-local-offer`, missing remote description), then verified that the corrected flow connects, transfers hash-checked bytes, and consumes the code in Chromium, Firefox, and WebKit-to-Chromium. This is a regression for a specific race, not a claim that every network failure is recoverable.

**Code:** [candidate queue](../lib/bridge/candidate-inbox.ts), [PeerJS integration](../lib/bridge/code-connection.ts). **Regression evidence:** [queue lifecycle tests](../tests/candidate-inbox.test.ts), [browser fault injection](../tests/browser/bridge.spec.ts), [baseline reproduction](VALIDATION.md).

## 5. Keep trust boundaries and resource limits explicit

Code pairing validates protocol metadata and reliable ordering, admits one sender, and gates the transfer engine behind receiver consent and a connection-bound nonce. Registration retries, inbound pairing requests, route attempts, and candidate queues are bounded. Codes expire after ten minutes; route setup times out after 45 seconds; revocation destroys the local peer.

The copy/paste fallback uses a versioned compressed SDP envelope with matching session/expiry checks, bounded token length, a fixed decompression output buffer, and data-channel-only SDP validation. Only connection descriptions are compressed; media bytes remain untouched.

A Content Security Policy constrains scripts, workers, and signaling origins. Local diagnostics retain connection states, candidate counts, statistics-read outcomes, and fixed error categories; they exclude raw SDP, IP addresses, codes, filenames, and error text. No analytics or automatic diagnostics upload is configured.

The signaling broker is a trust dependency. A six-digit code and SHA-256 do not authenticate a person, and local browser storage is not an encrypted vault. Application-side bounds do not provide global rate limiting for the public PeerJS service. See [Security](../SECURITY.md) for the full threat model.

**Code:** [pairing envelope](../lib/bridge/pairing.ts), [SDP validation](../lib/pairing-validation.ts), [privacy-limited diagnostics](../lib/bridge/route-diagnostics.ts), [CSP](../index.html).

[Project overview](../README.md) · [Validation record](VALIDATION.md)
