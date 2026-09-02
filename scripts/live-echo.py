#!/usr/bin/env python3
"""Run the post-publication sync and async Echo proofs from an installed package."""

from __future__ import annotations

import asyncio
import json
import os
import time
from uuid import uuid4

from millwork_solver import AsyncSolver, Solver


ECHO_BODY = {
    "mode": "echo",
    "task": {"objective": "Verify the published Millwork Python package."},
    "policy": {
        "data_classes": ["public"],
        "budget": {"max_cost_usd": 1, "max_runtime_s": 30},
    },
}
ACTIVE = {"accepted", "queued", "running", "progress"}


def validate_receipt(execution: dict, receipt: dict) -> dict:
    assert execution["status"] == "completed"
    assert receipt["execution_id"] == execution["execution_id"]
    assert receipt["mode"] == "echo"
    assert receipt["status"] == "completed"
    assert receipt["slices"][0]["route"]["ranking"] == "skipped_platform_proof"
    assert receipt["slices"][0]["verifier"]["identity"] == "platform.echo"
    assert receipt["slices"][0]["cost"]["waiver"]["reason"] == "sandbox_echo_d9"
    assert receipt["totals"]["usd"] == 0
    return {
        "execution_id": execution["execution_id"],
        "terminal_status": execution["status"],
        "receipt_execution_id_matches": True,
        "result_content_expected": False,
        "provider_call_performed": False,
    }


def sync_echo(evidence_id: str) -> dict:
    with Solver(timeout=10.0, max_retries=2) as client:
        execution = client.request(
            "postExecutions",
            body=ECHO_BODY,
            idempotency_key=f"millwork-release-{evidence_id}-sync-{uuid4()}",
        )
        deadline = time.monotonic() + 30
        while execution["status"] in ACTIVE:
            assert time.monotonic() < deadline, f"sync Echo timed out at {execution['status']}"
            time.sleep(0.2)
            execution = client.request(
                "getExecutionsByExecutionId",
                path_parameters={"executionId": execution["execution_id"]},
            )
        receipt = client.request(
            "getReceiptsByExecutionId",
            path_parameters={"executionId": execution["execution_id"]},
        )
    return validate_receipt(execution, receipt)


async def async_echo(evidence_id: str) -> dict:
    async with AsyncSolver(timeout=10.0, max_retries=2) as client:
        execution = await client.request(
            "postExecutions",
            body=ECHO_BODY,
            idempotency_key=f"millwork-release-{evidence_id}-async-{uuid4()}",
        )
        deadline = time.monotonic() + 30
        while execution["status"] in ACTIVE:
            assert time.monotonic() < deadline, f"async Echo timed out at {execution['status']}"
            await asyncio.sleep(0.2)
            execution = await client.request(
                "getExecutionsByExecutionId",
                path_parameters={"executionId": execution["execution_id"]},
            )
        receipt = await client.request(
            "getReceiptsByExecutionId",
            path_parameters={"executionId": execution["execution_id"]},
        )
    return validate_receipt(execution, receipt)


evidence_id = os.environ["MILLWORK_RELEASE_EVIDENCE_ID"]
assert evidence_id and all(character.isalnum() or character in "-_." for character in evidence_id)
print(json.dumps({
    "sync": sync_echo(evidence_id),
    "async": asyncio.run(async_echo(evidence_id)),
}, sort_keys=True))
