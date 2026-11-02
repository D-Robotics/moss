"""Decode a checksum-verified SWE-bench-Live Parquet snapshot without running tasks."""
import datetime
import json
import os
import sys

import pyarrow.parquet as parquet


def encode_extra(value):
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    raise TypeError("Unsupported dataset value")


def main():
    source, evaluator_path, rollout_path = sys.argv[1:]
    os.umask(0o077)
    table = parquet.ParquetFile(source)
    if table.metadata.num_rows != 300:
        raise ValueError("Unexpected Lite row count")
    seen = set()
    with open(evaluator_path, "x", encoding="utf-8", newline="\n") as evaluator:
        with open(rollout_path, "x", encoding="utf-8", newline="\n") as rollout:
            for batch in table.iter_batches(batch_size=8):
                for row in batch.to_pylist():
                    instance_id = row.get("instance_id")
                    statement = row.get("problem_statement")
                    if not isinstance(instance_id, str) or not isinstance(statement, str) or instance_id in seen:
                        raise ValueError("Invalid or duplicate instance")
                    seen.add(instance_id)
                    evaluator.write(json.dumps(row, ensure_ascii=False, default=encode_extra) + "\n")
                    rollout.write(json.dumps({"instance_id": instance_id, "problem_statement": statement}, ensure_ascii=False) + "\n")
    if len(seen) != 300:
        raise ValueError("Unexpected unique instance count")


if __name__ == "__main__":
    main()
