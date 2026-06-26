#!/usr/bin/env python3
"""Export the Complex Multi-Trigger artifact tree into a JSON snapshot in the
shapes the tom.quest /boolback page consumes (TreeNode tree + ExperimentRow[]).

Stdlib only. Run on turing where the artifact tree lives:
    python3 boolback_export.py <artifacts_dir> <out.json>
Env:
    SAMPLE_A4=N   keep only the first N arity-4 functions (0 = all)

Outcomes are derived from each scoring node's score.json using the validated
activation convention: a presence row activates iff
    truth_table[ sum(presence[k] * 2**k) ] == '1'
ASR  = mean target_rate over activating rows; FTR = mean over non-activating.
plantedness = min( min target_rate over activating, 1 - max target_rate over non-activating ).
planted_epoch = first epoch whose plantedness >= 0.95 (None if never).
Complexity metrics are NOT computed here — the page computes them in-browser
from the real truth_table with its own (tested) Boolean-function code.
"""
import os, re, sys, json
from collections import defaultdict

ART = sys.argv[1] if len(sys.argv) > 1 else "/home/ntheffernan/booleanbackdoors/cmt-output/artifacts"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/home/ntheffernan/boolback-snapshot.json"
SAMPLE_A4 = int(os.environ.get("SAMPLE_A4", "0"))
PLANTED = 0.95

NODE_RE = re.compile(r"^([a-z_]+)\+([^+]*)\+([0-9a-f]{8,})$")
IN_CHAIN = {"function", "dataset", "training", "inference", "scoring"}
PROJECTED = IN_CHAIN | {"defense", "interp", "scan", "ppl"}
# group dirs whose (bulk / binary) children we don't materialize in the tree
PRUNE_CHILDREN = {"backdoor", "filler", "test", "lora", "full", "mitigated", "sanitized"}

def parse_dir(name):
    """-> (level, slug, hash) for an identity node, else None for a group dir."""
    m = NODE_RE.match(name)
    if m:
        return m.group(1), m.group(2), m.group(3)
    return None

def kind_of(level):
    return level  # 'defense_<contract>' / 'scan_<surface>' already encode it

def group_kind(name):
    if name.startswith("epoch-"): return "epoch"
    if name.startswith("row-"): return "row"
    known = {"backdoor", "filler", "test", "scans", "defenses", "interp", "lora", "full"}
    return name if name in known else None

def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

def short_model(base_model):
    # "Qwen/Qwen2.5-0.5B-Instruct@<commit>" -> "Qwen2.5-0.5B-Instruct"
    return base_model.split("@", 1)[0].split("/")[-1]

def tuning_label(cfg):
    t = (cfg or {}).get("tuning")
    if not isinstance(t, dict):
        return "none"
    name = t.get("name", "none")
    if name == "lora" or name == "qlora":
        r = t.get("r")
        return f"{name}-r{r}" if r is not None else name
    return name

# ---------------------------------------------------------------- tree walk
all_node_lock = set()   # rel paths that have a .lock somewhere inside their dir

def build_tree(root):
    """Walk once, build the nested TreeNode tree (pruned), and return
    (tree_root, function_dirs, config_by_relpath)."""
    art_name = os.path.basename(root.rstrip("/"))
    rootnode = {
        "dirName": "artifacts", "kind": "group", "groupKind": None, "level": None,
        "slug": None, "hash": None, "config": None, "elidedKeys": [], "done": False,
        "claimed": False, "inChain": False, "projected": False, "children": [],
    }
    function_dirs = []

    def make_node(name, abspath):
        parsed = parse_dir(name)
        has_lock = os.path.isdir(os.path.join(abspath, ".lock"))
        done = os.path.exists(os.path.join(abspath, "done.json"))
        if parsed:
            level, slug, h = parsed
            cfg = read_json(os.path.join(abspath, "config.json"))
            node = {
                "dirName": name, "kind": kind_of(level),
                "groupKind": None, "level": level, "slug": slug or None, "hash": h,
                "config": cfg, "elidedKeys": [], "done": done, "claimed": has_lock,
                "inChain": level in IN_CHAIN,
                "projected": (level.split("_")[0] in PROJECTED) or level in PROJECTED,
                "children": [],
            }
            if level.startswith("defense_"):
                node["contract"] = level.split("_", 1)[1]
                if cfg: node["evalFamily"] = cfg.get("eval_family")
            if level.startswith("scan_"):
                node["surface"] = level.split("_", 1)[1]
            return node
        gk = group_kind(name)
        return {
            "dirName": name, "kind": "group", "groupKind": gk, "level": None,
            "slug": None, "hash": None, "config": None, "elidedKeys": [],
            "done": done, "claimed": has_lock, "inChain": False, "projected": False,
            "children": [],
        }

    def recurse(absdir, node, depth):
        try:
            entries = sorted(os.listdir(absdir))
        except OSError:
            return
        for e in entries:
            ap = os.path.join(absdir, e)
            if not os.path.isdir(ap) or e == ".lock":
                continue
            child = make_node(e, ap)
            node["children"].append(child)
            if child["level"] == "function":
                function_dirs.append((e, ap, child))
            # prune bulk/binary subtrees but keep the header node
            if e in PRUNE_CHILDREN:
                continue
            recurse(ap, child, depth + 1)

    recurse(root, rootnode, 0)
    return rootnode, function_dirs

