#!/bin/sh
# Builds bsdiff.wasm reproducibly: source and registry paths are remapped so the
# module carries no machine-specific paths and CI can check the committed file
# against a fresh build with the pinned toolchain.
set -eu
cd "$(dirname "$0")/crate"
export RUSTFLAGS="--remap-path-prefix=$(pwd)=/src --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/open_ota_bsdiff.wasm ../bsdiff.wasm
