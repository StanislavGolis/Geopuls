"""Ошибки API в формате RFC 9457 (``application/problem+json``).

Клиенту (и особенно фронтенду) нужны машинно-читаемые ошибки: ``type``, ``title``, ``status``,
``detail``, ``instance``. Обычный ответ FastAPI ``{"detail": "..."}`` такого не даёт.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_CONTENT_TYPE = "application/problem+json"

#: Заголовки кэширования для ответов с данными (данные меняются раз в неделю).
DATA_CACHE_CONTROL = "public, max-age=3600"

DEFAULT_TITLES: dict[int, str] = {
    400: "Некорректный запрос",
    404: "Не найдено",
    422: "Ошибка валидации",
    500: "Внутренняя ошибка",
    503: "Сервис недоступен",
}


class ProblemException(Exception):
    """Исключение, которое превращается в ответ problem+json."""

    def __init__(
        self,
        status_code: int,
        detail: str,
        *,
        title: str | None = None,
        type_: str = "about:blank",
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.title = title or DEFAULT_TITLES.get(status_code, "Ошибка")
        self.type = type_
        self.extra = extra or {}


def problem_body(
    request: Request,
    *,
    status_code: int,
    detail: str,
    title: str | None = None,
    type_: str = "about:blank",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": type_,
        "title": title or DEFAULT_TITLES.get(status_code, "Ошибка"),
        "status": status_code,
        "detail": detail,
        "instance": request.url.path,
    }
    if extra:
        body.update(extra)
    return body


def problem_response(request: Request, **kwargs: Any) -> JSONResponse:
    """Ответ problem+json с корректным заголовком Content-Type (RFC 9457)."""
    return JSONResponse(
        status_code=kwargs["status_code"],
        content=jsonable_encoder(problem_body(request, **kwargs)),
        media_type=PROBLEM_CONTENT_TYPE,
    )


def register_problem_handlers(app: FastAPI) -> None:
    """Единая обработка ошибок: и наши исключения, и HTTPException, и ошибки валидации."""

    @app.exception_handler(ProblemException)
    async def _handle_problem(request: Request, exc: ProblemException) -> JSONResponse:
        return problem_response(
            request,
            status_code=exc.status_code,
            detail=exc.detail,
            title=exc.title,
            type_=exc.type,
            extra=exc.extra,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "Ошибка запроса"
        return problem_response(request, status_code=exc.status_code, detail=detail)

    @app.exception_handler(RequestValidationError)
    async def _handle_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {
                "location": ".".join(str(part) for part in error.get("loc", ())),
                "message": error.get("msg", ""),
            }
            for error in exc.errors()
        ]
        return problem_response(
            request,
            status_code=422,
            detail="Параметры запроса не прошли валидацию",
            extra={"errors": errors},
        )
