#!/usr/bin/env python3
"""
Deploy mini app to production with mandatory GitHub push and deploy tag.

Usage (PowerShell example):
  $env:DEPLOY_HOST="103.85.113.236"
  $env:DEPLOY_USER="root"
  $env:DEPLOY_KEY_PATH="$env:USERPROFILE\\.ssh\\codex_server_key"
  $env:DEPLOY_COMMIT_TAG="1"   # optional, default on
  python scripts/deploy_prod.py
"""

from __future__ import annotations

import datetime as dt
import os
import posixpath
import subprocess
import sys
from pathlib import Path


try:
    import paramiko
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: paramiko. Install with `pip install paramiko cryptography`."
    ) from exc


REPO_ROOT = Path(__file__).resolve().parents[1]
REMOTE_APP_DIR = "miniapp-web-node"
DEPLOY_FILES = [
    ("server.mjs", "server.mjs"),
    ("web/index.html", "web/index.html"),
    ("web/styles.css", "web/styles.css"),
    ("web/app.js", "web/app.js"),
]
NODE_DOCKERFILE = """\
FROM node:20-alpine
WORKDIR /app
COPY server.mjs ./
COPY web ./web
COPY data ./data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
"""


def run_local(cmd: list[str], check: bool = True) -> str:
    result = subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Local command failed: {' '.join(cmd)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result.stdout.strip()


def ensure_git_is_ready() -> str:
    status = run_local(["git", "status", "--porcelain"])
    if status:
        raise RuntimeError("Git tree is not clean. Commit/stash changes before deploy.")

    branch = run_local(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if branch != "main":
        raise RuntimeError(f"Deploy is allowed only from main. Current branch: {branch}")

    run_local(["git", "push"])
    commit = run_local(["git", "rev-parse", "HEAD"])

    if os.environ.get("DEPLOY_COMMIT_TAG", "1") != "0":
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
        tag = f"deploy/prod-{stamp}-{commit[:7]}"
        run_local(["git", "tag", tag, commit])
        run_local(["git", "push", "origin", tag])
        print(f"[deploy] Created deploy tag: {tag}")

    return commit


class Remote:
    def __init__(self) -> None:
        self.host = os.environ.get("DEPLOY_HOST", "").strip()
        self.user = os.environ.get("DEPLOY_USER", "root").strip()
        self.password = os.environ.get("DEPLOY_PASSWORD", "").strip()
        self.key_path = os.environ.get("DEPLOY_KEY_PATH", "").strip()
        self.root = os.environ.get("DEPLOY_REMOTE_ROOT", "/opt/beauty-booking").strip()
        self.project = os.environ.get("DEPLOY_COMPOSE_PROJECT", "beauty_prod").strip()
        if not self.host:
            raise RuntimeError("DEPLOY_HOST is required.")
        if not self.password and not self.key_path:
            raise RuntimeError("Either DEPLOY_PASSWORD or DEPLOY_KEY_PATH is required.")

        self.ssh = paramiko.SSHClient()
        self.ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        connect_kwargs = {
            "hostname": self.host,
            "username": self.user,
            "timeout": 20,
        }
        if self.key_path:
            connect_kwargs["key_filename"] = self.key_path
        else:
            connect_kwargs["password"] = self.password
        self.ssh.connect(**connect_kwargs)
        self.sftp = self.ssh.open_sftp()

    def close(self) -> None:
        self.sftp.close()
        self.ssh.close()

    def run(self, cmd: str, check: bool = True) -> str:
        stdin, stdout, stderr = self.ssh.exec_command(cmd)
        out = stdout.read().decode("utf-8", "ignore")
        err = stderr.read().decode("utf-8", "ignore")
        code = stdout.channel.recv_exit_status()
        if check and code != 0:
            raise RuntimeError(f"Remote command failed: {cmd}\nOUT:\n{out}\nERR:\n{err}")
        return out.strip()

    def mkdir_p(self, remote_path: str) -> None:
        self.run(f"mkdir -p '{remote_path}'")

    def put_text(self, remote_path: str, content: str) -> None:
        self.mkdir_p(posixpath.dirname(remote_path))
        with self.sftp.file(remote_path, "w") as fh:
            fh.write(content)

    def put_file(self, local_path: Path, remote_path: str) -> None:
        self.mkdir_p(posixpath.dirname(remote_path))
        self.sftp.put(str(local_path), remote_path)

    def deploy(self) -> None:
        remote_app = posixpath.join(self.root, REMOTE_APP_DIR)
        self.mkdir_p(posixpath.join(remote_app, "web"))
        self.mkdir_p(posixpath.join(remote_app, "data"))
        for local_rel, remote_rel in DEPLOY_FILES:
            self.put_file(REPO_ROOT / local_rel, posixpath.join(remote_app, remote_rel))
        self.put_text(posixpath.join(remote_app, "Dockerfile"), NODE_DOCKERFILE)

        compose_path = posixpath.join(self.root, "docker-compose.prod.yml")
        compose = self.sftp.file(compose_path, "r").read().decode("utf-8", "ignore")
        old_block = (
            "services:\n"
            "  miniapp-web:\n"
            "    build:\n"
            "      context: ./miniapp-web\n"
            "      dockerfile: Dockerfile\n"
            "    restart: unless-stopped\n"
        )
        new_block = (
            "services:\n"
            "  miniapp-web:\n"
            "    build:\n"
            "      context: ./miniapp-web-node\n"
            "      dockerfile: Dockerfile\n"
            "    env_file:\n"
            "      - .env\n"
            "    environment:\n"
            "      PORT: \"3000\"\n"
            "      TELEGRAM_BOT_TOKEN: ${MINIAPP_TELEGRAM_BOT_TOKEN}\n"
            "      MASTER_TELEGRAM_USERNAME: ${MINIAPP_MASTER_TELEGRAM_USERNAME:-idushchaya_a}\n"
            "      MASTER_TELEGRAM_ID: ${MINIAPP_MASTER_TELEGRAM_ID:-}\n"
            "      ADMIN_TELEGRAM_USERNAME: ${MINIAPP_ADMIN_TELEGRAM_USERNAME:-Tatyana_Yuryeva}\n"
            "      ADMIN_TELEGRAM_ID: ${MINIAPP_ADMIN_TELEGRAM_ID:-}\n"
            "      MINIAPP_PUBLIC_URL: ${MINIAPP_PUBLIC_URL:-https://electrologinyabot.fd-yureva.ru/miniapp/}\n"
            "    restart: unless-stopped\n"
        )
        if old_block in compose:
            compose = compose.replace(old_block, new_block)
            self.put_text(compose_path, compose)
        elif "./miniapp-web-node" not in compose:
            raise RuntimeError("Unable to patch miniapp-web service in docker-compose.prod.yml.")

        env_path = posixpath.join(self.root, ".env")
        self.run(
            f"grep -q '^MINIAPP_PUBLIC_URL=' '{env_path}' && "
            f"sed -i \"s|^MINIAPP_PUBLIC_URL=.*|MINIAPP_PUBLIC_URL=https://electrologinyabot.fd-yureva.ru/miniapp/|\" '{env_path}' "
            f"|| printf 'MINIAPP_PUBLIC_URL=https://electrologinyabot.fd-yureva.ru/miniapp/\\n' >> '{env_path}'"
        )

        self.run(
            f"cd '{self.root}' && docker compose -p {self.project} -f docker-compose.prod.yml up -d --build miniapp-web"
        )
        self.run("docker exec beauty_prod-nginx-1 nginx -s reload")

        health = self.run("curl -sS 'https://electrologinyabot.fd-yureva.ru/miniapp/api/health'")
        print(f"[deploy] Health: {health}")


def main() -> None:
    commit = ensure_git_is_ready()
    print(f"[deploy] GitHub sync complete. Commit: {commit}")
    remote = Remote()
    try:
        remote.deploy()
    finally:
        remote.close()
    print("[deploy] Deployment completed successfully.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[deploy] ERROR: {error}", file=sys.stderr)
        sys.exit(1)
