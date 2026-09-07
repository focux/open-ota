//! BSDIFF40, the patch format read by the bspatch embedded in expo-updates.
//!
//! `diff` is bsdiff 4.3 (Colin Percival, BSD-2-Clause) over a divsufsort
//! suffix array instead of qsufsort. `patch` is bspatch 4.3 with every length
//! in the control stream checked before it is used. A patch is a 32-byte header
//! followed by three bzip2 streams: control triples, diff bytes, extra bytes.

use std::io::{Read, Write};

use bzip2::read::BzDecoder;
use bzip2::write::BzEncoder;
use bzip2::Compression;

const MAGIC: &[u8; 8] = b"BSDIFF40";
const HEADER: usize = 32;

/// Suffix array indices are i32 and a Worker holds both files in memory, so
/// anything near this is refused before it is loaded.
pub const MAX_INPUT: usize = 1 << 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// An input is larger than `MAX_INPUT`.
    TooLarge,
    /// The patch is not a well-formed BSDIFF40 patch for a file of the announced size.
    CorruptPatch,
    /// A bzip2 stream could not be written or read.
    Compression,
}

impl Error {
    pub const fn code(self) -> i32 {
        match self {
            Error::TooLarge => -1,
            Error::CorruptPatch => -2,
            Error::Compression => -3,
        }
    }
}

/// Sign-magnitude little-endian 64-bit integer, as bsdiff writes offsets.
fn offtout(x: i64, buf: &mut [u8]) {
    let mut y = x.unsigned_abs();
    for byte in buf.iter_mut().take(8) {
        *byte = (y & 0xff) as u8;
        y >>= 8;
    }
    if x < 0 {
        buf[7] |= 0x80;
    }
}

fn offtin(buf: &[u8]) -> i64 {
    let mut y = (buf[7] & 0x7f) as u64;
    for i in (0..7).rev() {
        y = (y << 8) | buf[i] as u64;
    }
    if buf[7] & 0x80 != 0 {
        -(y as i64)
    } else {
        y as i64
    }
}

fn matchlen(old: &[u8], new: &[u8]) -> usize {
    old.iter().zip(new).take_while(|(a, b)| a == b).count()
}

/// The longest prefix of `new` that occurs in `old`, as (length, position).
fn search(sa: &[i32], old: &[u8], new: &[u8]) -> (usize, usize) {
    let (mut st, mut en) = (0usize, sa.len() - 1);
    while en - st >= 2 {
        let x = st + (en - st) / 2;
        let suffix = &old[sa[x] as usize..];
        let n = suffix.len().min(new.len());
        if suffix[..n] < new[..n] {
            st = x;
        } else {
            en = x;
        }
    }
    let (a, b) = (sa[st] as usize, sa[en] as usize);
    let x = matchlen(&old[a..], new);
    let y = matchlen(&old[b..], new);
    if x > y {
        (x, a)
    } else {
        (y, b)
    }
}

fn compress(data: &[u8]) -> Result<Vec<u8>, Error> {
    let mut encoder = BzEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(data).map_err(|_| Error::Compression)?;
    encoder.finish().map_err(|_| Error::Compression)
}

/// Decompress at most `limit` bytes; a stream that wants more is corrupt.
fn decompress(data: &[u8], limit: usize) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    let mut decoder = BzDecoder::new(data).take(limit as u64 + 1);
    decoder.read_to_end(&mut out).map_err(|_| Error::Compression)?;
    if out.len() > limit {
        return Err(Error::CorruptPatch);
    }
    Ok(out)
}

