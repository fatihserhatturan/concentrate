// The single place the UI touches the core: the built package in ../dist.
// Build it first (`npm run build:core`); `npm start` does so.
export * from "../../dist/api.js";
