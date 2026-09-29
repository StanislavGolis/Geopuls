"""Транспорт для деплоя: неинтерактивный SSH/SFTP к VPS (используется tools/deploy.ps1).

Секретов внутри нет: путь к ключу берётся из ``VPS_KEY`` (по умолчанию ``~/.ssh/id_ed25519``),
адрес и пользователь — из ``VPS_HOST``/``VPS_USER`` (значения по умолчанию — прод-сервер ГЕОПУЛЬС,
см. docs/deploy.md). Пароль из ``VPS_PASSWORD`` используется только как резервный путь: на проде вход
по паролю выключен, работает ключ.

    uv run --with paramiko python tools/vps.py run "uname -a"
    uv run --with paramiko python tools/vps.py sh  path/to/script.sh       # скрипт файлом, не пайпом
    uv run --with paramiko python tools/vps.py bg  path/to/script.sh log   # запуск в фоне, лог на сервере
    uv run --with paramiko python tools/vps.py put <local> <remote>
    uv run --with paramiko python tools/vps.py get <remote> <local>

Почему скрипты передаются файлом, а не через пайп: `docker compose exec -T` и `docker compose cp`
читают stdin и съедают остаток скрипта — команды после первого docker-вызова просто не выполняются.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("VPS_HOST", "201.34.158.13")
USER = os.environ.get("VPS_USER", "root")
PORT = int(os.environ.get("VPS_PORT", "22"))
PASSWORD = os.environ.get("VPS_PASSWORD", "")
KEY = Path(os.environ.get("VPS_KEY", "~/.ssh/id_ed25519")).expanduser()
TIMEOUT = float(os.environ.get("VPS_TIMEOUT", "240"))


def connect() -> paramiko.SSHClient:
    """Подключиться по ключу, а если его нет — по паролю.

    Ключ первый не для удобства: на проде вход по паролю выключен (`/etc/ssh/sshd_config.d/00-geopuls.conf`),
    поэтому деплой обязан работать ключом, а пароль остаётся для серверов, где ключ ещё не заведён.
    """
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    common = {"port": PORT, "username": USER, "timeout": 30, "banner_timeout": 30, "auth_timeout": 30}

    if KEY.exists():
        client.connect(
            HOST, key_filename=str(KEY), allow_agent=False, look_for_keys=False, **common
        )
        return client

    client.connect(HOST, password=PASSWORD, allow_agent=False, look_for_keys=False, **common)
    return client


def execute(client: paramiko.SSHClient, command: str, timeout: float = TIMEOUT) -> tuple[int, str, str]:
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err


def _read_script(path: str) -> str:
    with open(path, encoding="utf-8", newline="") as handle:
        # Windows-редактор пишет CRLF, а bash на сервере на этом спотыкается — нормализуем
        return handle.read().replace("\r\n", "\n").replace("\r", "\n")


def execute_script(client: paramiko.SSHClient, script_path: str, timeout: float = TIMEOUT) -> tuple[int, str, str]:
    sftp = client.open_sftp()
    with sftp.open("/tmp/geopuls-script.sh", "w") as remote:
        remote.write(_read_script(script_path))
    sftp.close()
    return execute(client, "bash /tmp/geopuls-script.sh < /dev/null", timeout=timeout)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    # Консоль Windows в cp1251 не переваривает стрелки и прочую типографику из логов сервера
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    action = sys.argv[1]
    client = connect()
    try:
        if action == "run":
            code, out, err = execute(client, sys.argv[2])
            print(out, end="")
            if err.strip():
                print("--- stderr ---")
                print(err, end="")
            print(f"[exit {code}]")
            return code
        if action in {"sh", "bg"}:
            script = sys.argv[2]
            if action == "sh":
                code, out, err = execute_script(client, script)
                print(out, end="")
                if err.strip():
                    print("--- stderr ---")
                    print(err, end="")
                print(f"[exit {code}]")
                return code
            remote_log = sys.argv[3] if len(sys.argv) > 3 else "/tmp/deploy.log"
            sftp = client.open_sftp()
            with sftp.open("/tmp/geopuls-bg.sh", "w") as remote:
                remote.write(_read_script(script))
            sftp.close()
            code, out, err = execute(
                client, f"nohup bash /tmp/geopuls-bg.sh > {remote_log} 2>&1 & echo started pid $!", timeout=30
            )
            print(out.strip())
            print(f"[запущено в фоне, лог: {remote_log}, exit {code}]")
            return 0
        if action == "put":
            sftp = client.open_sftp()
            sftp.put(sys.argv[2], sys.argv[3])
            sftp.close()
            print(f"uploaded {sys.argv[2]} -> {sys.argv[3]}")
            return 0
        if action == "get":
            sftp = client.open_sftp()
            sftp.get(sys.argv[2], sys.argv[3])
            sftp.close()
            print(f"downloaded {sys.argv[2]} -> {sys.argv[3]}")
            return 0
        print(f"неизвестное действие: {action}")
        return 2
    finally:
        client.close()


if __name__ == "__main__":
    time.sleep(0)
    raise SystemExit(main())