# ------------------------------------------------------------- experiments
def activates(truth_table, presence):
    idx = 0
    for k, b in enumerate(presence):
        if b:
            idx += (1 << k)
    return idx < len(truth_table) and truth_table[idx] == "1"

def score_outcomes(truth_table, score):
    rows = score.get("rows", [])
    act, non = [], []
    for r in rows:
        tr = r.get("target_rate", 0.0)
        if activates(truth_table, r.get("presence", [])):
            act.append((tr, r.get("correctness_rate", 0.0)))
        else:
            non.append(tr)
    asr = sum(t for t, _ in act) / len(act) if act else 0.0
    ftr = sum(non) / len(non) if non else 0.0
    if act and non:
        plantedness = min(min(t for t, _ in act), 1 - max(non))
    elif act:
        plantedness = min(t for t, _ in act)
    else:
        plantedness = 0.0
    stealth = sum(min(t, c) for t, c in act) / len(act) if act else 0.0
    return asr, ftr, plantedness, stealth

CHAIN_RE = re.compile(
    r"/function\+([^/]+)/dataset\+([^/]+)/training\+([^/]+)/epoch-(\d+)/inference\+([^/]+)/scoring\+([^/]+)$"
)

def hash_of(slughash):
    return slughash.rsplit("+", 1)[-1]

