#!/usr/bin/env python3
import json
import os
import sys


def observation(observation_id, text, y, x=10, width=490):
    return {
        "id": observation_id,
        "text": text,
        "polygon": [[x, y], [x + width, y], [x + width, y + 24], [x, y + 24]],
        "score": 0.99,
    }


def captured_observations(file_name):
    with open(os.path.join(os.path.dirname(__file__), "real-ocr-observations.json"), encoding="utf-8") as handle:
        return json.load(handle)[file_name]


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
        elif material_id.startswith("fengyun-real"):
            rows = [
                observation("o1", "电子发", 69, 588, 166),
                observation("o2", "发票）", 68, 958, 144),
                observation("o3", "发票号码：26427000000640558021", 96, 1242, 360),
                observation("o4", "旅客运输服务", 119, 288, 150),
                observation("o5", "开票日期：2026年09月04日", 141, 1241, 289),
                observation("o6", "价税合计（大写）", 1023, 199, 185),
                observation("o7", "壹拾捌圆捌角整", 1016, 545, 178),
                observation("o8", "(小写)¥18.80", 1019, 1179, 162),
                observation("o9", "金额：18.25", 440, 1100, 73),
                observation("o10", "税额：0.55", 439, 1565, 63),
            ]
        elif material_id.startswith("fengyun-captured"):
            rows = captured_observations("fengyun-1.png")
        elif material_id.startswith("ride-multiple"):
            rows = [
                observation("o1", "高德地图—打车——", 32, 425, 574),
                observation("o2", "行程单", 35, 965, 198),
                observation("o3", "共计2单行程，合计41.00元", 262, 584, 275),
                observation("o4", "上车时间", 354, 567, 102),
                observation("o5", "城市", 355, 834, 58),
                observation("o6", "起点", 354, 1005, 61),
                observation("o7", "终点", 354, 1211, 60),
                observation("o8", "金额", 355, 1384, 59),
                observation("o9", "2026-08-22 17:28", 455, 528, 178),
                observation("o10", "广州市", 452, 829, 69),
                observation("o11", "番禺广场地铁站D口", 454, 948, 173),
                observation("o12", "傍西酒堂", 452, 1198, 86),
                observation("o13", "18.80元", 453, 1374, 80),
                observation("o14", "2026-08-23 09:15", 505, 528, 178),
                observation("o15", "广州市", 502, 829, 69),
                observation("o16", "广州南站", 504, 948, 120),
                observation("o17", "白云机场", 502, 1198, 100),
                observation("o18", "22.20元", 503, 1374, 80),
            ]
        elif material_id.startswith("ride-real"):
            rows = [
                observation("o1", "高德地图—打车——", 32, 425, 574),
                observation("o2", "行程单", 35, 965, 198),
                observation("o3", "行程时间：2026-08-2217:28至2026-08-2217:41", 228, 587, 510),
                observation("o4", "共计1单行程，合计18.80元", 262, 584, 275),
                observation("o5", "上车时间", 354, 567, 102),
                observation("o6", "城市", 355, 834, 58),
                observation("o7", "起点", 354, 1005, 61),
                observation("o8", "终点", 354, 1211, 60),
                observation("o9", "金额", 355, 1384, 59),
                observation("o10", "2026-08-22 17:28", 455, 528, 178),
                observation("o11", "广州市", 452, 829, 69),
                observation("o12", "番禺广场地铁站D口", 454, 948, 173),
                observation("o13", "傍西酒堂", 452, 1198, 86),
                observation("o14", "18.80元", 453, 1374, 80),
            ]
        elif material_id.startswith("ride-captured"):
            rows = captured_observations("行程单.png")
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
