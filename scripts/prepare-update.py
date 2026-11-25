"""Create a signed Air Windows update alongside the normal NSIS installer."""

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import re
import struct
import subprocess
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BLOCK_SIZE = 1024 * 1024
DELTA_MAGIC = b"AIRDLT1\0"
DELTA_ANCHOR_RE = re.compile(b"[\x5a\xa5][\xa0-\xa7]")
DELTA_KEY_LEN = 32
DELTA_MIN_COPY = 64
DELTA_SPARSE_STRIDE = 16 * 1024

FILES = (
    "WebView2Loader.dll",
    "mihomo.exe",
    "Mihomo-LICENSE.txt",
    "Mihomo-build-info.txt",
    "Air-Proxy.ico",
    "air-proxy.exe",
)


def b64(value):
    return base64.b64encode(value).decode("ascii")


def _index_old(old: bytes) -> dict[bytes, int]:
    """Index 32-byte slices at shift-invariant anchor positions plus sparse fallback."""
    index: dict[bytes, int] = {}
    limit = len(old) - DELTA_KEY_LEN
    if limit < 0:
        return index
    last = -DELTA_SPARSE_STRIDE
    for match in DELTA_ANCHOR_RE.finditer(old):
        pos = match.start()
        if pos > limit:
            break
        key = old[pos : pos + DELTA_KEY_LEN]
        if key not in index:
            index[key] = pos
        last = pos
    # Ensure regions without regex hits still have bounded sparse anchors.
    pos = 0
    while pos <= limit:
        key = old[pos : pos + DELTA_KEY_LEN]
        if len(set(key)) >= 3 and key not in index:
            index[key] = pos
        pos += DELTA_SPARSE_STRIDE
    return index


def _extend_match(old: bytes, old_pos: int, new: bytes, new_pos: int, max_back: int) -> tuple[int, int, int]:
    back = 0
    limit_back = min(max_back, old_pos)
    while back < limit_back and old[old_pos - 1 - back] == new[new_pos - 1 - back]:
        back += 1
    old_start = old_pos - back
    new_start = new_pos - back

    fwd = DELTA_KEY_LEN + back
    max_fwd = min(len(old) - old_start, len(new) - new_start)
    while fwd + 4096 <= max_fwd and old[old_start + fwd : old_start + fwd + 4096] == new[new_start + fwd : new_start + fwd + 4096]:
        fwd += 4096
    while fwd < max_fwd and old[old_start + fwd] == new[new_start + fwd]:
        fwd += 1
    return new_start, old_start, fwd


