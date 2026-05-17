#!/usr/bin/env python3
"""
Tail production logs for mini app service over SSH.

Usage:
  $env:DEPLOY_HOST="103.85.113.236"
  $env:DEPLOY_USER="root"
  $env:DEPLOY_KEY_PATH="$env:USERPROFILE\\.ssh\\codex_server_key"
  python scripts/tail_prod_logs.py
"""

from __future__ import annotations

import os
import sys

try:
    import paramiko
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: paramiko. Install with `pip install paramiko cryptography`."
    ) from exc


def main() -> None:
    host = os.environ.get("DEPLOY_HOST", "").strip()
    user = os.environ.get("DEPLOY_USER", "root").strip()
    password = os.environ.get("DEPLOY_PASSWORD", "").strip()
    key_path = os.environ.get("DEPLOY_KEY_PATH", "").strip()
    project = os.environ.get("DEPLOY_COMPOSE_PROJECT", "beauty_prod").strip()
    if not host:
        raise RuntimeError("DEPLOY_HOST is required.")
    if not password and not key_path:
        raise RuntimeError("Either DEPLOY_PASSWORD or DEPLOY_KEY_PATH is required.")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_kwargs = {
        "hostname": host,
        "username": user,
        "timeout": 20,
    }
    if key_path:
        connect_kwargs["key_filename"] = key_path
    else:
        connect_kwargs["password"] = password
    ssh.connect(**connect_kwargs)
    command = f"docker logs --tail 200 -f {project}-miniapp-web-1"
    _, stdout, stderr = ssh.exec_command(command)
    try:
      for line in iter(stdout.readline, ""):
          if not line:
              break
          print(line, end="")
    except KeyboardInterrupt:
      pass
    err = stderr.read().decode("utf-8", "ignore").strip()
    if err:
        print(err, file=sys.stderr)
    ssh.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[logs] ERROR: {error}", file=sys.stderr)
        sys.exit(1)
