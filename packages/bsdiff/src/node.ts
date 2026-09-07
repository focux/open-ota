import { readFile } from "node:fs/promises";
import { instantiate, type Bsdiff } from "./index.ts";

/** The module bytes shipped in this package. */
export const wasmPath = new URL("../bsdiff.wasm", import.meta.url);

let engine: Promise<Bsdiff> | undefined;

/** The engine, compiled once per process from the bundled `bsdiff.wasm`. */
export function loadBsdiff(): Promise<Bsdiff> {
  engine ??= readFile(wasmPath).then((bytes) => instantiate(bytes));
  return engine;
}
