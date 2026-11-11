"""Targeted COCO val2017 test set for 'can a local vision-language model find the object that the user mentions?'.
Reads the annotation file out of the remote zip with HTTP range requests (no 6 GB download) and fetches only the ~50 chosen pictures.
Tasks:  ground  = one clearly visible instance of a class (box known)         -> 'where is the X?'
        pos/neg = presence of 'dog' and 'car' (positives with a visible object, negatives without the class) -> 'is there an X?'
        absent  = grounding question for a class that is NOT in the picture   -> must answer 'none' (hallucination check)
Output: coco_vlm/tasks.json + the pictures (next to this script). COCO images: CC BY 4.0 (see cocodataset.org/#termsofuse)."""
import json, os, random, struct, sys, time, urllib.request, zlib
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "coco_vlm")
ZIP_URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
IMG_URL = "http://images.cocodataset.org/val2017/%s"
GROUND = {"dog": 2, "car": 2, "cat": 2, "person": 2, "bus": 2, "pizza": 2}
PRESENCE = {"dog": 8, "car": 8}
ABSENT_N = 8


def fetch(url, start=None, end=None, tries=5):
    last = None
    for i in range(tries):
        try:
            h = {"User-Agent": "pilot/1.0"}
            if start is not None:
                h["Range"] = "bytes=%d-%d" % (start, end)
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def zip_member(url, wanted):
    head = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60)
    size = int(head.headers["Content-Length"])
    tail = fetch(url, size - 65557, size - 1)
    eocd = tail.rfind(b"PK\x05\x06")
    cd_size, cd_off = struct.unpack("<II", tail[eocd + 12:eocd + 20])
    cd = fetch(url, cd_off, cd_off + cd_size - 1)
    pos = 0
    while pos < len(cd) and cd[pos:pos + 4] == b"PK\x01\x02":
        method, = struct.unpack("<H", cd[pos + 10:pos + 12])
        csize, usize = struct.unpack("<II", cd[pos + 20:pos + 28])
        nlen, elen, clen = struct.unpack("<HHH", cd[pos + 28:pos + 34])
        lho, = struct.unpack("<I", cd[pos + 42:pos + 46])
        name = cd[pos + 46:pos + 46 + nlen].decode("utf-8")
        if name == wanted:
            lh = fetch(url, lho, lho + 29)
            ln, le = struct.unpack("<HH", lh[26:30])
            data = fetch(url, lho + 30 + ln + le, lho + 30 + ln + le + csize - 1)
            return zlib.decompress(data, -15)
        pos += 46 + nlen + elen + clen
    raise KeyError(wanted)


def main():
    os.makedirs(OUT, exist_ok=True)
    doc = json.loads(zip_member(ZIP_URL, "annotations/instances_val2017.json"))
    name_of = {c["id"]: c["name"] for c in doc["categories"]}
    imgs = {i["id"]: i for i in doc["images"]}
    by_img = {}
    for a in doc["annotations"]:
        if a.get("iscrowd"):
            continue
        by_img.setdefault(a["image_id"], []).append(a)
    rng = random.Random(11)
    ids = sorted(imgs)
    rng.shuffle(ids)

    def frac(a, im):
        return a["bbox"][2] * a["bbox"][3] / float(im["width"] * im["height"])

    def inst(iid, cls):
        return [a for a in by_img.get(iid, []) if name_of[a["category_id"]] == cls]

    tasks, used = [], set()

    def add(kind, iid, cls, box=None):
        im = imgs[iid]
        t = {"kind": kind, "file": im["file_name"], "w": im["width"], "h": im["height"], "cls": cls}
        if box:
            x, y, w, h = box
            t["box_px"] = [x, y, x + w, y + h]
        tasks.append(t)
        used.add(iid)

    for cls, n in GROUND.items():
        got = 0
        for iid in ids:
            if iid in used or got >= n:
                continue
            xs = inst(iid, cls)
            if len(xs) == 1 and 0.05 <= frac(xs[0], imgs[iid]) <= 0.5:
                add("ground", iid, cls, xs[0]["bbox"])
                got += 1
    for cls, n in PRESENCE.items():
        pos = neg = 0
        for iid in ids:
            if iid in used:
                continue
            xs = inst(iid, cls)
            if xs and pos < n and max(frac(a, imgs[iid]) for a in xs) >= 0.03:
                add("pos", iid, cls)
                pos += 1
            elif not xs and neg < n and len(by_img.get(iid, [])) >= 2:
                add("neg", iid, cls)
                neg += 1
            if pos >= n and neg >= n:
                break
    got = 0
    for iid in ids:
        if iid in used or got >= ABSENT_N:
            continue
        present = {name_of[a["category_id"]] for a in by_img.get(iid, [])}
        if len(present) >= 2 and "dog" not in present and "cat" not in present:
            add("absent", iid, "dog")
            got += 1

    def grab(t):
        path = os.path.join(OUT, t["file"])
        if not os.path.exists(path):
            with open(path, "wb") as fh:
                fh.write(fetch(IMG_URL % t["file"]))
        return t

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(grab, tasks))
    json.dump(tasks, open(os.path.join(OUT, "tasks.json"), "w"), indent=1)
    kinds = {}
    for t in tasks:
        kinds[t["kind"]] = kinds.get(t["kind"], 0) + 1
    print("tasks:", len(tasks), kinds, "| size on disk: %.1f MB" % (sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) / 1048576))


if __name__ == "__main__":
    sys.exit(main())
