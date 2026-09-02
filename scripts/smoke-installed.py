#!/usr/bin/env python3
"""Exercise both public clients from a clean-installed artifact without a socket."""

from __future__ import annotations

import asyncio
import json

import httpx
from millwork_solver import AsyncSolver, Solver


ECHO_BODY = {
    "mode": "echo",
    "task": {"objective": "Verify the installed Python release candidate."},
    "policy": {
        "data_classes": ["public"],
        "budget": {"max_cost_usd": 1, "max_runtime_s": 30},
    },
}


def response_for(request: httpx.Request) -> httpx.Response:
    if request.method == "POST" and request.url.path == "/v1/executions":
        assert request.headers["idempotency-key"] == "public-export-fixture"
        assert json.loads(request.content) == ECHO_BODY
        return httpx.Response(200, json={"execution_id": "fixture", "status": "completed"}, request=request)
    if request.method == "GET" and request.url.path == "/v1/receipts/fixture":
        return httpx.Response(
            200,
            json={"execution_id": "fixture", "mode": "echo", "status": "completed", "totals": {"usd": 0}},
            request=request,
        )
    raise AssertionError(f"unexpected request: {request.method} {request.url.path}")


def sync_echo() -> None:
    with Solver(
        api_key="fixture",
        base_url="https://fixture.invalid",
        max_retries=0,
        _transport=httpx.MockTransport(response_for),
    ) as client:
        execution = client.request("postExecutions", body=ECHO_BODY, idempotency_key="public-export-fixture")
        receipt = client.request("getReceiptsByExecutionId", path_parameters={"executionId": execution["execution_id"]})
    assert receipt == {"execution_id": "fixture", "mode": "echo", "status": "completed", "totals": {"usd": 0}}


async def async_echo() -> None:
    async with AsyncSolver(
        api_key="fixture",
        base_url="https://fixture.invalid",
        max_retries=0,
        _transport=httpx.MockTransport(response_for),
    ) as client:
        execution = await client.request("postExecutions", body=ECHO_BODY, idempotency_key="public-export-fixture")
        receipt = await client.request("getReceiptsByExecutionId", path_parameters={"executionId": execution["execution_id"]})
    assert receipt == {"execution_id": "fixture", "mode": "echo", "status": "completed", "totals": {"usd": 0}}


sync_echo()
asyncio.run(async_echo())
print(json.dumps({"sync_echo_shape": True, "async_echo_shape": True, "live_network_performed": False}, sort_keys=True))
