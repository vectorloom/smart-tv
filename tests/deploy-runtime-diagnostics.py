#!/usr/bin/env python3
"""Exercise the deployment's inline runtime validator with mocked Docker data."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "scripts/deploy.sh").read_text()
START_MARKER = "python3 -c '\n"
END_MARKER = "\n'; then exit 64; fi"
start = SOURCE.index(START_MARKER) + len(START_MARKER)
end = SOURCE.index(END_MARKER, start)
VALIDATOR = SOURCE[start:end]
SECRET = "DO_NOT_PRINT_secret_environment_value"
PRIVATE_SOURCE = "/private/material/wrapping.key"
IMAGE_ID = "sha256:06c7183542d8d4ffaf03b992d129e747a37a0850316b32373f6dd53d93f4517e"


def fixtures(case):
    config = {"services": {"dashboard": {
        "image": "smart-tv-dashboard",
        "environment": {"ASPNETCORE_URLS": "http://+:8080", "Secret__Token": SECRET},
        "ports": [{"published": "8080", "target": "8080", "host_ip": "10.0.0.11"}],
        "volumes": [
            {"type": "volume", "target": "/app/state", "source": "smart-tv_settings", "read_only": True},
            {"type": "bind", "target": "/run/settings-secrets/wrapping.crt", "source": "/private/material/wrapping.crt", "read_only": True},
            {"type": "bind", "target": "/run/settings-secrets/wrapping.key", "source": PRIVATE_SOURCE, "read_only": True},
        ],
    }}}
    inspect = {"Config": {"Image": "smart-tv-dashboard", "Env": [
        "ASPNETCORE_URLS=http://+:8080", f"Secret__Token={SECRET}",
    ]}, "Image": IMAGE_ID, "Mounts": [
        {"Type": "volume", "Name": "smart-tv_settings", "Destination": "/app/state", "RW": False},
        {"Type": "bind", "Name": "", "Source": "/private/material/wrapping.crt", "Destination": "/run/settings-secrets/wrapping.crt", "RW": False},
        {"Type": "bind", "Name": "", "Source": PRIVATE_SOURCE, "Destination": "/run/settings-secrets/wrapping.key", "RW": False},
    ]}
    image_list = "smart-tv-dashboard"
    compose_ids = IMAGE_ID
    if case == "image-reference":
        config["services"]["dashboard"]["image"] = "another-image"
    elif case == "image-list":
        image_list = "another-image"
    elif case == "image-id":
        compose_ids = "sha256:different"
    elif case == "environment":
        inspect["Config"]["Env"][1] = f"Secret__Token={SECRET}_changed"
    elif case == "port":
        config["services"]["dashboard"]["ports"][0]["host_ip"] = "127.0.0.1"
    elif case == "settings-volume":
        inspect["Mounts"][0]["RW"] = True
    elif case == "settings-volume-identity":
        inspect["Mounts"][0]["Name"] = "wrong-volume"
    elif case == "certificate-mount":
        inspect["Mounts"][2]["RW"] = True
    elif case == "certificate-identity":
        inspect["Mounts"][2]["Source"] = "/different/private/source.key"
    return config, inspect, image_list, compose_ids


def run(case="ok"):
    config, inspect, image_list, compose_ids = fixtures(case)
    with tempfile.TemporaryDirectory() as temporary:
        temp = Path(temporary)
        docker = temp / "docker"
        docker.write_text("""#!/usr/bin/env python3
import json, os, sys
if sys.argv[1:2] == ['inspect']:
    print(json.dumps([json.load(open(os.environ['MOCK_INSPECT']))]))
elif sys.argv[1:3] == ['image', 'inspect']:
    print(json.dumps([json.load(open(os.environ['MOCK_IMAGE_CONFIG']))]))
else: sys.exit(2)
""")
        docker.chmod(0o755)
        inspect_path = temp / "inspect.json"
        inspect_path.write_text(json.dumps(inspect))
        image_config_path = temp / "image.json"
        image_config_path.write_text(json.dumps({"Config": {"Env": []}}))
        env = os.environ | {
            "PATH": f"{temporary}:{os.environ['PATH']}",
            "MOCK_INSPECT": str(inspect_path),
            "MOCK_IMAGE_CONFIG": str(image_config_path),
            "COMPOSE_IMAGE_LIST": image_list,
            "COMPOSE_SERVICE_IMAGE_IDS": compose_ids,
            "NEW_IMAGE_ID": "sha256:new-image",
            "EXPECTED_BIND_ADDRESS": "10.0.0.11",
        }
        return subprocess.run(["python3", "-c", VALIDATOR], input=json.dumps(config),
                              text=True, capture_output=True, env=env)


good = run()
assert good.returncode == 0 and not good.stderr, good.stderr
for case, diagnostic in [
    ("image-reference", "[image identity]: rendered service reference"),
    ("image-list", "[image identity]: running reference is absent"),
    ("image-id", "[image identity]: Compose dashboard image ID differs"),
    ("environment", "[environment]"),
    ("port", "[port binding]"),
    ("settings-volume", "[settings volume]"),
    ("settings-volume-identity", "[settings volume]"),
    ("certificate-mount", "[certificate mount]"),
    ("certificate-identity", "[certificate mount]"),
]:
    result = run(case)
    assert result.returncode != 0, f"{case} unexpectedly passed"
    assert diagnostic in result.stderr, result.stderr
    assert SECRET not in result.stderr and SECRET not in result.stdout, "environment value leaked"
    assert PRIVATE_SOURCE not in result.stderr and PRIVATE_SOURCE not in result.stdout, "mount source leaked"
assert "mismatched names=['Secret__Token']" in run("environment").stderr
print("deployment runtime diagnostics tests passed")
