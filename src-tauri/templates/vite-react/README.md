# {{name}}

A React app built with Vite, written in TypeScript, styled with Tailwind CSS
and tested with Vitest and Testing Library.

## Getting started

```sh
npm install
npm run dev
```

The dev server prints the address to open, usually http://localhost:5173.

## Scripts

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Start the dev server with hot reload            |
| `npm test`          | Run the tests once                              |
| `npm run test:watch`| Run the tests again on every change             |
| `npm run typecheck` | Check the types without building                |
| `npm run build`     | Type-check, then build for production to `dist/`|
| `npm run preview`   | Serve the production build locally              |

## Layout

- `src/main.tsx` mounts the app.
- `src/App.tsx` is the first screen; `src/App.test.tsx` tests it.
- `src/index.css` loads Tailwind.
- `vite.config.ts` configures Vite, Tailwind and Vitest together.
