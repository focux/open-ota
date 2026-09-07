/**
 * BSDIFF40 diff and patch, the format read by the bspatch inside expo-updates.
 *
 * The algorithm lives in `crate/` and ships as `bsdiff.wasm`. This module is
 * the host side: copy inputs into the module's memory, call it, copy the
 * result out. It has no environment assumptions, so the same code runs in
 * Node and in a Cloudflare Worker; only how the module bytes are obtained
 * differs (see `./node`).
 */

export interface Bsdiff {
  /** A patch that turns `old` into `target`. */
  readonly diff: (old: Uint8Array, target: Uint8Array) => Uint8Array<ArrayBuffer>;
  /**
   * The file `patch` rebuilds from `old`. It cannot tell whether `old` is the
   * file the patch was made for, so compare the result against its hash.
   */
  readonly patch: (old: Uint8Array, patch: Uint8Array) => Uint8Array<ArrayBuffer>;
}

export type BsdiffErrorCode = "too-large" | "corrupt-patch" | "compression" | "out-of-memory";

export class BsdiffError extends Error {
  override readonly name = "BsdiffError";
  constructor(
    readonly code: BsdiffErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Inputs and outputs above this are refused by the module itself. */
export const maxInputBytes = 1 << 30;

interface Exports {
  readonly memory: WebAssembly.Memory;
  readonly alloc: (len: number) => number;
  readonly dealloc: (ptr: number, len: number) => void;
  readonly bsdiff: (old: number, oldLen: number, target: number, targetLen: number, out: number) => number;
  readonly bspatch: (old: number, oldLen: number, patch: number, patchLen: number, out: number) => number;
}

const errors: Record<number, [BsdiffErrorCode, string]> = {
  [-1]: ["too-large", "An input is larger than the 1 GiB the module accepts."],
  [-2]: ["corrupt-patch", "The patch is not a well-formed BSDIFF40 patch for a file of the announced size."],
  [-3]: ["compression", "A bzip2 stream could not be processed."],
};

/**
 * Instantiate the engine from a compiled module or its bytes. Cloudflare
 * Workers only allow the former (a `.wasm` import); Node accepts both.
 */
export async function instantiate(source: WebAssembly.Module | BufferSource): Promise<Bsdiff> {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, {});
  return fromInstance(instance);
}

export function fromInstance(instance: WebAssembly.Instance): Bsdiff {
  const exports = instance.exports as unknown as Exports;
  const { memory } = exports;

  // The buffer detaches whenever memory grows, so it is re-read on every touch.
  const bytes = () => new Uint8Array(memory.buffer);

  const copyIn = (data: Uint8Array): number => {
    const ptr = exports.alloc(data.length);
    bytes().set(data, ptr);
    return ptr;
  };

  const call = (
    operation: "bsdiff" | "bspatch",
    first: Uint8Array,
    second: Uint8Array,
  ): Uint8Array<ArrayBuffer> => {
    if (first.length > maxInputBytes || second.length > maxInputBytes) {
      throw new BsdiffError("too-large", errors[-1]![1]);
    }
    let firstPtr = 0;
    let secondPtr = 0;
    let out = 0;
    try {
      firstPtr = copyIn(first);
      secondPtr = copyIn(second);
      out = exports.alloc(8);
      const status = exports[operation](firstPtr, first.length, secondPtr, second.length, out);
      if (status !== 0) {
        const [code, message] = errors[status] ?? (["compression", `bsdiff returned ${status}.`] as const);
        throw new BsdiffError(code, message);
      }
      const slot = new DataView(memory.buffer, out, 8);
      const ptr = slot.getUint32(0, true);
      const len = slot.getUint32(4, true);
      const result = new Uint8Array(new ArrayBuffer(len));
      result.set(bytes().subarray(ptr, ptr + len));
      exports.dealloc(ptr, len);
      return result;
    } catch (cause) {
      if (cause instanceof BsdiffError) throw cause;
      // The module aborts instead of unwinding: a trap here is an allocation
      // failure, since every other failure returns a status code.
      throw new BsdiffError("out-of-memory", `The engine ran out of memory while running ${operation}.`, { cause });
    } finally {
      if (firstPtr !== 0) exports.dealloc(firstPtr, first.length);
      if (secondPtr !== 0) exports.dealloc(secondPtr, second.length);
      if (out !== 0) exports.dealloc(out, 8);
    }
  };

  return {
    diff: (old, target) => call("bsdiff", old, target),
    patch: (old, patch) => call("bspatch", old, patch),
  };
}
