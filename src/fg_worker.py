"""Optional FG algorithms. Inputs are grouped counts or selected Parquet columns."""
import json
import math
import os
import string
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, localcontext
from functools import lru_cache
from itertools import combinations
from urllib.parse import urlsplit

import numpy as np
import pandas as pd
import pyarrow.parquet as pq


def encode(value):
    if value is None or value is pd.NaT or value is pd.NA:
        return {"type": "null", "value": None}
    if isinstance(value, (bool, np.bool_)):
        return {"type": "boolean", "value": bool(value)}
    if isinstance(value, (int, np.integer)):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, Decimal):
        return {"type": "decimal", "value": str(value)}
    if isinstance(value, (float, np.floating)):
        return {"type": "number", "value": float(value) if math.isfinite(value) else "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"}
    if isinstance(value, (pd.Timedelta, timedelta, np.timedelta64)):
        return {"type": "duration", "value": {"amount": str(pd.Timedelta(value).value), "unit": "nanosecond"}}
    if isinstance(value, (pd.Timestamp, datetime, np.datetime64)):
        value = pd.Timestamp(value)
        return {"type": "timestamptz" if value.tzinfo else "timestamp", "value": value.tz_convert("UTC").isoformat().replace("+00:00", "Z") if value.tzinfo else value.isoformat()}
    if isinstance(value, date):
        return {"type": "date", "value": value.isoformat()}
    if isinstance(value, dict):
        return {"type": "object", "value": {str(key): encode(item) for key, item in value.items()}}
    if isinstance(value, (list, tuple, np.ndarray)):
        return {"type": "list", "value": [encode(item) for item in value]}
    return {"type": "string", "value": str(value)}


def entries(counts, by_value=False):
    try:
        ordered = sorted(counts.items(), key=(lambda item: item[0]) if by_value else lambda item: (-item[1], item[0]))
    except TypeError:
        ordered = sorted(counts.items(), key=lambda item: str(item[0]) if by_value else (-item[1], str(item[0])))
    return [{"value": value, "count": int(count)} for value, count in ordered]


def quantile(values, weights, points):
    if not len(values):
        return [None for _ in points]
    order = np.argsort(values)
    values, weights = np.asarray(values)[order], np.asarray(weights)[order]
    cumulative = np.cumsum(weights)
    size = int(cumulative[-1])
    result = []
    for point in points:
        position = (size - 1) * point
        low, high = math.floor(position), math.ceil(position)
        a, b = values[np.searchsorted(cumulative, low, side="right")], values[np.searchsorted(cumulative, high, side="right")]
        fraction = position - low
        if isinstance(a, Decimal) or isinstance(a, (int, np.integer)) and max(abs(int(a)), abs(int(b))) > 2**53:
            if not isinstance(a, Decimal) and fraction == 0:
                result.append(int(a))
            else:
                a, b = Decimal(a) if isinstance(a, Decimal) else Decimal(int(a)), Decimal(b) if isinstance(b, Decimal) else Decimal(int(b))
                with localcontext() as context:
                    context.prec = max(len(str(a)), len(str(b))) + 32
                    result.append(a + (b - a) * Decimal(str(fraction)))
        else:
            result.append(float(a) if low == high or a == b else float(a) + (float(b) - float(a)) * fraction)
    return result


