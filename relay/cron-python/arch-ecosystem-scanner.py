#!/usr/bin/env python3
"""Fleet attention scanner with a six-hour TTL and acknowledgment suppression.

The script is intentionally standalone: cron job 7 executes this file through
the relay shell runner. It reads the local PostgreSQL database directly, keeps
nudge acknowledgments in public.task_nudge_log, and writes the resulting scan
payload to public.shared_context under arch-ecosystem-scan.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    import psycopg2
except ImportError:  # Pure policy tests do not require a database driver.
    psycopg2 = None  # type: ignore[assignment]

SCAN_KEY = "arch-ecosystem-scan"
TTL_HOURS = 6
TERMINAL_STATUSES = {"DONE", "CLOSED", "DUPLICATE", "BLOCKED", "CANCELLED", "COMPLETED"}
OPEN_STAGES = {"PENDING", "CLAIMED", "IN_PROGRESS", "EXECUTION"}
TASK_ID_RE = re.compile(
    r"\b(?:t-[A-Za-z0-9_-]+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b"
)


def iso_z(value: datetime) -> str:
    """Return an RFC3339 UTC timestamp using the vault's Z convention."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_datetime(value: Any) -> datetime | None:
    """Parse database/JSON timestamps; naive values are treated as UTC."""
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, Mapping):
        parsed_value = None
        for key in ("scanned_at", "nudged_at", "updated_at", "created_at"):
            if key in value:
                parsed_value = parse_datetime(value[key])
                if parsed_value is not None:
                    break
        return parsed_value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def decode_scan_value(value: Any) -> dict[str, Any]:
    """Normalize legacy stringified/nested scan payloads into one object."""
    current = value
    for _ in range(6):
        if isinstance(current, Mapping):
            return normalize_scan_dict(dict(current))
        if isinstance(current, list):
            return normalize_scan_dict({"items": current})
        if not isinstance(current, str):
            return {"raw": current} if current is not None else {}
        text = current.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            return {"raw": current}
        if parsed == current:
            return {"raw": current}
        current = parsed
    return {"raw": current}


def normalize_scan_dict(data: dict[str, Any]) -> dict[str, Any]:
    """Recursively normalize scan metadata while preserving unknown fields."""
    result = dict(data)
    scanned_at = result.get("scanned_at")
    if isinstance(scanned_at, Mapping):
        nested = normalize_scan_dict(dict(scanned_at))
        if "scanned_at" in nested:
            result["scanned_at"] = nested["scanned_at"]
    else:
        parsed_at = parse_datetime(scanned_at)
        if parsed_at is None and isinstance(scanned_at, str):
            try:
                nested_timestamp = json.loads(scanned_at)
            except (TypeError, ValueError):
                nested_timestamp = None
            if isinstance(nested_timestamp, Mapping) and "scanned_at" in nested_timestamp:
                parsed_at = parse_datetime(nested_timestamp["scanned_at"])
        if parsed_at is not None:
            result["scanned_at"] = iso_z(parsed_at)

    for key in ("items", "duplicates", "dropped", "acknowledged"):
        if key not in result:
            result[key] = []
        if isinstance(result.get(key), str):
            try:
                result[key] = json.loads(result[key])
            except (TypeError, ValueError):
                pass
    if "changes" not in result:
        result["changes"] = []
    return result


