import json
from importlib.metadata import version
from pathlib import Path

import pandas as pd
from data_profiling import ProfileReport


directory = Path(__file__).parent / "fixtures"
fixture = json.loads((directory / "input.json").read_text(encoding="utf-8"))
frame = pd.DataFrame(fixture["rows"], columns=list(fixture["columns"]))
description = ProfileReport(frame, minimal=True, progress_bar=False).get_description()
reference = {
    "package": "fg-data-profiling",
    "version": version("fg-data-profiling"),
    "pandas": version("pandas"),
    "numpy": version("numpy"),
    "options": {"minimal": True},
}
values = {
    "table": {"row_count": description.table["n"], "column_count": description.table["n_var"]},
    "missingness": {name: description.variables[name]["n_missing"] for name in frame.columns},
}
mappings = {
    "table": {"row_count": "table.n", "column_count": "table.n_var"},
    "missingness": {"missing_count": "variables.<column>.n_missing"},
}
for category, metrics in values.items():
    result = {
        "reference": reference,
        "mapping": mappings[category],
        "expected": {name: {"type": "integer", "value": str(value)} for name, value in metrics.items()},
    }
    (directory / f"{category}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Generated {category}.json using fg-data-profiling {reference['version']}")
