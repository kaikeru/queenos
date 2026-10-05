#!/usr/bin/env python3
"""Summarize a /run JSON result: python3 summarize.py run.json"""
import json, sys
raw = open(sys.argv[1]).read().rsplit("\nHTTP", 1)[0]
d = json.loads(raw)
if "error" in d and "changed" not in d:
    print("ERROR", d["error"][:800]); sys.exit()
print(f"harness={d['harness']} model={d['model']} totalMs={d['totalMs']} cloneMs={d['cloneMs']} loopMs={d.get('loopMs')} stop={d.get('stopReason', d.get('saveResult'))}")
print("changed:", [(c['path'], c['status']) for c in d['changed']])
fv = d['finalVerify']
print("finalVerify:", fv['ok'], [(p['path'], p['status'], p['contentType']) for p in fv['probes']], fv.get('error'))
print("usage:", d.get('usage'))
print("verify calls:", len(d.get('verifyCalls', [])))
for t in d.get('turns', []):
    print(f"  t{t['turn']:>2} {t['ms']:>6}ms in={t['inputTokens']:>5} out={t['outputTokens']:>5} state={t['stateBytes']:>6}B {t['finishReason']:<10} " + ", ".join(f"{x['name']}({x['input'][:70]})" for x in t['tools']) + (f" TEXT:{t['text'][:80]!r}" if t['text'] else ""))
for s in d.get('steps', []):
    print(f"  step {s['ms']:>6}ms in={s['inputTokens']:>5} out={s['outputTokens']:>5} {s['finishReason']:<10} {s['tools']}")
if d.get('toolParts'): print("  tool parts:", [(t['tool'], t['state']) for t in d['toolParts']])
fin = d.get('finished')
print("finish:", json.dumps(fin)[:600] if fin else None)