def task_id_from_candidate(candidate: Mapping[str, Any]) -> str | None:
    for key in ("task_id", "id", "source_id"):
        value = candidate.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def build_scan(
    previous: Mapping[str, Any] | str | None,
    candidates: Iterable[Mapping[str, Any]],
    acknowledged_task_ids: Iterable[str] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build a deterministic scan payload from fresh candidates and history.

    Current candidates become items unless they are terminal or acknowledged.
    A previous item missing from the fresh candidate set becomes DUPLICATE
    while its scan timestamp is inside the TTL; older items are dropped.
    """
    scan_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    previous_doc = decode_scan_value(previous) if previous is not None else {}
    ttl_hours = int(previous_doc.get("ttl_hours", TTL_HOURS) or TTL_HOURS)
    ttl = timedelta(hours=ttl_hours)
    acknowledged = {str(value) for value in (acknowledged_task_ids or []) if value is not None}

    current_by_id: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        task_id = task_id_from_candidate(candidate)
        if task_id is None:
            continue
        item = dict(candidate)
        item["task_id"] = task_id
        current_by_id.setdefault(task_id, item)

    items: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    acknowledged_items: list[dict[str, Any]] = []

    for task_id, candidate in current_by_id.items():
        status = str(candidate.get("status") or "").upper()
        if task_id in acknowledged:
            acknowledged_items.append({"task_id": task_id})
            dropped.append({"task_id": task_id, "reason": "acknowledged"})
            continue
        if status in TERMINAL_STATUSES:
            dropped.append({"task_id": task_id, "reason": "terminal_status"})
            continue
        item = dict(candidate)
        item["task_id"] = task_id
        item["scanned_at"] = iso_z(scan_time)
        item["ttl_hours"] = ttl_hours
        items.append(item)

    previous_items = previous_doc.get("items", [])
    if not isinstance(previous_items, list):
        previous_items = []
    for old_item in previous_items:
        if not isinstance(old_item, Mapping):
            continue
        task_id = task_id_from_candidate(old_item)
        if task_id is None or task_id in current_by_id:
            continue
        status = str(old_item.get("status") or "").upper()
        if task_id in acknowledged:
            acknowledged_items.append({"task_id": task_id})
            dropped.append({"task_id": task_id, "reason": "acknowledged"})
            continue
        if status in TERMINAL_STATUSES:
            dropped.append({"task_id": task_id, "reason": "terminal_status"})
            continue

        old_time = (
            parse_datetime(old_item.get("scanned_at"))
            or parse_datetime(previous_doc.get("scanned_at"))
            or parse_datetime(old_item.get("nudged_at"))
        )
        if old_time is None:
            dropped.append({"task_id": task_id, "reason": "missing_scan_time"})
            continue
        duplicate = dict(old_item)
        duplicate["task_id"] = task_id
        duplicate["status"] = "DUPLICATE"
        duplicate["scanned_at"] = iso_z(old_time)
        duplicate["ttl_hours"] = ttl_hours
        if scan_time - old_time <= ttl:
            duplicates.append(duplicate)
        else:
            dropped.append({"task_id": task_id, "reason": "expired"})

    items.sort(key=lambda item: item["task_id"])
    duplicates.sort(key=lambda item: item["task_id"])
    dropped.sort(key=lambda item: item["task_id"])
    acknowledged_items.sort(key=lambda item: item["task_id"])

    source_counts = Counter(str(item.get("source") or "unknown") for item in items)
    return {
        "scanned_at": iso_z(scan_time),
        "ttl_hours": ttl_hours,
        "items": items,
        "duplicates": duplicates,
        "dropped": dropped,
        "acknowledged": acknowledged_items,
        "source_counts": dict(sorted(source_counts.items())),
        "changes": [
            f"items: {len(items)}",
            f"duplicates: {len(duplicates)}",
            f"dropped: {len(dropped)}",
        ],
    }


def extract_task_ids(text: Any) -> list[str]:
    """Extract task IDs in first-seen order without repeating one ID."""
    found: list[str] = []
    seen: set[str] = set()
    for match in TASK_ID_RE.finditer(str(text or "")):
        task_id = match.group(0)
        if task_id not in seen:
            found.append(task_id)
            seen.add(task_id)
    return found


def row_dict(cursor: Any, row: tuple[Any, ...]) -> dict[str, Any]:
    return {description.name: value for description, value in zip(cursor.description, row)}


def load_previous_scan(connection: Any) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT value FROM public.shared_context WHERE context_key = %s",
            (SCAN_KEY,),
        )
        row = cursor.fetchone()
    return decode_scan_value(row[0]) if row else {}


def load_candidates(connection: Any) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, title, stage, status, assignee_agent_id, updated_at, created_at, metadata
              FROM public.tasks
             WHERE status IS DISTINCT FROM 'DONE'
               AND status IS DISTINCT FROM 'CLOSED'
               AND status IS DISTINCT FROM 'DUPLICATE'
               AND status IS DISTINCT FROM 'BLOCKED'
               AND status IS DISTINCT FROM 'CANCELLED'
               AND status IS DISTINCT FROM 'COMPLETED'
               AND (stage IN ('PENDING', 'CLAIMED', 'IN_PROGRESS', 'EXECUTION') OR stage IS NULL)
               AND assignee_agent_id IS NOT NULL
             ORDER BY updated_at DESC
            """
        )
        for row in cursor:
            item = row_dict(cursor, row)
            candidates.append(
                {
                    "task_id": item["id"],
                    "title": item.get("title") or "",
                    "stage": item.get("stage"),
                    "status": item.get("status") or "UNKNOWN",
                    "assignee_agent_id": item.get("assignee_agent_id"),
                    "updated_at": iso_z(item["updated_at"]) if parse_datetime(item.get("updated_at")) else None,
                    "created_at": iso_z(item["created_at"]) if parse_datetime(item.get("created_at")) else None,
                    "source": "tasks",
                }
            )

        cursor.execute(
            """
            SELECT id, agent_id, agent_name, message, created_at
              FROM public.fleet_messages
             WHERE created_at > NOW() - INTERVAL '6 hours'
             ORDER BY created_at DESC
            """
        )
        for row in cursor:
            item = row_dict(cursor, row)
            for task_id in extract_task_ids(item.get("message")):
                candidates.append(
                    {
                        "task_id": task_id,
                        "title": (item.get("message") or "")[:180],
                        "status": "UNRESOLVED",
                        "source": "fleet_message",
                        "message_id": item.get("id"),
                        "agent_id": item.get("agent_id"),
                        "agent_name": item.get("agent_name"),
                        "created_at": iso_z(item["created_at"]) if parse_datetime(item.get("created_at")) else None,
                    }
                )

        cursor.execute(
            """
            SELECT context_key, value, updated_at
              FROM public.shared_context
             WHERE context_key <> %s
               AND updated_at > NOW() - INTERVAL '6 hours'
             ORDER BY updated_at DESC
            """,
            (SCAN_KEY,),
        )
        for row in cursor:
            item = row_dict(cursor, row)
            serialized = item.get("value")
            if not isinstance(serialized, str):
                serialized = json.dumps(serialized, ensure_ascii=False, default=str)
            for task_id in extract_task_ids(serialized):
                candidates.append(
                    {
                        "task_id": task_id,
                        "title": f"Shared context: {item.get('context_key')}",
                        "status": "UNRESOLVED",
                        "source": "shared_context",
                        "context_key": item.get("context_key"),
                        "updated_at": iso_z(item["updated_at"]) if parse_datetime(item.get("updated_at")) else None,
                    }
                )

    deduplicated: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        task_id = task_id_from_candidate(candidate)
        if task_id is not None:
            deduplicated.setdefault(task_id, candidate)
    return list(deduplicated.values())