def build_delta(old: bytes, new: bytes) -> bytes:
    """Compute a gzip-compressed AIRDLT1 delta stream transforming old -> new."""
    anchors = _index_old(old)
    out = bytearray(DELTA_MAGIC)
    lit = bytearray()
    n = len(new)
    pos = 0

    def flush_lit():
        if lit:
            out.extend(struct.pack("<BI", 0, len(lit)))
            out.extend(lit)
            lit.clear()

    def try_copy(probe_pos: int) -> tuple[int, int, int] | None:
        if probe_pos + DELTA_KEY_LEN > n:
            return None
        old_pos = anchors.get(new[probe_pos : probe_pos + DELTA_KEY_LEN])
        if old_pos is None:
            return None
        new_start, old_start, length = _extend_match(old, old_pos, new, probe_pos, len(lit))
        if length < DELTA_MIN_COPY:
            return None
        trim = probe_pos - new_start
        if trim:
            del lit[-trim:]
        return old_start, length, new_start + length

    # Probe start of file first in case headers or initial chunks match.
    matched_end = try_copy(0)
    if matched_end is not None:
        old_start, length, next_pos = matched_end
        out.extend(struct.pack("<BQI", 1, old_start, length))
        pos = next_pos

    anchor_iter = DELTA_ANCHOR_RE.finditer(new, pos)
    next_sparse = ((pos // DELTA_SPARSE_STRIDE) + 1) * DELTA_SPARSE_STRIDE

    def handle_hit(hit_pos: int) -> bool:
        nonlocal pos, next_sparse
        if hit_pos < pos:
            return False
        if hit_pos > pos:
            lit.extend(new[pos:hit_pos])
            pos = hit_pos
        res = try_copy(pos)
        if res is None:
            return False
        old_start, length, next_pos = res
        flush_lit()
        out.extend(struct.pack("<BQI", 1, old_start, length))
        pos = next_pos
        if next_sparse <= pos:
            next_sparse = ((pos // DELTA_SPARSE_STRIDE) + 1) * DELTA_SPARSE_STRIDE
        return True

    for m in anchor_iter:
        p = m.start()
        if p < pos:
            continue
        while next_sparse < p and next_sparse + DELTA_KEY_LEN <= n:
            if handle_hit(next_sparse):
                break
            next_sparse += DELTA_SPARSE_STRIDE
        if p >= pos:
            handle_hit(p)

    while next_sparse + DELTA_KEY_LEN <= n:
        if next_sparse >= pos:
            handle_hit(next_sparse)
        next_sparse += DELTA_SPARSE_STRIDE

    if pos < n:
        lit.extend(new[pos:])
    flush_lit()
    return gzip.compress(bytes(out), compresslevel=6, mtime=0)


def apply_delta(old: bytes, patch_gzip: bytes) -> bytes:
    """Apply a gzip-compressed AIRDLT1 delta stream onto old and return the reconstructed bytes."""
    raw = gzip.decompress(patch_gzip)
    if raw[: len(DELTA_MAGIC)] != DELTA_MAGIC:
        raise ValueError("Invalid AIRDLT1 delta header")
    cursor = len(DELTA_MAGIC)
    total = len(raw)
    out = bytearray()
    while cursor < total:
        tag = raw[cursor]
        cursor += 1
        if tag == 0:
            (length,) = struct.unpack_from("<I", raw, cursor)
            cursor += 4
            out.extend(raw[cursor : cursor + length])
            cursor += length
        elif tag == 1:
            offset, length = struct.unpack_from("<QI", raw, cursor)
            cursor += 12
            if offset + length > len(old):
                raise ValueError("Delta COPY out of range")
            out.extend(old[offset : offset + length])
        else:
            raise ValueError(f"Unknown delta op tag {tag}")
    return bytes(out)


def _load_previous_exe(prev_path: Path) -> tuple[str | None, bytes] | None:
    """Load (version, air-proxy.exe bytes) from a previous stage dir or release output dir."""
    raw_exe = prev_path / FILES[-1]
    if raw_exe.is_file() and raw_exe.stat().st_size:
        return None, raw_exe.read_bytes()
    manifest_file = prev_path / "air-windows-x64.json"
    if not manifest_file.is_file():
        return None
    envelope = json.loads(manifest_file.read_text("utf-8"))
    manifest = json.loads(base64.b64decode(envelope["payload"]).decode("utf-8"))
    pack_name = Path(urlparse(manifest["asset"]).path).name
    pack_file = prev_path / pack_name
    if not pack_file.is_file():
        return None
    exe_entry = next((item for item in manifest.get("files", []) if item.get("name") == FILES[-1]), None)
    if exe_entry is None:
        return None
    out = io.BytesIO()
    with pack_file.open("rb") as pf:
        for block in exe_entry["blocks"]:
            pf.seek(block["offset"])
            out.write(gzip.decompress(pf.read(block["length"])))
    data = out.getvalue()
    if hashlib.sha256(data).hexdigest() != exe_entry["sha256"]:
        raise ValueError(f"Previous pack SHA-256 mismatch in {pack_file}")
    return manifest.get("version"), data


def keygen(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    key = Ed25519PrivateKey.generate()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as dest:
        dest.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
    path.with_suffix(".pub").write_text(b64(key.public_key().public_bytes_raw()), "ascii")


def package(args):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", args.version):
        raise ValueError("version must be a stable semantic version")
    key = serialization.load_pem_private_key(args.key.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("expected an Ed25519 key")
    notes = args.notes.read_text("utf-8")
    if len(notes.encode("utf-8")) > 64 * 1024:
        raise ValueError("release notes exceed 64 KiB")
    pack = f"air-windows-x64-{args.version}.pack"
    source = urlparse(args.asset_base)
    if not source.hostname or (source.scheme != "https" and not (
        source.scheme == "http" and source.hostname in ("127.0.0.1", "::1")
    )):
        raise ValueError("the asset base must use HTTPS or an HTTP loopback fixture")
    for name in FILES:
        if not (args.source / name).is_file() or not (args.source / name).stat().st_size:
            raise ValueError(f"missing installer file {name}")
    executable_version = subprocess.check_output(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "(Get-Item -LiteralPath $env:AIR_UPDATE_SOURCE_EXE).VersionInfo.ProductVersion"],
        env={**os.environ, "AIR_UPDATE_SOURCE_EXE": str((args.source / FILES[-1]).resolve())},
    ).decode("ascii").strip()
    if executable_version != args.version:
        raise ValueError(f"executable version {executable_version} differs from {args.version}")
    args.output.mkdir(parents=True, exist_ok=True)
    temporary = args.output / f"{pack}.partial"
    manifest = {
        "schema": 1, "app": "app.air.client", "target": "windows-x86_64",
        "version": args.version, "asset": f"{args.asset_base.rstrip('/')}/{pack}",
        "notes": notes, "files": [],
    }
    exe_packed_size = 0
    try:
        with temporary.open("wb") as out:
            for name in FILES:
                blocks = []
                digest = hashlib.sha256()
                size = 0
                with (args.source / name).open("rb") as src:
                    while data := src.read(BLOCK_SIZE):
                        digest.update(data)
                        size += len(data)
                        compressed = gzip.compress(data, compresslevel=6, mtime=0)
                        blocks.append({
                            "sha256": hashlib.sha256(data).hexdigest(),
                            "offset": out.tell(),
                            "length": len(compressed),
                        })
                        out.write(compressed)
                if name == FILES[-1]:
                    exe_packed_size = sum(block["length"] for block in blocks)
                manifest["files"].append({
                    "name": name, "size": size, "sha256": digest.hexdigest(), "blocks": blocks,
                })
            manifest["assetSize"] = out.tell()
        if max(manifest["assetSize"], sum(x["size"] for x in manifest["files"])) > 256 * 1024 * 1024:
            raise ValueError("update exceeds the Windows channel size limit")

        patches = []
        seen_bases: set[str] = set()
        new_exe = (args.source / FILES[-1]).read_bytes()
        new_exe_sha = hashlib.sha256(new_exe).hexdigest()
        for prev_dir in args.previous:
            loaded = _load_previous_exe(prev_dir)
            if loaded is None:
                continue
            prev_ver, old_exe = loaded
            base_sha = hashlib.sha256(old_exe).hexdigest()
            if base_sha == new_exe_sha or base_sha in seen_bases:
                continue
            seen_bases.add(base_sha)
            patch_bytes = build_delta(old_exe, new_exe)
            if apply_delta(old_exe, patch_bytes) != new_exe:
                raise ValueError("Delta patch round-trip verification failed")
            if exe_packed_size and len(patch_bytes) >= int(exe_packed_size * 0.75):
                continue
            label = prev_ver or base_sha[:10]
            patch_name = f"air-windows-x64-{label}-to-{args.version}.patch"
            (args.output / patch_name).write_bytes(patch_bytes)
            patches.append({
                "file": FILES[-1],
                "baseSha256": base_sha,
                "targetSha256": new_exe_sha,
                "asset": f"{args.asset_base.rstrip('/')}/{patch_name}",
                "size": len(patch_bytes),
                "sha256": hashlib.sha256(patch_bytes).hexdigest(),
            })
            print(f"{patch_name}: {len(patch_bytes):,} patch bytes (vs {exe_packed_size:,} packed)")
        if patches:
            manifest["patches"] = patches

        payload = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        envelope = json.dumps({"payload": b64(payload), "signature": b64(key.sign(payload))})
        temporary.replace(args.output / pack)
        (args.output / "air-windows-x64.json").write_text(envelope, "utf-8")
        print(f"{pack}: {manifest['assetSize']:,} packed bytes")
    finally:
        temporary.unlink(missing_ok=True)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("keygen")
    generate.add_argument("--key", type=Path, required=True)
    build = commands.add_parser("package")
    build.add_argument("--key", type=Path, required=True)
    build.add_argument("--version", required=True)
    build.add_argument("--notes", type=Path, required=True)
    build.add_argument("--source", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--asset-base", required=True)
    build.add_argument("--previous", type=Path, action="append", default=[],
                       help="Previous stage or release directory to emit binary delta patches from")
    args = cli.parse_args()
    if args.command == "keygen":
        keygen(args.key)
    else:
        package(args)


if __name__ == "__main__":
    main()
