#!/usr/bin/env python3
"""Import recorded Experiment 1-1 evidence into Langfuse, without rerunning it.

Uses OTLP/HTTP JSON and the Scores API supported by the pinned v4.66.0 release.
Stable IDs permit verification. Existing observations are never re-ingested:
Langfuse v4 observations are immutable and do not deduplicate repeated IDs.
Per-call latency was not measured: imported calls are point observations, with
the original timestamp source and this limitation in their metadata.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, build_opener, ProxyHandler
from zoneinfo import ZoneInfo

LABELS = {
    "full": "完整上下文", "no_history": "移除历史消息",
    "no_reasoning": "移除历史推理", "no_tool_calls": "移除工具定义",
    "no_tool_results": "移除工具结果",
}
NAMESPACE = uuid.UUID("3bd57515-4313-4e04-8962-e23c44c937a6")


def iso(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def stable_id(digest, name, length=32):
    return uuid.uuid5(NAMESPACE, digest + "/" + name).hex[:length]


def message(turn):
    return (turn.get("response", {}).get("choices") or [{}])[0].get("message") or {}


def tool_time(value, fallback):
    if not value:
        return fallback
    stamp = datetime.fromisoformat(value)
    # This evidence was captured on the user's Asia/Shanghai machine.
    return stamp.replace(tzinfo=ZoneInfo("Asia/Shanghai")) if stamp.tzinfo is None else stamp


def build_import(evidence, digest):
    now = iso(datetime.now(timezone.utc))
    session = "exp1-1-" + digest[:12]
    events, traces = [], []

    def event(kind, name, body):
        events.append({"id": stable_id(digest, "event/" + name), "timestamp": now, "type": kind, "body": body})

    for arm in evidence["arms"]:
        mode = arm["mode"]
        trace_id = stable_id(digest, mode)
        root_id = stable_id(digest, mode + "/root", 16)
        started = datetime.fromisoformat(arm["started_at"])
        metadata = {
            "experiment_id": "1-1", "mode": mode, "outcome": arm["outcome"],
            "source_sha256": digest, "imported_historical_evidence": True,
            "context_contract": arm["context_contract"], "groundedness": arm["groundedness"],
            "measured_run_elapsed_seconds": arm["elapsed_seconds"],
            "timing_note": "Run duration is recorded; individual call latency is unknown. Child calls are point observations, not measured 0ms executions.",
        }
        trace_body = {
            "id": trace_id, "timestamp": iso(started), "name": "1-1 / " + LABELS[mode],
            "input": {"task": evidence["task"]}, "output": arm["final_answer"],
            "sessionId": session, "environment": "book-experiments", "public": False,
            "tags": ["experiment-1-1", mode, arm["outcome"], "historical-import"],
            "metadata": metadata, "release": evidence.get("repository", {}).get("commit"),
        }
        event("trace-create", mode + "/trace", trace_body)
        event("agent-create", mode + "/root", {
            "id": root_id, "traceId": trace_id, "name": LABELS[mode],
            "startTime": iso(started), "endTime": iso(started + timedelta(seconds=arm["elapsed_seconds"])),
            "input": {"task": evidence["task"]}, "output": arm["final_answer"], "metadata": metadata,
            "level": "ERROR" if arm["outcome"] == "unsupported_numbers" else "WARNING" if not arm["completed"] else "DEFAULT",
            "statusMessage": arm["outcome"],
        })
        cursor, seen = 0, set()
        for turn in arm["api_turns"]:
            index = turn["iteration"]
            llm_id = stable_id(digest, f"{mode}/llm/{index}", 16)
            created = turn.get("response", {}).get("created")
            stamp = datetime.fromtimestamp(created, timezone.utc) if created else started
            usage = turn.get("response", {}).get("usage") or {}
            request = turn["request"]
            event("generation-create", f"{mode}/llm/{index}", {
                "id": llm_id, "traceId": trace_id, "parentObservationId": root_id,
                "name": f"{index:02d} · {arm['model']} · latency unrecorded", "model": arm["model"],
                "startTime": iso(stamp), "endTime": iso(stamp),
                "input": request.get("messages", []), "output": message(turn),
                "modelParameters": {key: request[key] for key in ("temperature", "max_tokens") if key in request},
                "usage": {"input": usage.get("prompt_tokens", 0), "output": usage.get("completion_tokens", 0), "unit": "TOKENS"},
                "metadata": {
                    "iteration": index, "request": request, "raw_response": turn["response"],
                    "base_url": turn.get("base_url"), "source_timestamp": created,
                    "timing_source": "response.created (second precision)" if created else "run start (fallback)",
                    "timing_is_point_observation": True, "measured_latency_available": False,
                },
            })
            for call_index, call in enumerate(message(turn).get("tool_calls") or []):
                local = arm["tool_calls"][cursor]
                cursor += 1
                arguments = json.loads(call["function"]["arguments"])
                if local["tool_name"] != call["function"]["name"] or local["arguments"] != arguments:
                    raise ValueError("Tool call does not match execution record")
                signature = json.dumps([local["tool_name"], arguments], sort_keys=True)
                repeated = signature in seen
                seen.add(signature)
                next_turn = next((t for t in arm["api_turns"] if t["iteration"] > index), None)
                sent = next((m for m in (next_turn or {}).get("request", {}).get("messages", []) if m.get("role") == "tool" and m.get("tool_call_id") == call["id"]), None)
                tool_stamp = tool_time(local.get("timestamp"), stamp)
                event("tool-create", f"{mode}/tool/{index}/{call_index}", {
                    "id": stable_id(digest, f"{mode}/tool/{index}/{call_index}", 16),
                    "traceId": trace_id, "parentObservationId": llm_id,
                    "name": local["tool_name"] + (" · repeated" if repeated else ""),
                    "startTime": iso(tool_stamp), "endTime": iso(tool_stamp),
                    "input": arguments,
                    "output": {"local_execution_result": local["result"], "sent_to_model_in_next_request": sent},
                    "metadata": {"tool_call_id": call["id"], "iteration": index,
                                 "visible_to_model": bool(sent and sent.get("content")),
                                 "next_request_exists": next_turn is not None,
                                 "repeated_action": repeated, "timing_is_point_observation": True,
                                 "measured_latency_available": False,
                                 "timing_source": "local execution-record timestamp (Asia/Shanghai)"},
                    "level": "WARNING" if repeated or not (sent and sent.get("content")) else "DEFAULT",
                })
        if cursor != len(arm["tool_calls"]):
            raise ValueError("Unmatched tool executions")
        for key, value in {
            "task_success": arm["task_success"], "completed": arm["completed"],
            "context_contract_passed": arm["context_contract"]["passed"],
            "unsupported_numbers": arm["outcome"] == "unsupported_numbers",
        }.items():
            event("score-create", f"{mode}/score/{key}", {
                "id": stable_id(digest, f"{mode}/score/{key}"), "traceId": trace_id,
                "name": key, "value": int(value), "dataType": "NUMERIC", "observationId": root_id,
                "timestamp": iso(started),
                "comment": "Imported from Experiment 1-1 evidence; no new model judging.",
            })
        event("score-create", mode + "/score/outcome", {
            "id": stable_id(digest, mode + "/score/outcome"), "traceId": trace_id,
            "name": "outcome", "value": arm["outcome"], "dataType": "CATEGORICAL", "observationId": root_id,
            "timestamp": iso(started),
        })
        traces.append({"mode": mode, "trace_id": trace_id, "root_id": root_id,
                       "generations": len(arm["api_turns"]), "tools": len(arm["tool_calls"]),
                       "observations": 1 + len(arm["api_turns"]) + len(arm["tool_calls"]), "scores": 5})
    return {"source_sha256": digest, "session_id": session, "traces": traces, "events": events}


def otlp_body(payload, dataset_id, item_id, expected_output):
    """Translate the normalized records to complete, immutable OTel spans."""
    def attribute(key, value):
        if isinstance(value, bool):
            encoded = {"boolValue": value}
        elif isinstance(value, int):
            encoded = {"intValue": str(value)}
        elif isinstance(value, list) and all(isinstance(x, str) for x in value):
            encoded = {"arrayValue": {"values": [{"stringValue": x} for x in value]}}
        else:
            encoded = {"stringValue": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)}
        return {"key": key, "value": encoded}

    traces = {t["trace_id"]: t for t in payload["traces"]}
    trace_events = {e["body"]["id"]: e["body"] for e in payload["events"] if e["type"] == "trace-create"}
    spans = []
    for event in payload["events"]:
        if event["type"] not in ["agent-create", "generation-create", "tool-create"]:
            continue
        body = event["body"]
        trace = traces[body["traceId"]]
        trace_event = trace_events[body["traceId"]]
        attrs = {
            "langfuse.observation.type": event["type"].removesuffix("-create"),
            "langfuse.observation.input": json.dumps(body["input"], ensure_ascii=False),
            "langfuse.observation.output": json.dumps(body["output"], ensure_ascii=False),
            "langfuse.observation.metadata": body["metadata"],
            "langfuse.observation.level": body.get("level", "DEFAULT"),
            "langfuse.observation.status_message": body.get("statusMessage", ""),
            "langfuse.trace.name": trace_event["name"],
            "langfuse.trace.tags": trace_event["tags"],
            "session.id": payload["session_id"], "langfuse.environment": "book-experiments",
            "langfuse.experiment.id": stable_id(payload["source_sha256"], trace["mode"] + "/experiment"),
            "langfuse.experiment.name": f"1-1 | {trace['mode']} | {payload['source_sha256'][:8]}",
            "langfuse.experiment.dataset.id": dataset_id,
            "langfuse.experiment.item.id": item_id,
            "langfuse.experiment.item.root_observation_id": trace["root_id"],
            "langfuse.experiment.metadata.source_sha256": payload["source_sha256"],
            "langfuse.experiment.metadata.execution_mode": "historical-import",
        }
        if event["type"] == "agent-create":
            attrs["langfuse.experiment.item.expected_output"] = json.dumps(expected_output)
            attrs["langfuse.experiment.description"] = "Experiment 1-1: context ablation, imported without rerunning the model."
        if event["type"] == "generation-create":
            attrs["langfuse.observation.model.name"] = body["model"]
            attrs["langfuse.observation.model.parameters"] = body["modelParameters"]
            attrs["langfuse.observation.usage_details"] = {k: body["usage"][k] for k in ["input", "output"]}
        def nanos(value):
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return str(int(stamp.timestamp() * 1_000_000_000))
        span = {
            "traceId": body["traceId"], "spanId": body["id"], "name": body["name"], "kind": 1,
            "startTimeUnixNano": nanos(body["startTime"]), "endTimeUnixNano": nanos(body["endTime"]),
            "attributes": [attribute(key, value) for key, value in attrs.items()],
            "status": {"code": 2 if body.get("level") == "ERROR" else 1},
        }
        if body.get("parentObservationId"):
            span["parentSpanId"] = body["parentObservationId"]
        spans.append(span)
    return {"resourceSpans": [{"resource": {"attributes": [attribute("service.name", "ai-agent-book-context-experiment")]},
                               "scopeSpans": [{"scope": {"name": "experiment-evidence-importer", "version": "1.0"}, "spans": spans}]}]}


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, default=Path(__file__).with_name(".env"))
    parser.add_argument("--base-url")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    raw = args.evidence.read_bytes()
    if re.search(rb"\bsk-[A-Za-z0-9_-]{20,}", raw):
        raise ValueError("Evidence appears to contain an API secret; refusing to import")
    evidence = json.loads(raw)
    if evidence.get("experiment_id") != "1-1":
        raise ValueError("Expected Experiment 1-1 evidence")
    payload = build_import(evidence, hashlib.sha256(raw).hexdigest())
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    summary = {key: value for key, value in payload.items() if key != "events"}
    summary["event_count"] = len(payload["events"])
    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    env = read_env(args.env_file)
    base_url = (args.base_url or env["NEXTAUTH_URL"]).rstrip("/")
    auth = base64.b64encode((env["LANGFUSE_INIT_PROJECT_PUBLIC_KEY"] + ":" + env["LANGFUSE_INIT_PROJECT_SECRET_KEY"]).encode()).decode()
    # Internal/tunneled destinations must not send project credentials to a proxy.
    opener = build_opener(ProxyHandler({}))

    def api(method, path, body=None):
        request = Request(base_url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                          headers={"Authorization": "Basic " + auth, "Content-Type": "application/json", "x-langfuse-ingestion-version": "4"})
        for attempt in range(4):
            try:
                with opener.open(request, timeout=45) as response:
                    data = response.read()
                    return json.loads(data) if data else {}
            except HTTPError as error:
                if method != "GET" or error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    detail = error.read().decode()[:2000]
                    for key in ("LANGFUSE_INIT_PROJECT_SECRET_KEY", "LANGFUSE_INIT_USER_PASSWORD"):
                        detail = detail.replace(env.get(key, "\x00"), "[REDACTED]")
                    raise RuntimeError(f"{method} {path}: HTTP {error.code}: {detail}") from None
                time.sleep(2 ** attempt)

    dataset_name = "experiment-1-1-context-ablation"
    try:
        dataset = api("GET", "/api/public/v2/datasets/" + dataset_name)
    except RuntimeError as error:
        if "HTTP 404" not in str(error):
            raise
        dataset = api("POST", "/api/public/v2/datasets", {"name": dataset_name, "description": "Context ablation experiment from AI Agent Book"})
    item_id = stable_id(hashlib.sha256(evidence["task"].encode()).hexdigest(), "dataset-item")
    expected_output = {"annual_total_usd": 9602895.73, "quarterly_average_usd": 2400723.93}
    api("POST", "/api/public/dataset-items", {"id": item_id, "datasetName": dataset_name,
                                             "input": {"task": evidence["task"]}, "expectedOutput": expected_output})
    summary["dataset_id"] = dataset["id"]
    body = otlp_body(payload, dataset["id"], item_id, expected_output)
    def observations(trace_id):
        return api("GET", "/api/public/v2/observations?limit=100&traceId=" + quote(trace_id))["data"]
    existing = {trace["trace_id"]: observations(trace["trace_id"]) for trace in payload["traces"]}
    expected_ids = {trace["trace_id"]: {span["spanId"] for span in body["resourceSpans"][0]["scopeSpans"][0]["spans"] if span["traceId"] == trace["trace_id"]} for trace in payload["traces"]}
    already_imported = all(len(existing[t["trace_id"]]) == t["observations"] and {o["id"] for o in existing[t["trace_id"]]} == expected_ids[t["trace_id"]] for t in payload["traces"])
    marker = args.env_file.with_name(".otel-upload-" + payload["source_sha256"][:12] + ".json")
    if not already_imported:
        if any(existing.values()) or marker.exists():
            raise RuntimeError("Partial or uncertain earlier upload. Inspect stored observations before retrying; v4 does not deduplicate spans.")
        marker.write_text(json.dumps({"state": "attempted", "source_sha256": payload["source_sha256"], "traces": payload["traces"]}))
        result = api("POST", "/api/public/otel/v1/traces", body)
        if result.get("partialSuccess", {}).get("rejectedSpans", 0) not in (0, "0"):
            raise RuntimeError("OTLP rejected spans: " + json.dumps(result))
        marker.write_text(json.dumps({"state": "accepted", "source_sha256": payload["source_sha256"], "traces": payload["traces"]}))
        print("OTLP accepted 51 recorded observations; waiting for storage verification.", flush=True)
    else:
        print("All recorded observations already exist; skipping OTLP upload.", flush=True)
    scores = [e["body"] for e in payload["events"] if e["type"] == "score-create"]
    result = api("POST", "/api/public/scores", scores)
    if result.get("rejected", 0) or result.get("errors"):
        raise RuntimeError("Score ingestion errors: " + json.dumps(result))

    # Ingestion is queued. Verify stored content, not just an accepted HTTP batch.
    for attempt in range(24):
        stored = []
        for trace in payload["traces"]:
            try:
                obs = observations(trace["trace_id"])
                score_data = api("GET", "/api/public/v3/scores?limit=100&traceId=" + quote(trace["trace_id"]))["data"]
                if {o["id"] for o in obs} != expected_ids[trace["trace_id"]]:
                    print("Waiting for observations:", trace["mode"], len(obs), flush=True)
                stored.append({"trace_id": trace["trace_id"], "observations": len(obs), "scores": len(score_data)})
            except RuntimeError as error:
                if "HTTP 404" not in str(error):
                    raise
        if len(stored) == len(payload["traces"]) and all(item["observations"] == wanted["observations"] and item["scores"] == wanted["scores"] for item, wanted in zip(stored, payload["traces"])):
            summary["verified_stored_traces"] = stored
            break
        time.sleep(3)
    else:
        raise RuntimeError("Import accepted but stored trace counts did not reconcile: " + json.dumps(stored))
    summary["project_url"] = env["NEXTAUTH_URL"].rstrip("/").removesuffix("/api/auth") + "/project/" + env["LANGFUSE_INIT_PROJECT_ID"]
    lower = iso(datetime.fromisoformat(evidence["arms"][0]["started_at"]) - timedelta(days=1))
    experiments = api("GET", "/api/public/experiments?fromStartTime=" + quote(lower) + "&limit=100")["data"]
    summary["verified_experiments"] = [e for e in experiments if e["id"] in {stable_id(payload["source_sha256"], t["mode"] + "/experiment") for t in payload["traces"]}]
    if len(summary["verified_experiments"]) != 5:
        raise RuntimeError("Five experiment runs did not reconcile")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.output:
        args.output.with_name("import-receipt.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
