# Contributing to PixelGate

Thank you for helping improve reliable, verifiable file transfers.

## Before opening an issue

Search existing issues and read the browser boundaries in the README. Include the OS, browser version, device model, transfer size, saving mode, and exact error message. Describe whether the failure occurred during pairing, transfer, verification, or saving. Use synthetic files in reproductions.

Do not attach private files, pairing links, sender responses, network addresses, or personal transfer reports. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Local setup

Use Node.js 22.13+:

```sh
npm ci
npm run dev
```

Run checks before opening a pull request:

```sh
npm run check
npm run build
npx playwright install chromium firefox webkit
npm run test:browser
```

The browser test configuration starts a production preview automatically. Six-digit pairing fixtures use an isolated PeerServer; some manual-pairing and persistence fixtures expose LAN candidates to separate recovery checks from discovery. Engine tests do not certify native browsers or physical phones. See [Development and testing](docs/DEVELOPMENT.md) for targeted and legacy-engine runs. Record new hardware results in [the validation record](docs/VALIDATION.md) with versions and independent hashes.

## Pull requests

Keep changes focused. Explain the concrete problem, resulting behavior, and validation. Add meaningful tests for integrity, persistence, protocol, or recovery changes. Screenshots help reviewers assess interface changes.

Preserve these guarantees:

- Verify actual bytes through independent readback before claiming a stored copy is verified.
- Never put file bytes, paths, hashes, or transfer reports on a server.
- Bound frames, buffering, pairing input, and filesystem paths.
- Keep source media untouched and retain recoverable partials.
- Label destination/export verification accurately and document browser limitations.

Changes to protocol or persisted formats need a compatibility/migration plan. Never use sample secrets or real personal media as fixtures.

Contributions are licensed under the repository’s MIT license.