def ensure_nudge_table(connection: Any) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS public.task_nudge_log (
              id bigserial PRIMARY KEY,
              task_id text NOT NULL,
              nudged_at timestamptz NOT NULL DEFAULT now(),
              acknowledged_at timestamptz
            )
            """
        )
        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS task_nudge_log_task_idx
            ON public.task_nudge_log (task_id, nudged_at DESC)
            """
        )


def load_acknowledged_task_ids(connection: Any) -> set[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT task_id FROM public.task_nudge_log WHERE acknowledged_at IS NOT NULL"
        )
        return {str(row[0]) for row in cursor if row and row[0] is not None}


def record_nudges(connection: Any, items: Iterable[Mapping[str, Any]], now: datetime) -> int:
    """Insert one nudge per emitted item, idempotent within a five-minute run."""
    inserted = 0
    with connection.cursor() as cursor:
        for item in items:
            task_id = task_id_from_candidate(item)
            if task_id is None:
                continue
            cursor.execute(
                """
                INSERT INTO public.task_nudge_log (task_id, nudged_at)
                SELECT %s, %s
                 WHERE NOT EXISTS (
                   SELECT 1 FROM public.task_nudge_log
                    WHERE task_id = %s
                      AND nudged_at > %s - INTERVAL '5 minutes'
                 )
                """,
                (task_id, now, task_id, now),
            )
            inserted += max(cursor.rowcount or 0, 0)
    return inserted