def collect_experiments(root, keep_funcs):
    """Scan every base-experiment score.json (not under defenses/) and roll up
    per (function,dataset,training,inference,scoring) across epochs."""
    fn_truth = {}     # functionDir -> truth_table
    groups = {}       # key -> aggregate
    epoch_asr = {}    # (fH,dH,tH,epoch,iH,sH) -> asr  (for defense drop)
    base_models, sources, judges = set(), set(), set()

    for dirpath, dirnames, filenames in os.walk(root):
        if "/defenses/" in dirpath or "/interp/" in dirpath:
            # defense/interp evals handled separately
            if "score.json" in filenames and "/defenses/" in dirpath:
                pass  # processed in defense pass below via second walk
            continue
        if "score.json" not in filenames:
            continue
        rel = dirpath[len(root):]
        m = CHAIN_RE.search(dirpath)
        if not m:
            continue
        fslug, dslug, tslug, epoch, islug, sslug = m.groups()
        epoch = int(epoch)
        fdir = "function+" + fslug
        if keep_funcs is not None and fdir not in keep_funcs:
            continue
        tt = fslug.split("+")[0]  # function slug == truth table
        # skip non-binary or weird function slugs
        if not re.fullmatch(r"[01]+", tt):
            continue
        score = read_json(os.path.join(dirpath, "score.json"))
        if not score:
            continue
        fH, dH, tH = hash_of(fslug), hash_of(dslug), hash_of(tslug)
        iH, sH = hash_of(islug), hash_of(sslug)
        asr, ftr, plantedness, stealth = score_outcomes(tt, score)
        epoch_asr[(fH, dH, tH, epoch, iH, sH)] = asr
        key = (fH, dH, tH, iH, sH)
        g = groups.get(key)
        if g is None:
            # read configs once
            dcfg = read_json(os.path.join(root, "function+" + fslug, "dataset+" + dslug, "config.json")) or {}
            tcfg = read_json(os.path.join(root, "function+" + fslug, "dataset+" + dslug, "training+" + tslug, "config.json")) or {}
            scfg_path = os.path.join(dirpath, "config.json")
            scfg = read_json(scfg_path) or {}
            task = (dcfg.get("task") or {})
            tb = (dcfg.get("target_behavior") or {})
            tf = (dcfg.get("trigger_form") or {})
            ps = (dcfg.get("poison_strategy") or {})
            bm = short_model(tcfg.get("base_model", "?"))
            src = task.get("source", "?")
            jd = scfg.get("judge", "?")
            base_models.add(bm); sources.add(src); judges.add(jd)
            g = groups[key] = {
                "rowId": sH, "functionHash": fH, "datasetHash": dH, "trainingHash": tH,
                "inferenceHash": iH, "scoringHash": sH, "pairKey": sH,
                "scoringDir": "scoring+" + sslug,
                "chainDirs": ["artifacts", "function+" + fslug, "dataset+" + dslug,
                              "training+" + tslug, "inference+" + islug, "scoring+" + sslug],
                "task": task.get("name", "?"), "source": src,
                "targetBehavior": tb.get("name", "?"), "targetPhrase": tb.get("sentinel", ""),
                "triggerForm": tf.get("name", "?"),
                "rowDistribution": ps.get("row_distribution", "uniform"),
                "baseModel": bm, "tuning": tuning_label(tcfg), "judge": jd, "split": "test",
                "arity": len(tt).bit_length() - 1, "truthTable": tt,
                "triggerlessCorrectness": score.get("triggerless_correctness", 0.0),
                "seedN": 1, "_epochs": {},
            }
        g["_epochs"][epoch] = (asr, ftr, plantedness, stealth)
    return fn_truth, groups, epoch_asr, base_models, sources, judges

def attach_defenses(root, groups, epoch_asr):
    """Walk defense/interp evals and roll up auroc / asr_drop / interp presence."""
    det_auroc = defaultdict(list)  # key -> [auroc]
    drops = defaultdict(list)      # key -> [asr_drop]
    has_interp = set()
    DEF_RE = re.compile(
        r"/function\+([^/]+)/dataset\+([^/]+)/training\+([^/]+)/epoch-(\d+)/defenses/(defense_[a-z]+)\+([^/]+)"
    )
    INT_RE = re.compile(
        r"/function\+([^/]+)/dataset\+([^/]+)/training\+([^/]+)/epoch-(\d+)/interp/interp\+"
    )
    for dirpath, dirnames, filenames in os.walk(root):
        mi = INT_RE.search(dirpath)
        if mi:
            fslug, dslug, tslug = mi.group(1), mi.group(2), mi.group(3)
            has_interp.add((hash_of(fslug), hash_of(dslug), hash_of(tslug)))
        if "detection.json" in filenames:
            md = DEF_RE.search(dirpath)
            if md:
                det = read_json(os.path.join(dirpath, "detection.json")) or {}
                if "auroc" in det and det["auroc"] is not None:
                    fslug, dslug, tslug = md.group(1), md.group(2), md.group(3)
                    key = (hash_of(fslug), hash_of(dslug), hash_of(tslug))
                    det_auroc[key].append(float(det["auroc"]))
        if "score.json" in filenames and "/defenses/" in dirpath:
            md = DEF_RE.search(dirpath)
            if not md:
                continue
            fslug, dslug, tslug, epoch = md.group(1), md.group(2), md.group(3), int(md.group(4))
            tt = fslug.split("+")[0]
            if not re.fullmatch(r"[01]+", tt):
                continue
            score = read_json(os.path.join(dirpath, "score.json"))
            if not score:
                continue
            # find the nested inference/scoring hashes for the undefended pair
            mm = re.search(r"/inference\+([^/]+)/scoring\+([^/]+)$", dirpath)
            if not mm:
                continue
            iH, sH = hash_of(mm.group(1)), hash_of(mm.group(2))
            fH, dH, tH = hash_of(fslug), hash_of(dslug), hash_of(tslug)
            und = epoch_asr.get((fH, dH, tH, epoch, iH, sH))
            if und is None:
                continue
            def_asr, _, _, _ = score_outcomes(tt, score)
            drops[(fH, dH, tH, iH, sH)].append(und - def_asr)

    for key, g in groups.items():
        fkey = (g["functionHash"], g["datasetHash"], g["trainingHash"])
        aurocs = det_auroc.get(fkey, [])
        these_drops = drops.get(key, [])
        g["bestDetectorAuroc"] = max(aurocs) if aurocs else None
        g["maxAsrDrop"] = max(these_drops) if these_drops else None
        g["hasDefense"] = (g["bestDetectorAuroc"] is not None) or (g["maxAsrDrop"] is not None)
        g["hasInterp"] = fkey in has_interp
        g["hasNegativeDrop"] = any(d < 0 for d in these_drops)

