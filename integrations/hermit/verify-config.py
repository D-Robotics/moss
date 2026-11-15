"""Offline frozen-config/loopback binding probe; no model/runtime dependencies."""
import os
from worker import bind_model_proxy, MODEL_PROXY_SENTINEL

def config(base=MODEL_PROXY_SENTINEL):
    return {"base_url": base, "api_key_env": "MOSS_HERMIT_JOB_TOKEN", "model": "model"}

os.environ["MOSS_HERMIT_JOB_BRIDGE"] = "http://127.0.0.1:12345"
for invalid in ["http://127.0.0.1:12345/v1", "moss-job-bridge://v2", "moss-job-bridge://v1/", "https://example.com/v1"]:
    original = config(invalid)
    try:
        bind_model_proxy(original)
        raise AssertionError("non-sentinel config accepted")
    except ValueError as error:
        assert str(error) == "metered_job_model_proxy_required"
        assert original["base_url"] == invalid

for invalid in ["http://example.com:12345", "http://127.0.0.1.example.com:12345", "http://localhost:12345", "https://127.0.0.1:12345", "http://user:secret@127.0.0.1:12345", "http://127.0.0.1:12345/other", "http://127.0.0.1:12345/?token=secret", "http://127.0.0.1:12345/#fragment"]:
    os.environ["MOSS_HERMIT_JOB_BRIDGE"] = invalid
    original = config()
    try:
        bind_model_proxy(original)
        raise AssertionError("invalid private bridge accepted")
    except ValueError as error:
        assert str(error) == "bridge_invalid"
        assert original["base_url"] == MODEL_PROXY_SENTINEL

for valid in ["http://127.0.0.1:12345", "http://[::1]:12345/"]:
    os.environ["MOSS_HERMIT_JOB_BRIDGE"] = valid
    original = config()
    bind_model_proxy(original)
    assert original == {"base_url": valid.rstrip("/") + "/v1", "api_key_env": "MOSS_HERMIT_JOB_TOKEN", "model": "model"}
print("PASS: exact frozen sentinel, mismatch refusal, loopback-only runtime binding and untouched model/auth fields")
