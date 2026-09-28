"""Нагрузочный прогон API ГЕОПУЛЬС: p50/p95/p99 по ключевым эндпоинтам.

Зачем: НФТ требуют p95 `/api/v1/cells` < 300 мс и ограниченный размер ответа (docs/tz.md, §8 и §11.1),
и это нужно не заявить, а измерить.

Запуск (нужен поднятый API):

    uv run python tools/loadtest.py --base-url http://127.0.0.1:8000 --requests 60 --concurrency 6

Скрипт печатает markdown-таблицу (её удобно вставить в отчёт) и завершается с ненулевым кодом,
если какой-то эндпоинт не ответил 200 или p95 превысил бюджет.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from dataclasses import dataclass

import httpx

#: Бюджеты p95 по НФТ (мс). `/cells` — основной эндпоинт карты.
BUDGETS_MS = {
    "cells res 9": 300.0,
    "cells res 8": 300.0,
    "pois ячейки": 300.0,
    "healthz": 100.0,
}


@dataclass(slots=True)
class Measurement:
    name: str
    status: int
    samples: int
    p50: float
    p95: float
    p99: float
    mean: float
    rps: float
    bytes_transferred: int
    bytes_payload: int

    @property
    def within_budget(self) -> bool:
        budget = BUDGETS_MS.get(self.name)
        return self.status == 200 and (budget is None or self.p95 <= budget)


def percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(share * len(ordered)) - 1))
    return ordered[index]


async def measure(
    client: httpx.AsyncClient,
    name: str,
    path: str,
    params: dict[str, str] | None,
    *,
    requests: int,
    concurrency: int,
) -> Measurement:
    latencies: list[float] = []
    statuses: list[int] = []
    transferred = 0
    payload = 0

    semaphore = asyncio.Semaphore(concurrency)

    async def one() -> None:
        nonlocal transferred, payload
        async with semaphore:
            started = time.perf_counter()
            response = await client.get(path, params=params)
            latencies.append((time.perf_counter() - started) * 1000)
            statuses.append(response.status_code)
            transferred += int(response.headers.get("content-length") or len(response.content))
            payload += len(response.content)

    started = time.perf_counter()
    await asyncio.gather(*(one() for _ in range(requests)))
    elapsed = time.perf_counter() - started

    return Measurement(
        name=name,
        status=statistics.mode(statuses),
        samples=len(latencies),
        p50=round(percentile(latencies, 0.5), 1),
        p95=round(percentile(latencies, 0.95), 1),
        p99=round(percentile(latencies, 0.99), 1),
        mean=round(statistics.fmean(latencies), 1),
        rps=round(len(latencies) / elapsed, 1),
        bytes_transferred=round(transferred / len(latencies)),
        bytes_payload=round(payload / len(latencies)),
    )


async def run(base_url: str, requests: int, concurrency: int) -> list[Measurement]:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        # Ячейку для проверки /pois берём у самого API: непустую и плотную
        cells = (await client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe", "res": 9})).json()
        busiest = max(
            (feature for feature in cells["features"] if feature["properties"]["count"] > 0),
            key=lambda feature: feature["properties"]["count"],
        )
        cell_id = busiest["id"]

        plan = [
            ("cells res 9", "/api/v1/cells", {"city": "tomsk", "category": "cafe", "res": 9}),
            ("cells res 8", "/api/v1/cells", {"city": "tomsk", "category": "cafe", "res": 8}),
            ("pois ячейки", "/api/v1/pois", {"city": "tomsk", "cell": cell_id}),
            ("healthz", "/healthz", None),
        ]

        results: list[Measurement] = []
        for name, path, params in plan:
            results.append(await measure(client, name, path, params, requests=requests, concurrency=concurrency))
        return results


def report(results: list[Measurement]) -> None:
    columns = (
        "| Эндпоинт | Код | Запросов | p50, мс | p95, мс | p99, мс "
        "| среднее, мс | RPS | Передано, КБ | Полезная нагрузка, КБ |"
    )
    print()
    print(columns)
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for item in results:
        print(
            f"| {item.name} | {item.status} | {item.samples} | {item.p50} | {item.p95} | {item.p99} "
            f"| {item.mean} | {item.rps} | {item.bytes_transferred / 1024:.1f} | {item.bytes_payload / 1024:.1f} |"
        )
    print()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Нагрузочный прогон API ГЕОПУЛЬС")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--requests", type=int, default=60, help="запросов на эндпоинт")
    parser.add_argument("--concurrency", type=int, default=6)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    results = asyncio.run(run(args.base_url, args.requests, args.concurrency))
    report(results)

    failed = [item.name for item in results if not item.within_budget]
    if failed:
        print(f"Вне бюджета: {', '.join(failed)}")
        return 1
    print("Все эндпоинты в пределах бюджета НФТ.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
