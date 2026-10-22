#!/usr/bin/env python3
"""Read-only checks of imported Experiment 1-1 data; makes only HTTP GETs."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

from import_evidence import build_import, read_env


def decoded(value):
    try:
        return json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError:
        return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://ai-tutor-helper.corp.youdao.com/langfuse")
    parser.add_argument("--env-file", type=Path, default=Path(__file__).resolve().parent / ".env")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    release = root / "releases/2026-10-22"
    raw = (release / "evidence.json").read_bytes()
    evidence = build_import(json.loads(raw), hashlib.sha256(raw).hexdigest())
    receipt = json.loads((release / "import-receipt.json").read_text())
    assert hashlib.sha256(raw).hexdigest() == receipt["source_sha256"], "Saved evidence checksum differs"
    env = read_env(args.env_file)
    credentials = env["LANGFUSE_INIT_PROJECT_PUBLIC_KEY"] + ":" + env["LANGFUSE_INIT_PROJECT_SECRET_KEY"]
    authorization = "Basic " + base64.b64encode(credentials.encode()).decode()
    opener = build_opener(ProxyHandler({}))

    def get(path):
        request = Request(args.base_url.rstrip("/") + path, method="GET", headers={"Authorization": authorization})
        with opener.open(request, timeout=30) as response:
            return json.load(response)

    records = []
    summary = {"traces": [], "observations": 0, "scores": 0, "generations": 0, "tokens": 0, "reasoning": {}}
    for trace in evidence["traces"]:
        trace_id = trace["trace_id"]
        observations = get("/api/public/v2/observations?limit=100&fields=core,basic,io,usage&traceId=" + trace_id)["data"]
        scores = get("/api/public/v3/scores?limit=100&traceId=" + trace_id)["data"]
        expected = {event["body"]["id"]: event["body"] for event in evidence["events"] if event["type"] in {"agent-create", "generation-create", "tool-create"} and event["body"]["traceId"] == trace_id}
        assert len(observations) == trace["observations"], trace["mode"] + ": observation count"
        assert {item["id"] for item in observations} == set(expected), trace["mode"] + ": observation IDs"
        assert len(scores) == trace["scores"], trace["mode"] + ": score count"
        expected_scores = {event["body"]["id"] for event in evidence["events"] if event["type"] == "score-create" and event["body"]["traceId"] == trace_id}
        assert {item["id"] for item in scores} == expected_scores, trace["mode"] + ": score IDs"
        generations = sorted((item for item in observations if item["type"] == "GENERATION"), key=lambda item: item["name"])
        assert len(generations) == trace["generations"], trace["mode"] + ": generation count"
        for item in observations:
            body = expected[item["id"]]
            for field in ("input", "output"):
                assert decoded(item[field]) == body[field], trace["mode"] + ": " + field + " differs"
            assert item["parentObservationId"] == body.get("parentObservationId"), trace["mode"] + ": parent differs"
            if item["type"] == "GENERATION":
                assert item["totalUsage"] == body["usage"]["input"] + body["usage"]["output"], trace["mode"] + ": usage differs"
            records.append({"kind": "observation", **{field: decoded(item[field]) for field in ("id", "traceId", "parentObservationId", "type", "input", "output", "totalUsage")}})
        for item in scores:
            records.append({"kind": "score", **{field: item.get(field) for field in ("id", "traceId", "observationId", "name", "value", "stringValue", "dataType")}})
        tokens = sum(item["totalUsage"] for item in generations)
        summary["traces"].append({"mode": trace["mode"], "observations": len(observations), "scores": len(scores), "generations": len(generations), "tokens": tokens})
        for key, value in (("observations", len(observations)), ("scores", len(scores)), ("generations", len(generations)), ("tokens", tokens)):
            summary[key] += value
        if trace["mode"] in {"full", "no_reasoning"}:
            summary["reasoning"][trace["mode"]] = {
                "output_lengths": [len(decoded(item["output"]).get("reasoning_content") or "") for item in generations],
                "history_lengths": [[len(message.get("reasoning_content") or "") for message in decoded(item["input"]) if message.get("role") == "assistant"] for item in generations],
            }
    experiments = get("/api/public/experiments?fromStartTime=2026-10-20T00%3A00%3A00.000Z&limit=100")["data"]
    expected_experiment_ids = {item["id"] for item in receipt["verified_experiments"]}
    actual_experiment_ids = {item["id"] for item in experiments if item.get("datasetId") == receipt["dataset_id"]}
    assert actual_experiment_ids == expected_experiment_ids, "experiment IDs differ"
    assert (summary["observations"], summary["scores"], summary["generations"], summary["tokens"]) == (51, 25, 17, 23302)
    summary["experiments"] = len(actual_experiment_ids)
    summary["source_sha256"] = evidence["source_sha256"]
    canonical = json.dumps(sorted(records, key=lambda item: (item["kind"], item["id"])), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    summary["stored_content_sha256"] = hashlib.sha256(canonical.encode()).hexdigest()
    summary["all_recorded_io_parents_and_usage_match"] = True
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
