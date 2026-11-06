# Observatory client

React, TypeScript, Three.js, and Vite. See the [project README](../README.md) for setup and the [data guide](../docs/data.md) for visual encodings.

From the repository root:

```sh
npm --prefix observatory ci
npm --prefix observatory run build
```

Start the Python server on port 8876, then use `npm --prefix observatory run dev` for frontend development. Vite proxies `/api` to the shared server.

`Field.ts` owns the imperative renderer, `networkLayout.worker.ts` computes network positions, and React owns controls and data subscriptions. Generated `dist/` files and `node_modules/` are not committed.
