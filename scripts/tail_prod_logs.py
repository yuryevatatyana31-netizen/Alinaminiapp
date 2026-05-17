#!/usr/bin/env python3
"""
Tail production logs for mini app service over SSH.

Usage:
  $env:DEPLOY_HOST="103.85.113.236"
  $env:DEPLOY_USER="root"
  $env:DEPLOY_PASSWORD="***"
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
    project = os.environ.get("DEPLOY_COMPOSE_PROJECT", "beauty_prod").strip()
    if not host or not password:
        raise RuntimeError("DEPLOY_HOST and DEPLOY_PASSWORD are required.")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(hostname=host, username=user, password=password, timeout=20)
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