/// A patch that turns `old` into `new`.
pub fn diff(old: &[u8], new: &[u8]) -> Result<Vec<u8>, Error> {
    if old.len() > MAX_INPUT || new.len() > MAX_INPUT {
        return Err(Error::TooLarge);
    }
    let sa: Vec<i32> = if old.is_empty() {
        Vec::new()
    } else {
        divsufsort::sort(old).into_parts().1
    };
    let oldsize = old.len() as i64;
    let newsize = new.len() as i64;
    let mut ctrl = Vec::new();
    let mut db = Vec::new();
    let mut eb = Vec::new();

    let at_old = |offset: i64| -> Option<u8> {
        if offset >= 0 && offset < oldsize {
            Some(old[offset as usize])
        } else {
            None
        }
    };

    let (mut scan, mut len, mut pos) = (0i64, 0i64, 0i64);
    let (mut lastscan, mut lastpos, mut lastoffset) = (0i64, 0i64, 0i64);
    while scan < newsize {
        let mut oldscore = 0i64;
        scan += len;
        let mut scsc = scan;
        while scan < newsize {
            let (l, p) = if sa.is_empty() { (0, 0) } else { search(&sa, old, &new[scan as usize..]) };
            len = l as i64;
            pos = p as i64;
            while scsc < scan + len {
                if at_old(scsc + lastoffset) == Some(new[scsc as usize]) {
                    oldscore += 1;
                }
                scsc += 1;
            }
            if (len == oldscore && len != 0) || len > oldscore + 8 {
                break;
            }
            if at_old(scan + lastoffset) == Some(new[scan as usize]) {
                oldscore -= 1;
            }
            scan += 1;
        }

        if len != oldscore || scan == newsize {
            // Extend the previous match forward while it still pays off.
            let (mut s, mut sf, mut lenf) = (0i64, 0i64, 0i64);
            let mut i = 0i64;
            while lastscan + i < scan && lastpos + i < oldsize {
                if old[(lastpos + i) as usize] == new[(lastscan + i) as usize] {
                    s += 1;
                }
                i += 1;
                if s * 2 - i > sf * 2 - lenf {
                    sf = s;
                    lenf = i;
                }
            }
            // And the new match backward.
            let mut lenb = 0i64;
            if scan < newsize {
                let (mut s, mut sb) = (0i64, 0i64);
                let mut i = 1i64;
                while scan >= lastscan + i && pos >= i {
                    if old[(pos - i) as usize] == new[(scan - i) as usize] {
                        s += 1;
                    }
                    if s * 2 - i > sb * 2 - lenb {
                        sb = s;
                        lenb = i;
                    }
                    i += 1;
                }
            }
            // Resolve an overlap between the two extensions.
            if lastscan + lenf > scan - lenb {
                let overlap = (lastscan + lenf) - (scan - lenb);
                let (mut s, mut ss, mut lens) = (0i64, 0i64, 0i64);
                for i in 0..overlap {
                    if new[(lastscan + lenf - overlap + i) as usize] == old[(lastpos + lenf - overlap + i) as usize] {
                        s += 1;
                    }
                    if new[(scan - lenb + i) as usize] == old[(pos - lenb + i) as usize] {
                        s -= 1;
                    }
                    if s > ss {
                        ss = s;
                        lens = i + 1;
                    }
                }
                lenf += lens - overlap;
                lenb -= lens;
            }

            for i in 0..lenf {
                db.push(new[(lastscan + i) as usize].wrapping_sub(old[(lastpos + i) as usize]));
            }
            let extra = (scan - lenb) - (lastscan + lenf);
            let start = (lastscan + lenf) as usize;
            eb.extend_from_slice(&new[start..start + extra as usize]);

            let mut triple = [0u8; 24];
            offtout(lenf, &mut triple[0..8]);
            offtout(extra, &mut triple[8..16]);
            offtout((pos - lenb) - (lastpos + lenf), &mut triple[16..24]);
            ctrl.extend_from_slice(&triple);

            lastscan = scan - lenb;
            lastpos = pos - lenb;
            lastoffset = pos - scan;
        }
    }

    let ctrl = compress(&ctrl)?;
    let db = compress(&db)?;
    let eb = compress(&eb)?;
    let mut out = Vec::with_capacity(HEADER + ctrl.len() + db.len() + eb.len());
    out.extend_from_slice(MAGIC);
    let mut field = [0u8; 8];
    offtout(ctrl.len() as i64, &mut field);
    out.extend_from_slice(&field);
    offtout(db.len() as i64, &mut field);
    out.extend_from_slice(&field);
    offtout(newsize, &mut field);
    out.extend_from_slice(&field);
    out.extend_from_slice(&ctrl);
    out.extend_from_slice(&db);
    out.extend_from_slice(&eb);
    Ok(out)
}

/// The file a patch rebuilds from `old`. It does not know whether `old` is the
/// file the patch was made for: compare the result against the expected hash.
pub fn patch(old: &[u8], patch: &[u8]) -> Result<Vec<u8>, Error> {
    if old.len() > MAX_INPUT {
        return Err(Error::TooLarge);
    }
    if patch.len() < HEADER || &patch[..8] != MAGIC {
        return Err(Error::CorruptPatch);
    }
    let ctrllen = offtin(&patch[8..16]);
    let datalen = offtin(&patch[16..24]);
    let newsize = offtin(&patch[24..32]);
    let rest = (patch.len() - HEADER) as i64;
    if ctrllen < 0 || datalen < 0 || newsize < 0 || newsize > MAX_INPUT as i64 || ctrllen > rest || datalen > rest - ctrllen {
        return Err(Error::CorruptPatch);
    }
    let newsize = newsize as usize;
    let ctrl_end = HEADER + ctrllen as usize;
    let diff_end = ctrl_end + datalen as usize;
    // A valid patch never needs more than one control triple per output byte.
    let ctrl = decompress(&patch[HEADER..ctrl_end], newsize.saturating_mul(24).saturating_add(24))?;
    let diff = decompress(&patch[ctrl_end..diff_end], newsize)?;
    let extra = decompress(&patch[diff_end..], newsize)?;

    let oldsize = old.len() as i64;
    let mut new = vec![0u8; newsize];
    let (mut oldpos, mut newpos) = (0i64, 0usize);
    let (mut cp, mut dp, mut ep) = (0usize, 0usize, 0usize);
    while newpos < newsize {
        if ctrl.len() < cp + 24 {
            return Err(Error::CorruptPatch);
        }
        let add = offtin(&ctrl[cp..cp + 8]);
        let copy = offtin(&ctrl[cp + 8..cp + 16]);
        let seek = offtin(&ctrl[cp + 16..cp + 24]);
        cp += 24;
        if add < 0 || copy < 0 || add as usize > newsize - newpos || diff.len() - dp < add as usize {
            return Err(Error::CorruptPatch);
        }
        let add = add as usize;
        for i in 0..add {
            let offset = oldpos + i as i64;
            let base = if offset >= 0 && offset < oldsize { old[offset as usize] } else { 0 };
            new[newpos + i] = diff[dp + i].wrapping_add(base);
        }
        dp += add;
        newpos += add;
        oldpos += add as i64;
        if copy as usize > newsize - newpos || extra.len() - ep < copy as usize {
            return Err(Error::CorruptPatch);
        }
        let copy = copy as usize;
        new[newpos..newpos + copy].copy_from_slice(&extra[ep..ep + copy]);
        ep += copy;
        newpos += copy;
        oldpos = oldpos.saturating_add(seek);
    }
    Ok(new)
}