def histogram(values, weights, options, auto=False):
    values, weights = np.asarray(values, dtype=float), np.asarray(weights, dtype=np.int64)
    finite = np.isfinite(values)
    values, weights = values[finite], weights[finite]
    if not len(values):
        return {"counts": [], "edges": []}
    low, high = float(values.min()), float(values.max())
    if low == high:
        epsilon = 0.5 if low == 0 else abs(low) * 0.1
        edges = np.array([low - epsilon, high + epsilon])
    else:
        maximum = options.get("maxBins", 250)
        requested = options.get("bins", 50)
        if auto or requested == 0:
            count = int(weights.sum())
            q1, q3 = quantile(values, weights, [0.25, 0.75])
            fd = 2 * (q3 - q1) / count ** (1 / 3)
            sturges = (high - low) / (math.log2(count) + 1)
            width = min(fd, sturges) if fd > 0 else sturges
            bins = max(1, math.ceil((high - low) / width))
            if not auto:
                bins = min(bins, maximum)
        else:
            bins = max(1, min(requested, len(values), maximum))
        edges = np.linspace(low, high, bins + 1)
    counts, edges = np.histogram(values, bins=edges, weights=weights, density=options.get("density", False) and not auto)
    return {"counts": counts.tolist(), "edges": edges.tolist()}


def text_stats(counts, wanted, options):
    result = {}
    lengths = Counter()
    if wanted & {"length_counts", "length_histogram"}:
        for value, count in counts.items():
            lengths[len(str(value))] += count
    if "length_counts" in wanted:
        result["length_counts"] = entries(lengths, True)
    if "length_histogram" in wanted:
        result["length_histogram"] = histogram(list(lengths), list(lengths.values()), options)
    if "word_counts" in wanted:
        words = Counter()
        stop = {word.lower() for word in options.get("stopWords", [])}
        for value, count in counts.items():
            for word in str(value).lower().split():
                word = word.strip(string.punctuation + string.whitespace)
                if word not in stop:
                    words[word] += count
        result["word_counts"] = entries(words)
    char_metrics = {name for name in wanted if "character" in name or name.startswith("unicode_")}
    if char_metrics:
        characters = Counter()
        for value, count in counts.items():
            for character, frequency in Counter(str(value)).items():
                characters[character] += frequency * count
        result.update(character_count=sum(characters.values()), distinct_character_count=len(characters), character_counts=entries(characters))
        if any(name.startswith("unicode_") for name in wanted):
            from tangled_up_in_unicode import block, block_abbr, category, category_long, script
            for name, classifier in [("category", lambda char: category_long(category(char)).replace("_", " ")), ("block", lambda char: block_abbr(block(char))), ("script", script)]:
                if not any(metric.startswith(f"unicode_{name}_") for metric in wanted):
                    continue
                frequencies, members = Counter(), defaultdict(Counter)
                for char, count in characters.items():
                    label = classifier(char)
                    frequencies[label] += count
                    members[label][char] = count
                result[f"unicode_{name}_distinct_count"] = len(frequencies)
                result[f"unicode_{name}_frequencies"] = entries(frequencies)
                result[f"unicode_{name}_character_counts"] = {key: entries(value) for key, value in members.items()}
    return result


def path_stats(counts):
    result = {"path_common_prefix": os.path.commonprefix(list(counts)) or "No common prefix"}
    parts = {"stem": lambda path: os.path.splitext(path)[0], "suffix": lambda path: os.path.splitext(path)[1], "basename": os.path.basename, "parent": os.path.dirname, "drive": os.path.splitdrive}
    for name, function in parts.items():
        values = Counter()
        for value, count in counts.items():
            part = function(value)
            values[part[0] if name == "drive" else part] += count
        result[f"path_{name}_counts"] = entries(values)
        result[f"path_{name}_distinct_count"] = len(values)
    return result


@lru_cache(maxsize=None)
def file_stat(path):
    return os.stat(path)


