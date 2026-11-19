import json
from importlib.metadata import version
from pathlib import Path

import pandas as pd
from data_profiling import ProfileReport


path = Path(__file__).parent / "fixtures" / "core.json"
fixture = json.loads(path.read_text(encoding="utf-8"))
frame = pd.DataFrame(fixture["rows"], columns=list(fixture["columns"]))
description = ProfileReport(frame, minimal=True, progress_bar=False).get_description()
fixture["reference"] = {
    "package": "fg-data-profiling",
    "version": version("fg-data-profiling"),
    "pandas": version("pandas"),
    "numpy": version("numpy"),
    "options": {"minimal": True},
    "mapping": {"row_count": "table.n", "column_count": "table.n_var", "missing_count": "variables.<column>.n_missing"},
}
fixture["expected"] = [
    {"column_name": None, "metric": "row_count", "value": str(description.table["n"])},
    {"column_name": None, "metric": "column_count", "value": str(description.table["n_var"])},
] + [
    {"column_name": name, "metric": "missing_count", "value": str(description.variables[name]["n_missing"])}
    for name in frame.columns
]
assert len(fixture["expected"]) == 2 + len(frame.columns)
path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(fixture["reference"], indent=2))
