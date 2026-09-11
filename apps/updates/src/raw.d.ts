declare module "*?raw" {
  const content: string;
  export default content;
}

// Cloudflare uploads a `.wasm` import as a CompiledWasm module; Workers do not
// compile WebAssembly from bytes at runtime.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// workerd's own cache instance. This project loads the DOM lib as well, whose
// CacheStorage does not declare it.
interface CacheStorage {
  readonly default: Cache;
}