// --- WebAssembly ABI ---------------------------------------------------------
//
// The host allocates input buffers with `alloc`, calls `bsdiff` or `bspatch`
// with an 8-byte `out` slot, reads the (pointer, length) the call wrote there,
// copies the result out and releases every buffer with `dealloc`.

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` must come from `alloc(len)` or from a result slot, and be released once.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

unsafe fn emit(result: Result<Vec<u8>, Error>, out: *mut u32) -> i32 {
    match result {
        Ok(bytes) => {
            let boxed = bytes.into_boxed_slice();
            let len = boxed.len();
            let ptr = Box::into_raw(boxed) as *mut u8;
            *out = ptr as u32;
            *out.add(1) = len as u32;
            0
        }
        Err(error) => error.code(),
    }
}

/// # Safety
/// The pointers must address `old_len`, `new_len` and 8 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn bsdiff(old: *const u8, old_len: usize, new: *const u8, new_len: usize, out: *mut u32) -> i32 {
    let old = std::slice::from_raw_parts(old, old_len);
    let new = std::slice::from_raw_parts(new, new_len);
    emit(diff(old, new), out)
}

/// # Safety
/// The pointers must address `old_len`, `patch_len` and 8 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn bspatch(old: *const u8, old_len: usize, patch_ptr: *const u8, patch_len: usize, out: *mut u32) -> i32 {
    let old = std::slice::from_raw_parts(old, old_len);
    let delta = std::slice::from_raw_parts(patch_ptr, patch_len);
    emit(patch(old, delta), out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_round_trip() {
        for value in [0i64, 1, -1, 255, -256, 1 << 40, -(1 << 40), i64::MAX >> 1] {
            let mut buf = [0u8; 8];
            offtout(value, &mut buf);
            assert_eq!(offtin(&buf), value);
        }
    }

    #[test]
    fn reference_patch_applies() {
        let v1 = include_bytes!("../../fixtures/v1.hbc");
        let v2 = include_bytes!("../../fixtures/v2.hbc");
        let reference = include_bytes!("../../fixtures/v1-to-v2.patch");
        assert_eq!(patch(v1, reference).unwrap(), v2);
    }

    #[test]
    fn diff_round_trips_and_stays_small() {
        let v1 = include_bytes!("../../fixtures/v1.hbc");
        let v2 = include_bytes!("../../fixtures/v2.hbc");
        let ours = diff(v1, v2).unwrap();
        assert_eq!(patch(v1, &ours).unwrap(), v2);
        assert!(ours.len() < v2.len());
    }

    #[test]
    fn edge_cases_round_trip() {
        for (old, new) in [
            (vec![], vec![]),
            (vec![], b"new".to_vec()),
            (b"old".to_vec(), vec![]),
            (b"same".to_vec(), b"same".to_vec()),
            (vec![0u8; 100_000], vec![0u8; 100_001]),
            ((0..50_000u32).map(|i| (i * 7 % 251) as u8).collect(), (0..50_000u32).map(|i| (i * 7 % 251) as u8 ^ (i % 997 == 0) as u8).collect()),
        ] {
            let delta = diff(&old, &new).unwrap();
            assert_eq!(patch(&old, &delta).unwrap(), new);
        }
    }

    #[test]
    fn corrupt_patches_are_rejected() {
        let v1 = include_bytes!("../../fixtures/v1.hbc");
        let reference = include_bytes!("../../fixtures/v1-to-v2.patch");
        assert_eq!(patch(v1, b"BSDIFF40"), Err(Error::CorruptPatch));
        let mut wrong_size = reference.to_vec();
        wrong_size[24] ^= 0x40;
        assert!(patch(v1, &wrong_size).is_err());
        let mut truncated = reference.to_vec();
        truncated.truncate(200);
        assert!(patch(v1, &truncated).is_err());
    }
}
