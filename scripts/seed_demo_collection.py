#!/usr/bin/env python3
"""Seed the demo sample portraits (owner step O1).

Reads ``manifest.json`` and ``<id>.jpg`` from a local folder the owner provides,
uploads them to ``s3://<bucket>/samples/`` and indexes the portraits labeled
``family`` into the Rekognition collection ``warashi-demo``. The household
collection ``warashi-household`` is never touched.

Why only ``family`` portraits are indexed: ``POST /simulate`` searches the demo
collection, so a sample matches as ``family`` only when its face is in the
collection. Indexing a ``stranger`` portrait would make it match itself.

Why the manifest is rewritten: it is uploaded with only ``id`` and ``label``, so
a name that slipped into the owner's file never reaches S3. The ``id`` is the
opaque ``ExternalImageId``. Face images stay on the owner's machine and never
enter the repository.

Usage:
    python3 scripts/seed_demo_collection.py --bucket <data-bucket> --samples-dir <folder> [--region <region>]

``boto3`` is imported only when the script talks to AWS, so the tests run
without it and without a network. Run it on a laptop, never on the Pi.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

DEMO_COLLECTION_ID = "warashi-demo"
SAMPLES_PREFIX = "samples/"
MANIFEST_NAME = "manifest.json"
SAMPLE_ID_RE = re.compile(r"[a-z0-9_-]{1,64}")
LABELS = ("family", "stranger", "no_face", "uncertain")
MAX_IMAGE_BYTES = 5_000_000  # Rekognition limit for image bytes is 5 MB.


class SeedError(Exception):
    """A problem with the manifest, the folder or an AWS call. The message is safe to print."""


def load_manifest(samples_dir: Path) -> list[dict[str, str]]:
    """Read and validate ``manifest.json``; return entries holding only ``id`` and ``label``."""
    path = samples_dir / MANIFEST_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SeedError(f"{MANIFEST_NAME} not found in {samples_dir}") from None
    except (OSError, ValueError) as exc:
        raise SeedError(
            f"{MANIFEST_NAME} is not readable JSON: {type(exc).__name__}"
        ) from None
    if not isinstance(raw, list) or not raw:
        raise SeedError(f"{MANIFEST_NAME} must be a non-empty JSON array")
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SeedError(f"entry {index} is not an object")
        sample_id, label = item.get("id"), item.get("label")
        if not isinstance(sample_id, str) or not SAMPLE_ID_RE.fullmatch(sample_id):
            raise SeedError(f"entry {index}: id must match [a-z0-9_-]{{1,64}}")
        if label not in LABELS:
            raise SeedError(
                f"entry {index} ({sample_id}): label must be one of {', '.join(LABELS)}"
            )
        if sample_id in seen:
            raise SeedError(f"entry {index}: duplicate id {sample_id}")
        seen.add(sample_id)
        entries.append({"id": sample_id, "label": label})
    return entries


def read_images(
    samples_dir: Path, entries: Sequence[dict[str, str]]
) -> dict[str, bytes]:
    """Read ``<id>.jpg`` for every entry; every sample, even ``no_face``, needs an image."""
    images: dict[str, bytes] = {}
    for entry in entries:
        path = samples_dir / f"{entry['id']}.jpg"
        try:
            data = path.read_bytes()
        except OSError:
            raise SeedError(
                f"image {entry['id']}.jpg is missing or unreadable"
            ) from None
        if not data:
            raise SeedError(f"image {entry['id']}.jpg is empty")
        if len(data) > MAX_IMAGE_BYTES:
            raise SeedError(
                f"image {entry['id']}.jpg is larger than {MAX_IMAGE_BYTES} bytes"
            )
        images[entry["id"]] = data
    return images


def seed(
    s3: Any,
    rekognition: Any,
    bucket: str,
    entries: Sequence[dict[str, str]],
    images: dict[str, bytes],
    log: Callable[[str], None] = print,
) -> int:
    """Upload the samples and index the ``family`` ones. Return the number of indexed faces."""
    for entry in entries:
        s3.put_object(
            Bucket=bucket,
            Key=f"{SAMPLES_PREFIX}{entry['id']}.jpg",
            Body=images[entry["id"]],
            ContentType="image/jpeg",
        )
        log(f"uploaded {entry['id']}")
    s3.put_object(
        Bucket=bucket,
        Key=f"{SAMPLES_PREFIX}{MANIFEST_NAME}",
        Body=json.dumps(list(entries), indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    log("uploaded manifest")

    indexed = 0
    for entry in entries:
        if entry["label"] != "family":
            continue
        response = rekognition.index_faces(
            CollectionId=DEMO_COLLECTION_ID,
            Image={"Bytes": images[entry["id"]]},
            ExternalImageId=entry["id"],
            MaxFaces=1,
            QualityFilter="AUTO",
        )
        if not response.get("FaceRecords"):
            raise SeedError(
                f"no face was indexed for {entry['id']}; use a clearer portrait"
            )
        indexed += 1
        log(f"indexed {entry['id']}")
    return indexed


def _aws_clients(region: str | None) -> tuple[Any, Any]:
    """Create the S3 and Rekognition clients. ``boto3`` is imported here, not at module load."""
    try:
        import boto3
    except ImportError:
        raise SeedError(
            "boto3 is required: pip install boto3 (laptop only, never on the Pi)"
        ) from None
    session = boto3.session.Session(region_name=region)
    return session.client("s3"), session.client("rekognition")


def main(
    argv: Sequence[str] | None = None,
    client_factory: Callable[[str | None], tuple[Any, Any]] = _aws_clients,
) -> int:
    parser = argparse.ArgumentParser(
        description="Seed the warashi-demo collection and the samples/ prefix."
    )
    parser.add_argument("--bucket", required=True, help="Data_Bucket name")
    parser.add_argument(
        "--samples-dir",
        required=True,
        type=Path,
        help="local folder with manifest.json and <id>.jpg",
    )
    parser.add_argument(
        "--region", default=None, help="AWS Region (default: the AWS profile's Region)"
    )
    args = parser.parse_args(argv)
    try:
        if not args.samples_dir.is_dir():
            raise SeedError(f"{args.samples_dir} is not a folder")
        entries = load_manifest(args.samples_dir)
        images = read_images(args.samples_dir, entries)
        s3, rekognition = client_factory(args.region)
        indexed = seed(s3, rekognition, args.bucket, entries, images)
    except SeedError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - print the type only, never request data
        print(f"error: AWS call failed ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(
        f"done: {len(entries)} samples uploaded, {indexed} faces indexed into {DEMO_COLLECTION_ID}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
