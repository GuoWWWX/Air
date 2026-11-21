"""Create a signed Air Windows update alongside the normal NSIS installer."""

import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BLOCK_SIZE = 1024 * 1024
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
                manifest["files"].append({
                    "name": name, "size": size, "sha256": digest.hexdigest(), "blocks": blocks,
                })
            manifest["assetSize"] = out.tell()
        if max(manifest["assetSize"], sum(x["size"] for x in manifest["files"])) > 256 * 1024 * 1024:
            raise ValueError("update exceeds the Windows channel size limit")
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
    args = cli.parse_args()
    if args.command == "keygen":
        keygen(args.key)
    else:
        package(args)


if __name__ == "__main__":
    main()
