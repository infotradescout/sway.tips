# Sway Local App Smoke

## Do Not Open `file://`

Do not double-click `index.html`, `shells/public.html`, or any other HTML file in the repo.

That loads Sway as a `file://` page and the browser will block module loading. A blank screen with CORS errors is expected in that mode.

## Correct Local Run

### Dev mode

```bash
npm install
npm run dev
```

Open the local Vite URL, usually:

```text
http://127.0.0.1:5173
```

### Production-style local run

```bash
npm run build
npm start
```

Open:

```text
http://127.0.0.1:3000
```

## One-Command Local Smoke

After `npm start` is running:

```bash
npm run smoke:local:app
```

This verifies:

- public landing over HTTP
- patron shell entry over HTTP
- performer login page over HTTP
- install manifest
- service worker
- offline fallback page
- touch icon asset

## Browser-App Check

After the app loads from `http://127.0.0.1:3000` or your live host:

1. Open the app in Chrome or Safari.
2. Confirm it loads without console CORS errors.
3. Check that the install prompt appears where supported.
4. On iPhone Safari, use `Share` -> `Add to Home Screen`.
5. Reopen Sway from the home screen icon.

## Failure Mode You Saw

If you see console output like:

```text
Access to script at 'file:///.../src/main.tsx' has been blocked by CORS policy
```

you are not running Sway through a web server.
