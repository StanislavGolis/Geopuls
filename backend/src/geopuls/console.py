"""Утилиты консольного вывода CLI.

Windows-консоль по умолчанию работает в cp1251: печать символов вроде «²» (км²) падает
с `UnicodeEncodeError`. Для CLI это неприемлемо — команда должна завершаться, а не откатывать
транзакцию из-за символа в отчёте.
"""

from __future__ import annotations

import sys


def enable_utf8_console() -> None:
    """Переключить stdout/stderr в UTF-8 с заменой неподдерживаемых символов.

    `errors="replace"` гарантирует, что вывод никогда не станет причиной падения команды.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # поток может быть уже перенаправлен/закрыт
                continue
