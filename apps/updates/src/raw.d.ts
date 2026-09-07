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
