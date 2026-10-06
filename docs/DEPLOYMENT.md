# Deployment

PixelGate is a static React/Vite app. It needs HTTPS and worker support; it has no application database or media backend. Six-digit pairing uses PeerJS’s shared signaling service by default. GitHub Pages hosts the public reference deployment.

## GitHub Pages

1. Fork the project or create a public repository containing its source.
2. Install Node.js 22.13+, Git, and npm. Authenticate Git for your GitHub account.
3. Clone your repository and run:

   ```sh
   npm ci
   npm run check
   npm run deploy:pages
   ```

4. In repository **Settings → Pages**, choose **Deploy from a branch**, **gh-pages**, and **/(root)**.
5. Wait for GitHub’s Pages deployment to finish, then use the URL shown in that setting.

`deploy:pages` builds the static app locally. It requires committed source, reads the existing `origin`, and creates a temporary checkout for `gh-pages`. Existing deployment history is preserved and the script never force-pushes. It includes `.nojekyll` and `build.json`, which records the source commit and app version. Temporary publishing files are removed after the push.

For subsequent edits, commit and push `main`, run checks, then run `npm run deploy:pages` again. Source pushes alone do not update the hosted app.

GitHub Pages branch deployments use GitHub’s managed deployment workflow. This setup does not require a user-authored workflow or workflow-scoped Git credentials. If you prefer automatic builds on source pushes, configure a custom Pages workflow with `contents: read`, `pages: write`, and `id-token: write` following [GitHub’s guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Other static hosts

Run `npm run build` and upload the contents of `dist/`. The app uses relative asset paths by default, so `/PixelGate/` and other project subpaths work. You may set `PIXELGATE_BASE=/your-path/` during a build if an explicit base is needed.

Do not route media through the host or add a public upload endpoint. Keep the Content Security Policy and bundled workers. When adding response headers, permit same-origin workers and WebAssembly (`wasm-unsafe-eval`), and retain `Referrer-Policy: no-referrer`.

## Pairing service

The default build uses [PeerJS’s public signaling service](https://peerjs.com/server/cloud), so no API key or backend account is required. It exchanges connection descriptions only. Shared-service availability and global limits are controlled by PeerJS; high-traffic deployments should operate their own PeerServer. No TURN service is configured.

To use your own TLS-enabled PeerServer, keep its default `peerjs` key, disable peer discovery, and build with its HTTPS base URL:

```sh
VITE_PIXELGATE_SIGNAL_URL=https://pairing.example.org npm run build
```

The build adds the configured HTTPS/WSS origin to the Content Security Policy. Use the same environment variable when running `npm run deploy:pages`. If the server is mounted on a path, include that path in the URL. Restrict server request sizes, concurrent connections, and request rates; do not enable ID discovery or log connection payloads. Local HTTP is allowed only for localhost development.

**Use copy/paste pairing** selects the backend-free fallback before opening a connection. It keeps the longer response exchange for deployments or networks where signaling is unavailable.

## Verify a deployment

Check the deployment status, `index.html`, `build.json`, and the referenced JavaScript/CSS/worker assets. On two devices, exercise six-digit code creation, sender connection, explicit approval, code expiry/consumption, a synthetic transfer, independent SHA-256 readback, download verification, and revocation. Repeat storage/permission checks on the actual supported devices.

## Origin changes

Browser storage belongs to an origin. Moving from Sites, localhost, or another domain does not copy staged files, local history, or folder permissions. Finish/export important staged transfers on their original host before changing to another URL.

## Cost and capacity

Public repositories can use GitHub Pages on GitHub Free, subject to GitHub’s service limits. File transfer volume is direct between devices, rather than website hosting traffic. Static asset requests still count toward hosting usage. The receiver’s disk space and browser quota determine storage capacity, not GitHub Pages’ website-size limit. Consult [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) for current terms.