def write_scan(connection: Any, payload: Mapping[str, Any]) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO public.shared_context
              (context_key, context_type, value, description, tags, last_updated_by, created_at, updated_at)
            VALUES
              (%s, 'general', %s::jsonb, 'Arch ecosystem scan results', ARRAY[]::text[], 'arch-ecosystem-scanner', NOW(), NOW())
            ON CONFLICT (context_key) DO UPDATE SET
              context_type = EXCLUDED.context_type,
              value = EXCLUDED.value,
              description = COALESCE(public.shared_context.description, EXCLUDED.description),
              tags = COALESCE(public.shared_context.tags, EXCLUDED.tags),
              last_updated_by = EXCLUDED.last_updated_by,
              updated_at = NOW()
            """,
            (SCAN_KEY, serialized),
        )


def acknowledge_task(connection: Any, task_id: str) -> None:
    """Mark all existing nudge rows for a task acknowledged; create one if absent."""
    ensure_nudge_table(connection)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE public.task_nudge_log SET acknowledged_at = COALESCE(acknowledged_at, NOW()) WHERE task_id = %s",
            (task_id,),
        )
        if cursor.rowcount == 0:
            cursor.execute(
                "INSERT INTO public.task_nudge_log (task_id, nudged_at, acknowledged_at) VALUES (%s, NOW(), NOW())",
                (task_id,),
            )


def run_scan(database_url: str | None = None) -> dict[str, Any]:
    if psycopg2 is None:
        raise RuntimeError("psycopg2 is required for a live scanner run")
    url = database_url or os.environ.get("LOCAL_DATABASE_URL") or "postgres://postgres@127.0.0.1:5432/xmrt_suite"
    connection = psycopg2.connect(url)
    try:
        ensure_nudge_table(connection)
        previous = load_previous_scan(connection)
        candidates = load_candidates(connection)
        acknowledged = load_acknowledged_task_ids(connection)
        now = datetime.now(timezone.utc)
        payload = build_scan(previous, candidates, acknowledged, now)
        record_nudges(connection, payload["items"], now)
        write_scan(connection, payload)
        connection.commit()
        return payload
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default=None)
    parser.add_argument(
        "--acknowledge",
        action="append",
        default=[],
        metavar="TASK_ID",
        help="mark a task acknowledged in task_nudge_log and exit",
    )
    args = parser.parse_args(argv)

    if args.acknowledge:
        if psycopg2 is None:
            raise RuntimeError("psycopg2 is required for acknowledgment updates")
        url = args.database_url or os.environ.get("LOCAL_DATABASE_URL") or "postgres://postgres@127.0.0.1:5432/xmrt_suite"
        connection = psycopg2.connect(url)
        try:
            for task_id in args.acknowledge:
                acknowledge_task(connection, task_id)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        print(json.dumps({"acknowledged": args.acknowledge}, separators=(",", ":")))
        return 0

    payload = run_scan(args.database_url)
    print(
        json.dumps(
            {
                "success": True,
                "scanned_at": payload["scanned_at"],
                "ttl_hours": payload["ttl_hours"],
                "items": len(payload["items"]),
                "duplicates": len(payload["duplicates"]),
                "dropped": len(payload["dropped"]),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
