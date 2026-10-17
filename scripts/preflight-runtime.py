#!/usr/bin/env python3
"""Compare rendered dashboard configuration with the running container safely."""
import json
import os
import re
import subprocess
import sys


def fail(category, detail):
    print(f"preflight: runtime mismatch [{category}]: {detail}", file=sys.stderr)


def docker_json(*args):
    return json.loads(subprocess.check_output(["docker", *args], text=True))


def canonical(name):
    return name if "@" in name or ":" in name.rsplit("/", 1)[-1] else name + ":latest"


def main():
    config = json.load(sys.stdin)
    service = config["services"]["dashboard"]
    inspect = docker_json("inspect", "smart-tv-dashboard-1")[0]
    errors = 0

    def report(category, detail):
        nonlocal errors
        errors += 1
        fail(category, detail)

    running = inspect["Config"].get("Image")
    expected = service.get("image")
    image_list = os.environ["COMPOSE_IMAGE_LIST"].splitlines()
    image_ids = os.environ["COMPOSE_SERVICE_IMAGE_IDS"].splitlines()
    print(f"preflight: image facts: running={running!r} expected={expected!r} compose_images={image_list!r}", file=sys.stderr)
    if not running:
        report("image-reference", "running image reference is missing")
    if expected and running and canonical(running) != canonical(expected):
        report("image-reference", f"running={running!r} expected={expected!r}")
    if running and canonical(running) not in {canonical(name) for name in image_list}:
        report("image-list", f"running image {running!r} is absent from Compose image references")
    if image_ids != [inspect.get("Image")]:
        report("image-id", f"Compose dashboard image IDs={image_ids!r}; running image ID={inspect.get('Image')!r}")
    image_repo = (running or "").split("@", 1)[0]
    if ":" in image_repo.rsplit("/", 1)[-1]:
        image_repo = image_repo.rsplit(":", 1)[0]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*", image_repo):
        report("image-reference", "running image reference cannot be used as a repository name")
    try:
        image_config = docker_json("image", "inspect", inspect["Image"])[0]
        image_platform = f"{image_config['Os']}/{image_config['Architecture']}"
        print(f"preflight: image platform: {image_platform}", file=sys.stderr)
    except Exception:
        report("image-platform", "cannot inspect running image platform")

    desired_env = {str(k): str(v) for k, v in service.get("environment", {}).items()}
    current_env = dict(item.split("=", 1) for item in inspect["Config"].get("Env", []) if "=" in item)
    expected_env = dict(item.split("=", 1) for item in image_config.get("Config", {}).get("Env", []) if "=" in item) if "image_config" in locals() else {}
    expected_env.update(desired_env)
    missing = sorted(expected_env.keys() - current_env.keys())
    extra = sorted(current_env.keys() - expected_env.keys())
    mismatched = sorted(k for k in expected_env.keys() & current_env.keys() if expected_env[k] != current_env[k])
    if missing or extra or mismatched:
        report("environment", f"missing names={missing!r}; extra names={extra!r}; mismatched names={mismatched!r}")

    ports = service.get("ports", [])
    if not any(str(p.get("published")) == "8080" and str(p.get("target")) == "8080" and p.get("host_ip") == "10.0.0.11" for p in ports):
        report("published-port", f"expected bind 10.0.0.11:8080->8080; rendered binds={[(p.get('host_ip'), p.get('published'), p.get('target')) for p in ports]!r}")

    mounts = inspect.get("Mounts", [])
    mount_facts = [(m.get("Destination"), "rw" if m.get("RW") else "ro", m.get("Name") or m.get("Type")) for m in mounts]
    print(f"preflight: mount facts (destination, mode, identity): {mount_facts!r}", file=sys.stderr)
    if not any(m.get("Name") == "smart-tv_settings" and m.get("Destination") == "/app/state" and not m.get("RW") for m in mounts):
        report("settings-mount", "expected /app/state ro mount with volume identity smart-tv_settings is missing")
    desired_mounts = {m.get("target"): m for m in service.get("volumes", [])}
    current_mounts = {m.get("Destination"): m for m in mounts}
    for target in ("/run/settings-secrets/wrapping.crt", "/run/settings-secrets/wrapping.key"):
        desired = desired_mounts.get(target)
        current = current_mounts.get(target)
        if not desired or desired.get("type") != "bind" or not desired.get("read_only") or not current or current.get("RW"):
            report("secret-mount", f"destination={target!r}; expected rendered bind and running ro mount")
        elif current.get("Source") != desired.get("source"):
            report("secret-mount", f"destination={target!r}; rendered and running source identities differ")

    if errors:
        return 1
    print(image_repo)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Exception text can contain config values or filesystem paths; omit it.
        print("preflight: runtime mismatch [validator]: input or Docker inspection failed", file=sys.stderr)
        sys.exit(1)
