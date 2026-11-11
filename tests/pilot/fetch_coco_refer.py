"""Referring-expression test set from COCO val2017: pictures with exactly TWO instances of one class that are clearly apart horizontally,
so "the <class> on the left / right" has an unambiguous, automatically checkable answer. Run fetch_coco_vlm.py first. Writes coco_vlm/tasks_refer.json."""
import json, os, random
from concurrent.futures import ThreadPoolExecutor
import fetch_coco_vlm as f

CLASSES = {"person": 4, "car": 3, "dog": 2, "horse": 2, "cat": 1, "bus": 1}


def main():
    os.makedirs(f.OUT, exist_ok=True)
    doc = json.loads(f.zip_member(f.ZIP_URL, "annotations/instances_val2017.json"))
    name_of = {c["id"]: c["name"] for c in doc["categories"]}
    imgs = {i["id"]: i for i in doc["images"]}
    by_img = {}
    for a in doc["annotations"]:
        if not a.get("iscrowd"):
            by_img.setdefault(a["image_id"], []).append(a)
    ids = sorted(imgs)
    random.Random(23).shuffle(ids)
    used = {t["file"] for t in json.load(open(os.path.join(f.OUT, "tasks.json")))}
    tasks = []
    for cls, n in CLASSES.items():
        got = 0
        for iid in ids:
            if got >= n:
                break
            im = imgs[iid]
            if im["file_name"] in used:
                continue
            xs = [a for a in by_img.get(iid, []) if name_of[a["category_id"]] == cls]
            if len(xs) != 2:
                continue
            # the OTHER classes do not matter; both instances must be sizable and clearly apart
            area = [a["bbox"][2] * a["bbox"][3] / float(im["width"] * im["height"]) for a in xs]
            cx = [a["bbox"][0] + a["bbox"][2] / 2.0 for a in xs]
            if min(area) < 0.04 or abs(cx[0] - cx[1]) < 0.3 * im["width"]:
                continue
            left, right = (xs[0], xs[1]) if cx[0] < cx[1] else (xs[1], xs[0])
            for side, a in (("left", left), ("right", right)):
                x, y, w, h = a["bbox"]
                tasks.append({"kind": "refer", "side": side, "file": im["file_name"], "w": im["width"], "h": im["height"], "cls": cls, "box_px": [x, y, x + w, y + h]})
            got += 1

    def grab(t):
        path = os.path.join(f.OUT, t["file"])
        if not os.path.exists(path):
            with open(path, "wb") as fh:
                fh.write(f.fetch(f.IMG_URL % t["file"]))
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(grab, tasks))
    json.dump(tasks, open(os.path.join(f.OUT, "tasks_refer.json"), "w"), indent=1)
    print("refer tasks:", len(tasks), "pictures:", len({t["file"] for t in tasks}))


if __name__ == "__main__":
    main()
