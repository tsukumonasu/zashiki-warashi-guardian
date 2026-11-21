"""Tests for ``scripts/seed_demo_collection.py`` (cloud-judgement R15.1, R15.4, R25.3).

Fake S3 and Rekognition clients record calls; ``boto3`` is never imported.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "seed_demo_collection", REPO / "scripts" / "seed_demo_collection.py"
)
assert _spec and _spec.loader
seed_mod = importlib.util.module_from_spec(_spec)
sys.modules["seed_demo_collection"] = seed_mod
_spec.loader.exec_module(seed_mod)


class FakeS3:
    def __init__(self) -> None:
        self.puts: list[dict] = []

    def put_object(self, **kwargs):
        self.puts.append(kwargs)


class FakeRekognition:
    def __init__(self, faces: bool = True) -> None:
        self.calls: list[dict] = []
        self.faces = faces

    def index_faces(self, **kwargs):
        self.calls.append(kwargs)
        return {"FaceRecords": [{"Face": {}}] if self.faces else []}

    def __getattr__(self, name):  # any other Rekognition call is a test failure
        raise AssertionError(f"unexpected Rekognition call: {name}")


def make_folder(tmp_path: Path, manifest) -> Path:
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    for item in manifest if isinstance(manifest, list) else []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            (tmp_path / f"{item['id']}.jpg").write_bytes(b"jpeg-" + item["id"].encode())
    return tmp_path


MANIFEST = [
    {"id": "sample-family-1", "label": "family"},
    {"id": "sample-stranger-1", "label": "stranger"},
    {"id": "sample-empty", "label": "no_face"},
]


def run(folder: Path, s3=None, rek=None, extra=()):
    s3, rek = s3 or FakeS3(), rek or FakeRekognition()
    code = seed_mod.main(
        ["--bucket", "b", "--samples-dir", str(folder), *extra],
        client_factory=lambda region: (s3, rek),
    )
    return code, s3, rek


def test_uploads_and_indexes_only_family_into_demo_collection(tmp_path):
    code, s3, rek = run(make_folder(tmp_path, MANIFEST))
    assert code == 0
    keys = [p["Key"] for p in s3.puts]
    assert keys == [
        "samples/sample-family-1.jpg",
        "samples/sample-stranger-1.jpg",
        "samples/sample-empty.jpg",
        "samples/manifest.json",
    ]
    assert len(rek.calls) == 1
    call = rek.calls[0]
    assert call["CollectionId"] == "warashi-demo"
    assert call["ExternalImageId"] == "sample-family-1"
    assert call["MaxFaces"] == 1


def test_household_collection_is_never_used(tmp_path):
    _, _, rek = run(make_folder(tmp_path, MANIFEST))
    assert all(c["CollectionId"] != "warashi-household" for c in rek.calls)
    assert "warashi-household" not in (
        REPO / "scripts" / "seed_demo_collection.py"
    ).read_text().replace("``warashi-household``", "").replace("household collection", "")


def test_uploaded_manifest_holds_only_id_and_label(tmp_path):
    manifest = [{"id": "a1", "label": "family", "name": "Taro", "note": "x"}]
    code, s3, _ = run(make_folder(tmp_path, manifest))
    assert code == 0
    body = json.loads(s3.puts[-1]["Body"])
    assert body == [{"id": "a1", "label": "family"}]
    assert b"Taro" not in b"".join(p["Body"] for p in s3.puts)


@pytest.mark.parametrize(
    "manifest",
    [
        [],
        {"id": "a", "label": "family"},
        [{"id": "a", "label": "friend"}],
        [{"id": "A_b", "label": "family"}],
        [{"id": "x" * 65, "label": "family"}],
        [{"id": "a", "label": "family"}, {"id": "a", "label": "stranger"}],
        ["a"],
    ],
)
def test_invalid_manifest_stops_before_any_aws_call(tmp_path, manifest, capsys):
    folder = make_folder(tmp_path, manifest)
    called = []
    code = seed_mod.main(
        ["--bucket", "b", "--samples-dir", str(folder)],
        client_factory=lambda region: called.append(1) or (FakeS3(), FakeRekognition()),
    )
    assert code == 1
    assert called == []
    assert "error:" in capsys.readouterr().err


def test_missing_image_fails_before_aws(tmp_path):
    folder = make_folder(tmp_path, MANIFEST)
    (folder / "sample-stranger-1.jpg").unlink()
    code, s3, rek = run(folder)
    assert code == 1 and s3.puts == [] and rek.calls == []


def test_no_face_indexed_is_an_error(tmp_path, capsys):
    code, _, _ = run(make_folder(tmp_path, MANIFEST), rek=FakeRekognition(faces=False))
    assert code == 1
    assert "sample-family-1" in capsys.readouterr().err


def test_aws_failure_prints_type_only(tmp_path, capsys):
    class Boom(FakeS3):
        def put_object(self, **kwargs):
            raise RuntimeError("secret-detail")

    code, _, _ = run(make_folder(tmp_path, MANIFEST), s3=Boom())
    assert code == 1
    assert "secret-detail" not in capsys.readouterr().err


def test_missing_arguments_exit_with_usage():
    with pytest.raises(SystemExit) as exc:
        seed_mod.main([])
    assert exc.value.code == 2


def test_boto3_not_imported_at_module_load():
    assert "import boto3" not in "\n".join(
        line
        for line in (REPO / "scripts" / "seed_demo_collection.py").read_text().splitlines()
        if not line.startswith(" ")
    )


@settings(max_examples=50, deadline=None)
@given(
    st.lists(
        st.tuples(
            st.text("abcdefghij0123456789_-", min_size=1, max_size=12),
            st.sampled_from(seed_mod.LABELS),
        ),
        min_size=1,
        max_size=8,
        unique_by=lambda t: t[0],
    )
)
def test_property_only_family_indexed_and_all_uploaded(pairs):
    entries = [{"id": i, "label": label} for i, label in pairs]
    s3, rek = FakeS3(), FakeRekognition()
    images = {e["id"]: b"x" for e in entries}
    n = seed_mod.seed(s3, rek, "b", entries, images, log=lambda _m: None)
    families = [e["id"] for e in entries if e["label"] == "family"]
    assert n == len(families)
    assert [c["ExternalImageId"] for c in rek.calls] == families
    assert {c["CollectionId"] for c in rek.calls} <= {"warashi-demo"}
    assert len(s3.puts) == len(entries) + 1
