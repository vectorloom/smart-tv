#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/preflight-runtime.py"
IMAGE = "ghcr.io/vectorloom/smart-tv:stable"
IMAGE_ID = "sha256:0123456789"
SECRET = "DO_NOT_PRINT_sensitive_runtime_value"


def fixture():
    return {
        "services": {"dashboard": {
            "image": IMAGE,
            "environment": {"ASPNETCORE_URLS": "http://+:8080", "Immich__ApiKey": SECRET},
            "ports": [{"published": "8080", "target": "8080", "host_ip": "10.0.0.11"}],
            "volumes": [
                {"type": "volume", "target": "/app/state", "source": "smart-tv_settings", "read_only": True},
                {"type": "bind", "target": "/run/settings-secrets/wrapping.crt", "source": "/repo/cert", "read_only": True},
                {"type": "bind", "target": "/run/settings-secrets/wrapping.key", "source": "/repo/key", "read_only": True},
            ],
        }}}


def run(case):
    inspect = {"Config": {"Image": IMAGE, "Env": [f"ASPNETCORE_URLS=http://+:8080", f"Immich__ApiKey={SECRET}"]},
               "Image": IMAGE_ID,
               "Mounts": [
                   {"Type": "volume", "Name": "smart-tv_settings", "Destination": "/app/state", "RW": False},
                   {"Type": "bind", "Name": "", "Source": "/repo/cert", "Destination": "/run/settings-secrets/wrapping.crt", "RW": False},
                   {"Type": "bind", "Name": "", "Source": "/repo/key", "Destination": "/run/settings-secrets/wrapping.key", "RW": False},
               ]}
    config = fixture()
    if case == "environment":
        inspect["Config"]["Env"][1] = f"Immich__ApiKey={SECRET}_different"
    elif case == "port":
        config["services"]["dashboard"]["ports"][0]["host_ip"] = "127.0.0.1"
    elif case == "settings-mount":
        inspect["Mounts"][0]["Name"] = "unexpected-volume"
    elif case == "secret-mount":
        inspect["Mounts"][1]["RW"] = True
    elif case == "image":
        inspect["Config"]["Image"] = "unexpected/image:tag"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        docker = tmp_path / "docker"
        docker.write_text("""#!/usr/bin/env python3
import json, os, sys
case=os.environ['MOCK_CASE']
if sys.argv[1:2] == ['inspect']:
    print(json.dumps([json.load(open(os.environ['MOCK_INSPECT']))]))
elif sys.argv[1:3] == ['image', 'inspect']:
    print(json.dumps([{'Os':'linux','Architecture':'amd64','Config':{'Env':[]}}]))
else: sys.exit(2)
""")
        docker.chmod(0o755)
        inspect_path = tmp_path / "inspect.json"
        inspect_path.write_text(json.dumps(inspect))
        env = os.environ | {
            "PATH": f"{tmp}:{os.environ['PATH']}",
            "MOCK_CASE": case,
            "MOCK_INSPECT": str(inspect_path),
            "COMPOSE_IMAGE_LIST": IMAGE,
            "COMPOSE_SERVICE_IMAGE_IDS": IMAGE_ID,
        }
        return subprocess.run(["python3", str(HELPER)], input=json.dumps(config), text=True,
                              capture_output=True, env=env)


ok = run("ok")
assert ok.returncode == 0, ok.stderr
assert "linux/amd64" in ok.stderr and IMAGE in ok.stderr
for case, category in [("environment", "environment"), ("port", "published-port"),
                       ("settings-mount", "settings-mount"), ("secret-mount", "secret-mount"),
                       ("image", "image-reference")]:
    result = run(case)
    assert result.returncode != 0, f"{case} unexpectedly passed"
    assert f"[{category}]" in result.stderr, result.stderr
    assert SECRET not in result.stderr and SECRET not in result.stdout, "secret value leaked"
assert "mismatched names=['Immich__ApiKey']" in run("environment").stderr
print("preflight-runtime diagnostic tests passed")
