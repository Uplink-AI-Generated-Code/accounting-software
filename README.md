# Ledger — standalone project

This is the same Ledger component from the Claude.ai preview, wired up as a normal
Vite + React + Tailwind project so it looks and behaves the same way outside Claude.ai.

## Why it looked different before

The Claude.ai preview panel provides two things your bare React project didn't have:

1. **Tailwind's utility classes** (`flex`, `grid`, `rounded`, etc.) — compiled here via
   the Tailwind + PostCSS setup in this project, same as the preview.
2. **`window.storage`** — the key-value save API the preview environment injects
   automatically. Outside Claude.ai it doesn't exist, which is what threw the
   `Cannot read properties of undefined (reading 'set')` error. `src/storageShim.js`
   polyfills the same API using `localStorage`, so saving/loading works the same way,
   just backed by your browser instead of Claude's storage.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Files

- `index.html` — Vite entry HTML
- `src/main.jsx` — mounts the app, imports the storage shim first
- `src/storageShim.js` — localStorage-backed `window.storage` polyfill
- `src/App.jsx` — the Ledger component itself (identical to the Claude.ai preview)
- `src/index.css` — Tailwind directives
- `tailwind.config.js` / `postcss.config.js` — Tailwind setup
- `vite.config.js` — Vite + React plugin

## Build for production

```bash
npm run build
npm run preview   # serve the production build locally to check it
```
