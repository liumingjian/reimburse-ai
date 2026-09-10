#!/usr/bin/env python3
"""JSONL OCR worker. Stdout is reserved exclusively for protocol messages."""

from __future__ import annotations

import contextlib
import gc
import importlib.metadata
import json
import os
import resource
import sys
import tempfile
import time
from typing import Any, Iterable

from PIL import Image, ImageOps


MAX_IMAGE_SIDE = 1600


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message, ensure_ascii=False, separators=(",", ":")), flush=True)


def polygon(value: Any) -> list[list[float]]:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, list):
        return []
    points: list[list[float]] = []
    for point in value:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            points.append([float(point[0]), float(point[1])])
    return points


class PaddleAdapter:
    name = "paddleocr"
    model = "PP-OCRv5-mobile"

    def __init__(self) -> None:
        with contextlib.redirect_stdout(sys.stderr):
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                lang="ch",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
            )
        self.version = importlib.metadata.version("paddleocr")

    def recognize(self, image_path: str) -> list[dict[str, Any]]:
        with contextlib.redirect_stdout(sys.stderr):
            result = self._ocr.predict(input=image_path)
        observations: list[dict[str, Any]] = []
        for page in result:
            payload = getattr(page, "json", page)
            if callable(payload):
                payload = payload()
            if isinstance(payload, dict) and isinstance(payload.get("res"), dict):
                payload = payload["res"]
            if not isinstance(payload, dict):
                continue
            texts = payload.get("rec_texts", [])
            scores = payload.get("rec_scores", [])
            polygons = payload.get("rec_polys", payload.get("dt_polys", []))
            if hasattr(texts, "tolist"):
                texts = texts.tolist()
            if hasattr(scores, "tolist"):
                scores = scores.tolist()
            if hasattr(polygons, "tolist"):
                polygons = polygons.tolist()
            for index, text in enumerate(texts):
                score = scores[index] if index < len(scores) else 0.0
                box = polygons[index] if index < len(polygons) else []
                observations.append({
                    "id": f"o{len(observations) + 1}",
                    "text": str(text),
                    "polygon": polygon(box),
                    "score": float(score),
                })
        return observations


class RapidAdapter:
    name = "rapidocr"

    def __init__(self) -> None:
        with contextlib.redirect_stdout(sys.stderr):
            from rapidocr import ModelType, RapidOCR

            model_name = os.environ.get("BAOX_OCR_MODEL", "small").lower()
            models = {"small": ModelType.SMALL, "medium": ModelType.MEDIUM}
            if model_name not in models:
                raise RuntimeError(f"unsupported RapidOCR model: {model_name}")
            model_type = models[model_name]
            self._ocr = RapidOCR(params={
                "Det.model_type": model_type,
                "Rec.model_type": model_type,
            })
            self.model = f"PP-OCRv6-{model_name}"
        self.version = importlib.metadata.version("rapidocr")

    def recognize(self, image_path: str) -> list[dict[str, Any]]:
        with contextlib.redirect_stdout(sys.stderr):
            output = self._ocr(image_path)
        boxes = getattr(output, "boxes", None)
        texts = getattr(output, "txts", None)
        scores = getattr(output, "scores", None)
        if texts is None and isinstance(output, tuple) and output:
            rows = output[0] or []
            boxes = [row[0] for row in rows]
            texts = [row[1] for row in rows]
            scores = [row[2] for row in rows]
        observations: list[dict[str, Any]] = []
        for index, text in enumerate(texts or []):
            score = scores[index] if scores is not None and index < len(scores) else 0.0
            box = boxes[index] if boxes is not None and index < len(boxes) else []
            observations.append({
                "id": f"o{index + 1}",
                "text": str(text),
                "polygon": polygon(box),
                "score": float(score),
            })
        return observations


def create_adapter() -> PaddleAdapter | RapidAdapter:
    engine = os.environ.get("BAOX_OCR_ENGINE", "rapidocr").lower()
    if engine == "paddleocr":
        return PaddleAdapter()
    if engine == "rapidocr":
        return RapidAdapter()
    raise RuntimeError(f"unsupported OCR engine: {engine}")


def messages() -> Iterable[dict[str, Any]]:
    for raw in sys.stdin:
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise RuntimeError("invalid JSONL request") from error
        if not isinstance(value, dict):
            raise RuntimeError("request message must be an object")
        yield value


def peak_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


@contextlib.contextmanager
def prepared_image(image_path: str):
    with Image.open(image_path) as source:
        image = ImageOps.exif_transpose(source)
        original_width, original_height = image.size
        if max(image.size) <= MAX_IMAGE_SIDE:
            yield image_path, 1.0, 1.0
            return
        image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
        width, height = image.size
        with tempfile.NamedTemporaryFile(suffix=".jpg") as temporary:
            image.convert("RGB").save(temporary.name, format="JPEG", quality=92)
            yield temporary.name, original_width / width, original_height / height


def rescale(observations: list[dict[str, Any]], scale_x: float, scale_y: float) -> None:
    if scale_x == 1.0 and scale_y == 1.0:
        return
    for observation in observations:
        observation["polygon"] = [
            [point[0] * scale_x, point[1] * scale_y]
            for point in observation["polygon"]
        ]


def main() -> int:
    adapter: PaddleAdapter | RapidAdapter | None = None
    for message in messages():
        kind = message.get("type")
        if kind == "init":
            if message.get("contractVersion") != 1:
                raise RuntimeError("unsupported worker contract version")
            adapter = create_adapter()
            emit({
                "type": "ready",
                "engine": adapter.name,
                "version": adapter.version,
                "model": adapter.model,
            })
        elif kind == "image":
            if adapter is None:
                raise RuntimeError("worker is not initialized")
            material_id = message.get("materialId")
            image_path = message.get("absPath")
            started_at = time.perf_counter()
            try:
                with prepared_image(str(image_path)) as (prepared_path, scale_x, scale_y):
                    observations = adapter.recognize(prepared_path)
                rescale(observations, scale_x, scale_y)
                emit({
                    "type": "result",
                    "materialId": material_id,
                    "observations": observations,
                    "durationMs": (time.perf_counter() - started_at) * 1000,
                })
                del observations
                gc.collect()
            except Exception as error:  # One bad image must not abort the batch.
                print(f"OCR failed for {material_id}: {error}", file=sys.stderr)
                emit({
                    "type": "result",
                    "materialId": material_id,
                    "observations": [],
                    "durationMs": (time.perf_counter() - started_at) * 1000,
                    "error": type(error).__name__,
                })
        elif kind == "shutdown":
            emit({"type": "metrics", "peakRssBytes": peak_rss_bytes()})
            return 0
        else:
            raise RuntimeError(f"unsupported message type: {kind}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