def file_stats(counts, options, wanted):
    sizes, dates = Counter(), {name: Counter() for name in ["modified", "access", "metadata_change"] if f"file_{name}_time_counts" in wanted}
    per_file = []
    for path, count in sorted(counts.items()):
        stat = file_stat(path)
        sizes[stat.st_size] += count
        per_file.append({"path": path, "bytes": stat.st_size, "count": count})
        for name, timestamp in [("modified", stat.st_mtime), ("access", stat.st_atime), ("metadata_change", stat.st_ctime)]:
            if name in dates:
                dates[name][datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")] += count
    return {"file_size_bytes": per_file, **({"file_size_histogram": histogram(list(sizes), list(sizes.values()), options)} if "file_size_histogram" in wanted else {}), **{f"file_{name}_time_counts": entries(value) for name, value in dates.items()}}


@lru_cache(maxsize=None)
def image_info(path, exif, hash_image):
    from PIL import ExifTags, Image, UnidentifiedImageError
    try:
        with Image.open(path) as image:
            try:
                image.load()
            except (OSError, ValueError):
                return {"truncated": True}
            result = {"size": image.size, "truncated": False}
            if exif:
                result["exif"] = {ExifTags.TAGS.get(key, str(key)): value.decode(errors="replace") if isinstance(value, bytes) else str(value) for key, value in image.getexif().items()}
            if hash_image:
                import imagehash
                result["hash"] = str(imagehash.phash(image))
            return result
    except (OSError, ValueError, UnidentifiedImageError):
        return {}


def image_stats(counts, wanted):
    dimensions, hashes, tags, exif_values = Counter(), Counter(), Counter(), defaultdict(Counter)
    truncated = 0
    for path, count in counts.items():
        info = image_info(path, any(name.startswith("exif_") for name in wanted), "duplicate_image_hash_count" in wanted)
        truncated += count if info.get("truncated", False) else 0
        if "size" in info:
            dimensions[info["size"]] += count
        if info.get("hash"):
            hashes[info["hash"]] += count
        for key, value in info.get("exif", {}).items():
            tags[key] += count
            exif_values[key][value] += count
    result = {"truncated_image_count": truncated, "image_dimension_counts": entries(dimensions), "duplicate_image_hash_count": sum(hashes.values()) - len(hashes), "exif_tag_counts": entries(tags), "exif_value_counts": {key: entries(value) for key, value in exif_values.items()}}
    for name, position in [("width", 0), ("height", 1), ("area", None)]:
        values = [width * height if position is None else (width, height)[position] for width, height in dimensions]
        weights = list(dimensions.values())
        result.update({f"min_image_{name}": min(values) if values else None, f"max_image_{name}": max(values) if values else None, f"mean_image_{name}": float(np.average(values, weights=weights)) if values else None, f"median_image_{name}": quantile(values, weights, [0.5])[0]})
    return result


def grouped(task, options):
    data = pq.read_table(task["path"]).to_pydict()
    if task["column"]["type"].upper() in {"HUGEINT", "UHUGEINT", "BIGNUM"}:
        data["value"] = [int(value) if value is not None else None for value in data["value"]]
    total = sum(data["count"])
    counts = {value: count for value, count in zip(data["value"], data["count"]) if value is not None}
    wanted, kind = set(task["metrics"]), task["role"]
    present, distinct = sum(counts.values()), len(counts)
    frequencies = np.asarray(list(counts.values()), dtype=np.int64)
    stats = {}
    if kind in {"numeric", "timeseries"}:
        if "quantiles" in wanted:
            points = options.get("quantiles", [0.05, 0.25, 0.5, 0.75, 0.95])
            stats["quantiles"] = dict(zip(map(str, points), quantile(list(counts), frequencies, points)))
    if kind in {"categorical", "text", "url", "path", "file", "image"}:
        stats.update(text_stats(counts, wanted, options))
    if kind == "date":
        valid, invalid = Counter(), Counter()
        for value, count in counts.items():
            parsed = pd.to_datetime(value, errors="coerce", utc=True)
            if pd.isna(parsed):
                invalid[value] += count
            else:
                valid[parsed] += count
        stats.update(invalid_date_distinct_count=len(invalid), invalid_date_count=sum(invalid.values()), invalid_date_rate=sum(invalid.values()) / total if total else 0)
        earliest, latest = (min(valid), max(valid)) if valid else (None, None)
        stats.update(min=earliest, max=latest, min_timestamp=earliest, max_timestamp=latest, time_span=latest-earliest if valid else None)
        timestamps = [value.timestamp() for value in valid]
        date_hist = histogram(timestamps, list(valid.values()), options)
        date_hist["edges"] = [datetime.fromtimestamp(value, timezone.utc) for value in date_hist["edges"]]
        stats["datetime_histogram"] = date_hist
    if "chi_squared_statistic" in wanted or "chi_squared_p_value" in wanted:
        from scipy.stats import chisquare
        if kind == "date":
            bins = histogram(timestamps, list(valid.values()), options, auto=True)["counts"]
        else:
            bins = frequencies
        statistic, probability = chisquare(bins) if len(bins) and sum(bins) else (0, 0)
        stats.update(chi_squared_statistic=statistic, chi_squared_p_value=probability)
    if kind == "url":
        parts = ["scheme", "netloc", "path", "query", "fragment"]
        components = {part: Counter() for part in parts}
        for value, count in counts.items():
            parsed = urlsplit(value)
            for part in parts:
                components[part][getattr(parsed, part)] += count
        stats.update({f"url_{part}_counts": entries(value) for part, value in components.items()})
    if kind in {"path", "file", "image"} and any(name.startswith("path_") for name in wanted):
        stats.update(path_stats(counts))
    if kind in {"file", "image"} and any(name.startswith("file_") for name in wanted):
        stats.update(file_stats(counts, options, wanted))
    if kind == "image" and any("image" in name or name.startswith("exif_") for name in wanted):
        stats.update(image_stats(counts, wanted))
    return {name: value for name, value in stats.items() if name in wanted}


def cramers(a, b):
    from scipy.stats import chi2_contingency
    table = pd.crosstab(a, b)
    if table.empty:
        return None
    size, rows, cols = table.values.sum(), *table.shape
    if size <= 1:
        return None
    phi = chi2_contingency(table, correction=True)[0] / size
    corrected = max(0, phi - (cols - 1) * (rows - 1) / (size - 1))
    denominator = min(cols - 1 - (cols - 1) ** 2 / (size - 1), rows - 1 - (rows - 1) ** 2 / (size - 1))
    return math.sqrt(corrected / denominator) if denominator else 1.0


def correlations(frame, roles, wanted):
    numeric = [name for name in frame if roles[name] in {"numeric", "timeseries"}]
    categorical = [name for name in frame if roles[name] in {"categorical", "boolean"} and 1 < frame[name].nunique() <= 100]
    frame = frame.copy()
    for name in numeric:
        frame[name] = frame[name].astype(float)
    result = []
    for metric, method in [("spearman_rho", "spearman"), ("kendall_tau", "kendall")]:
        if metric in wanted:
            matrix = frame[numeric].corr(method=method)
            result.extend((metric, [a, b], matrix.loc[a, b]) for a, b in combinations(numeric, 2))
    if "cramers_v" in wanted:
        result.extend(("cramers_v", [a, b], cramers(frame[a], frame[b])) for a, b in combinations(categorical, 2))
    if "auto_correlation" in wanted:
        usable = [name for name in numeric + categorical if frame[name].nunique() > 1]
        discretized = {name: pd.cut(frame[name], bins=10, labels=False, duplicates="drop") for name in numeric if frame[name].nunique() > 1}
        for a, b in combinations(usable, 2):
            result.append(("auto_correlation", [a, b], frame[a].corr(frame[b], method="spearman") if a in numeric and b in numeric else cramers(discretized.get(a, frame[a]), discretized.get(b, frame[b]))))
    if "phi_k" in wanted:
        from phik import phik_matrix
        usable = [name for name in frame if roles[name] != "unknown" and (name in numeric and frame[name].nunique() > 1 or 1 < frame[name].nunique() <= 100)]
        if len(usable) > 1:
            matrix = phik_matrix(frame[usable], interval_cols=[name for name in usable if name in numeric], njobs=1, verbose=False)
            result.extend(("phi_k", [a, b], matrix.loc[a, b]) for a, b in combinations(usable, 2))
    return result


def seasonality(values):
    from scipy.fft import fft, fftfreq
    from scipy.signal import find_peaks
    if len(values) < 3:
        return []
    power = np.abs(fft(values)) ** 2
    frequencies = fftfreq(len(values))
    positive = frequencies > 0
    frequencies = frequencies[positive]
    amplitudes = 10 * np.log10(power[positive])
    high = amplitudes[amplitudes > 0]
    median = np.median(high) if len(high) else np.nan
    above = high[high > median]
    threshold = median + (np.abs(above - above.mean()).mean() if len(above) else np.nan) * 6
    peaks = find_peaks(amplitudes, threshold=0.1)[0]
    selected = []
    for index in peaks:
        if amplitudes[index] > threshold and not any((frequencies[index] / frequency) % 1 < 0.01 or (frequencies[index] / frequency) % 1 > 0.99 for frequency in selected):
            selected.append(frequencies[index])
    return [1 / frequency for frequency in selected]


def ordered_stats(frame, roles, request):
    options, wanted = request["options"], set(request["time"] + request["ordered"])
    index_name = options.get("timeIndex")
    index = frame[index_name] if index_name else pd.Series(np.arange(len(frame)))
    if roles.get(index_name) == "date":
        index = pd.to_datetime(index)
    if index.isna().any():
        raise ValueError("timeIndex must not contain missing values")
    usable = [name for name in frame if name != index_name and roles[name] in {"numeric", "timeseries"}]
    step = index.diff().dropna().abs()
    table = {"time_series_count": sum(roles[name] == "timeseries" for name in usable) or len(usable), "time_index_observation_count": len(frame), "time_index_start": index.min() if len(index) else None, "time_index_end": index.max() if len(index) else None, "mean_time_index_step": step.mean() if len(step) else None}
    result = [(metric, [], value) for metric, value in table.items() if metric in wanted]
    for name in usable:
        series = frame[name]
        present = series.dropna()
        values = present.to_numpy(dtype=float)
        stats = {"is_nondecreasing": present.is_monotonic_increasing, "is_nonincreasing": present.is_monotonic_decreasing, "is_strictly_increasing": present.is_monotonic_increasing and present.is_unique, "is_strictly_decreasing": present.is_monotonic_decreasing and present.is_unique}
        explicit_series = any(role == "timeseries" for role in roles.values())
        if request["time"] and (not explicit_series or roles[name] == "timeseries"):
            times = index[series.notna()]
            differences = times.diff()
            positive = differences[differences > (pd.Timedelta(0) if pd.api.types.is_datetime64_any_dtype(times) else 0)]
            threshold = positive.mean() * 2
            mask = differences > threshold
            gaps = differences[mask]
            positions = np.flatnonzero(mask)
            endpoints = [[times.iloc[position - 1], times.iloc[position]] for position in positions]
            zero = pd.Timedelta(0) if pd.api.types.is_datetime64_any_dtype(times) else 0
            stats.update(gap_count=len(gaps), gap_endpoints=endpoints, min_gap=gaps.min() if len(gaps) else zero, max_gap=gaps.max() if len(gaps) else zero, mean_gap=gaps.mean() if len(gaps) else zero, stddev_gap_samp=gaps.std() if len(gaps) > 1 else zero)
            if wanted & {"is_seasonal", "seasonal_periods", "is_stationary"}:
                periods = seasonality(values)
                stats.update(is_seasonal=bool(periods), seasonal_periods=periods)
            if wanted & {"adf_p_value", "is_stationary"}:
                from statsmodels.tsa.stattools import adfuller
                try:
                    probability = adfuller(values, autolag=options.get("autolag", "AIC"), maxlag=options.get("maxlag"))[1]
                except ValueError:
                    probability = None
                stats.update(adf_p_value=probability, is_stationary=probability < options.get("significance", 0.05) and not stats.get("is_seasonal", False) if probability is not None else None)
            if wanted & {"acf", "pacf"}:
                from statsmodels.tsa.stattools import acf, pacf
                for metric, function in [("acf", acf), ("pacf", pacf)]:
                    if metric not in wanted:
                        continue
                    lag = min(options.get("lags", 100), max(0, len(values) // 2 - 1))
                    try:
                        coefficients, intervals = function(values, nlags=lag, alpha=options.get("significance", 0.05), **({"fft": True} if metric == "acf" else {"method": "ywm"}))
                        stats[metric] = [{"lag": index, "coefficient": coefficient, "confidence_interval": interval} for index, (coefficient, interval) in enumerate(zip(coefficients, intervals))]
                    except (ValueError, np.linalg.LinAlgError):
                        stats[metric] = None
        result.extend((metric, [name], value) for metric, value in stats.items() if metric in wanted)
    return result


def main(request):
    file_stat.cache_clear()
    image_info.cache_clear()
    results = []

    def emit(metric, columns, value):
        options = request["options"]
        parameters = {}
        if metric == "quantiles":
            parameters = {"quantiles": options.get("quantiles", [0.05, 0.25, 0.5, 0.75, 0.95])}
        elif metric.endswith("histogram"):
            parameters = {"bins": options.get("bins", 50), "maxBins": options.get("maxBins", 250), "density": options.get("density", False)}
        elif metric == "word_counts":
            parameters = {"stopWords": options.get("stopWords", [])}
        elif metric in request["time"] or metric in request["ordered"]:
            parameters = {key: options[key] for key in ["timeIndex", "orderBy", "lags", "significance", "autolag", "maxlag"] if key in options}
        elif metric in request["memory"]:
            parameters = {"memoryDeep": options.get("memoryDeep", False), "backend": "pandas"}
        results.append({"protocol_version": 1, "table_name": request["table"], "columns": columns, "metric": metric, "parameters": parameters, "value": encode(value)})

    for task in request["tasks"]:
        for metric, value in grouped(task, request["options"]).items():
            emit(metric, [task["column"]["name"]], value)
    if request["chiTests"]:
        from scipy.stats import chi2
        for test in request["chiTests"]:
            emit("chi_squared_p_value", [test["column"]], chi2.sf(test["statistic"], test["dof"]))
    if request.get("raw"):
        frame = pq.read_table(request["raw"]).to_pandas()
        for column in request["columns"]:
            if column["name"] in frame and column["type"].upper() in {"HUGEINT", "UHUGEINT", "BIGNUM"}:
                frame[column["name"]] = frame[column["name"]].map(lambda value: int(value) if value is not None else None)
        if request["pair"]:
            for metric, columns, value in correlations(frame, request["roles"], request["pair"]):
                emit(metric, columns, value)
        if request["memory"]:
            sizes = frame.memory_usage(deep=request["options"].get("memoryDeep", False))
            if "table_memory_bytes" in request["memory"]:
                emit("table_memory_bytes", [], sizes.sum())
            if "mean_row_memory_bytes" in request["memory"]:
                emit("mean_row_memory_bytes", [], float(sizes.sum()) / len(frame) if len(frame) else 0)
            if "column_memory_bytes" in request["memory"]:
                for name in frame:
                    emit("column_memory_bytes", [name], frame[name].memory_usage(deep=request["options"].get("memoryDeep", False)))
        if request["ordered"] or request["time"]:
            for metric, columns, value in ordered_stats(frame, request["roles"], request):
                emit(metric, columns, value)
    return results


if __name__ == "__main__":
    import contextlib
    import traceback
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for line in sys.stdin:
            message = json.loads(line)
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    results = main(message["request"])
                response = {"id": message["id"], "results": results}
            except Exception:
                response = {"id": message["id"], "error": traceback.format_exc()}
            print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)
