# Browser fixtures

These small checked-in assets are synthetic, neutral test material:

- `fixture.mp4`: a five-second vertical H.264 clip.
- `stream.m3u8`, `stream0.ts`–`stream4.ts`, `key.bin`: the same clip as AES-128 encrypted HLS, with a test-only key.
- `cover.png`: a synthetic cover, encrypted by the fixture server before it is sent to the application.

No real platform account or signed media URL is included; `key.bin` is a generated test key. The tests use the production HTTP app, network transport and media handlers against a local upstream and an HTTP proxy. The fixture is never imported by the production server or copied into the Docker runtime image.

After installing Playwright Chromium, run from the repository root:

```bash
pnpm build
pnpm test:browser
```

The app listens on loopback port `3210`, and its test proxy on `3212`. Set `HGHUB_E2E_PORT` and `HGHUB_E2E_PROXY_PORT` to use other ports. The upstream uses an available ephemeral port. Session and proxy data live in a new OS temporary directory and are removed when the fixture server shuts down.

The same four browser stories run at 390 × 844 and 1280 × 900. They use no external content. Failures retain a screenshot and Playwright trace in `test-results/`; the HTML report is in `playwright-report/`.
