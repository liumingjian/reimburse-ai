#!/usr/bin/env python3
import json
import sys


def observation(observation_id, text, y):
    return {
        "id": observation_id,
        "text": text,
        "polygon": [[10, y], [500, y], [500, y + 24], [10, y + 24]],
        "score": 0.99,
    }


for line in sys.stdin:
    message = json.loads(line)
    if message["type"] == "init":
        print(json.dumps({
            "type": "ready",
            "engine": "fake",
            "version": "1",
            "model": "fixture-v1",
        }), flush=True)
        continue

    if message["type"] == "shutdown":
        print(json.dumps({"type": "metrics", "peakRssBytes": 123456}), flush=True)
        break

    if message["type"] == "image":
        material_id = message["materialId"]
        if material_id.startswith("rail"):
            rows = [
                observation("o1", "铁路电子客票", 10),
                observation("o2", "乘车人: 李明", 50),
                observation("o3", "乘车日期: 2026年09月08日 开车时间: 08:35", 90),
                observation("o4", "上海虹桥站 → 杭州东站", 130),
                observation("o5", "G1234 二等座", 170),
                observation("o6", "票价: ¥73.00", 210),
            ]
        elif material_id.startswith("unknown"):
            rows = [observation("o1", "模糊内容", 10)]
        else:
            rows = [
            observation("o1", "增值税电子普通发票", 10),
            observation("o2", "发票号码: 25317000000123456789", 50),
            observation("o3", "开票日期: 2026年09月04日", 90),
            observation("o4", "金额: 18.25", 130),
            observation("o5", "税额: 0.55", 170),
            observation("o6", "价税合计(小写): " + ("19.80" if material_id.startswith("unbalanced") else "18.80"), 210),
            ]
        print(json.dumps({
            "type": "result",
            "materialId": material_id,
            "observations": rows,
            "durationMs": 12,
        }, ensure_ascii=False), flush=True)
