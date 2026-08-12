"""Pure-logic tests for the heatmap API cache (multi-asset spec §1).

No network: the optional Redis backend is exercised with a stub client and
an injected fake `redis` module; the fallback path is the plain file parse.
Requires fastapi (optional dep) only for importing api.server.
"""
import json
import sys
import types

import pytest

pytest.importorskip("fastapi")

from api import server  # noqa: E402


class FakeRedis:
    def __init__(self):
        self.store = {}

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value):
        self.store[key] = value


@pytest.fixture
def atlas_file(tmp_path, monkeypatch):
    doc = {"generated": "2026-08-10T00:00:00",
           "countries": {"ZZ": {"name": "Test", "instruments": {}}}}
    f = tmp_path / "atlas.json"
    f.write_text(json.dumps(doc))
    monkeypatch.setattr(server, "ATLAS_FILE", str(f))
    return f


def test_fallback_without_redis_url(atlas_file, monkeypatch):
    monkeypatch.setattr(server._config, "get_redis_url", lambda: None)
    doc = server.load_doc()
    assert doc["countries"]["ZZ"]["name"] == "Test"


def test_cache_hit_skips_file(atlas_file, monkeypatch):
    fake = FakeRedis()
    fake.set(server._REDIS_KEY_MTIME, str(atlas_file.stat().st_mtime))
    fake.set(server._REDIS_KEY_DOC, json.dumps({"served": "from-cache"}))

    redis_mod = types.ModuleType("redis")
    redis_mod.from_url = lambda url: fake
    monkeypatch.setitem(sys.modules, "redis", redis_mod)
    monkeypatch.setattr(server._config, "get_redis_url",
                        lambda: "redis://stub/0")

    def boom(*a, **k):
        raise AssertionError("file must not be re-read on a cache hit")
    monkeypatch.setattr(server, "_load_file_doc", boom)

    doc = server.load_doc()
    assert doc == {"served": "from-cache"}


def test_cache_miss_repopulates(atlas_file, monkeypatch):
    fake = FakeRedis()  # empty -> miss

    redis_mod = types.ModuleType("redis")
    redis_mod.from_url = lambda url: fake
    monkeypatch.setitem(sys.modules, "redis", redis_mod)
    monkeypatch.setattr(server._config, "get_redis_url",
                        lambda: "redis://stub/0")

    doc = server.load_doc()
    assert doc["countries"]["ZZ"]["name"] == "Test"
    assert fake.get(server._REDIS_KEY_MTIME) == str(atlas_file.stat().st_mtime)
    assert json.loads(fake.get(server._REDIS_KEY_DOC))["countries"]["ZZ"]["name"] == "Test"


def test_stale_cache_is_ignored(atlas_file, monkeypatch):
    fake = FakeRedis()
    fake.set(server._REDIS_KEY_MTIME, "0.0")  # stale vs the file's mtime
    fake.set(server._REDIS_KEY_DOC, json.dumps({"served": "from-cache"}))

    redis_mod = types.ModuleType("redis")
    redis_mod.from_url = lambda url: fake
    monkeypatch.setitem(sys.modules, "redis", redis_mod)
    monkeypatch.setattr(server._config, "get_redis_url",
                        lambda: "redis://stub/0")

    doc = server.load_doc()
    assert doc["countries"]["ZZ"]["name"] == "Test"
    assert fake.get(server._REDIS_KEY_MTIME) == str(atlas_file.stat().st_mtime)


def test_redis_broken_falls_back(atlas_file, monkeypatch):
    redis_mod = types.ModuleType("redis")
    redis_mod.from_url = lambda url: (_ for _ in ()).throw(RuntimeError("down"))
    monkeypatch.setitem(sys.modules, "redis", redis_mod)
    monkeypatch.setattr(server._config, "get_redis_url",
                        lambda: "redis://stub/0")

    doc = server.load_doc()
    assert doc["countries"]["ZZ"]["name"] == "Test"


def test_redis_missing_dependency_falls_back(atlas_file, monkeypatch):
    monkeypatch.delitem(sys.modules, "redis", raising=False)
    monkeypatch.setattr(server._config, "get_redis_url",
                        lambda: "redis://stub/0")
    doc = server.load_doc()
    assert doc["countries"]["ZZ"]["name"] == "Test"


def test_clean_for_json_strips_nan():
    """The drill-down endpoint must serve docs that carry NaN from legacy
    builds — non-finite floats become None (strict json.dumps 500s on NaN)."""
    dirty = {"a": float("nan"), "b": float("inf"), "c": 1.5,
             "d": {"e": float("-nan"), "f": [1.0, float("nan"), None]},
             "g": "ok"}
    clean = server._clean_for_json(dirty)
    assert clean["a"] is None and clean["b"] is None
    assert clean["c"] == 1.5
    assert clean["d"]["e"] is None and clean["d"]["f"] == [1.0, None, None]
    assert clean["g"] == "ok"
    import json as _json
    _json.dumps(clean)  # must be serializable