def finalize(groups, all_false_arities):
    experiments = []
    for key, g in groups.items():
        epochs = g.pop("_epochs")
        order = sorted(epochs)
        last = order[-1]
        asr, ftr, plantedness, stealth = epochs[last]
        planted_epoch = next((e for e in order if epochs[e][2] >= PLANTED), None)
        g["asr"] = round(asr, 4); g["ftr"] = round(ftr, 4)
        g["stealthRate"] = round(stealth, 4)
        g["planted"] = plantedness >= PLANTED
        g["plantedEpoch"] = planted_epoch
        g["ppl"] = 0.0; g["pplDrift"] = 0.0
        g["inProgress"] = False
        g["hasScan"] = False
        g["hasTwin"] = ("0" * len(g["truthTable"])) in all_false_arities or g["tuning"] == "none"
        g["heuristicProvenance"] = False
        g["epochAsr"] = {str(e): round(epochs[e][0], 4) for e in order}  # trajectory polyline
        g.setdefault("bestDetectorAuroc", None)
        g.setdefault("maxAsrDrop", None)
        g.setdefault("hasDefense", False)
        g.setdefault("hasInterp", False)
        g.setdefault("hasNegativeDrop", False)
        g["metrics"] = {}  # filled in-browser from truthTable
        experiments.append(g)
    return experiments

def main():
    print(f"[export] walking {ART} ...", file=sys.stderr)
    tree, function_dirs = build_tree(ART)
    # optional arity-4 sampling to bound size
    keep = None
    if SAMPLE_A4 > 0:
        a4 = [name for (name, ap, node) in function_dirs
              if re.fullmatch(r"[01]+", name.split("+")[1]) and len(name.split("+")[1]) == 16]
        keep_a4 = set(a4[:SAMPLE_A4])
        keep = {name for (name, ap, node) in function_dirs
                if not (len(name.split("+")[1]) == 16) or name in keep_a4}
        # prune tree children to kept functions
        tree["children"] = [c for c in tree["children"]
                            if c.get("level") != "function" or c["dirName"] in keep]
        print(f"[export] arity-4 sampled to {len(keep_a4)} (kept {len(keep)} functions)", file=sys.stderr)
    all_false = {("0" * len(name.split("+")[1].replace('0','0'))) for (name, _, _) in function_dirs
                 if re.fullmatch(r"0+", name.split("+")[1])}
    fn_truth, groups, epoch_asr, base_models, sources, judges = collect_experiments(ART, keep)
    print(f"[export] {len(groups)} experiments; attaching defenses ...", file=sys.stderr)
    attach_defenses(ART, groups, epoch_asr)
    experiments = finalize(groups, all_false)

    def count_nodes(n):
        return 1 + sum(count_nodes(c) for c in n["children"])
    meta = {
        "source": "turing:" + ART,
        "treeNodeCount": count_nodes(tree),
        "experimentCount": len(experiments),
        "axes": {
            "baseModels": sorted(base_models), "sources": sorted(sources),
            "judges": sorted(judges),
        },
        "sampleArity4": SAMPLE_A4 or None,
    }
    snapshot = {"meta": meta, "tree": tree, "experiments": experiments}
    with open(OUT, "w") as f:
        json.dump(snapshot, f, separators=(",", ":"))
    sz = os.path.getsize(OUT)
    print(f"[export] wrote {OUT}  nodes={meta['treeNodeCount']} experiments={meta['experimentCount']} bytes={sz:,}", file=sys.stderr)

if __name__ == "__main__":
    main()
