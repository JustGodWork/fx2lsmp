"""Compares the FiveM native database (fx-oop data) with the LS:MP client natives catalogue."""
import json, re, sys, collections

LS = json.load(open('docs/raw/natives.json', encoding='utf8'))
FX = json.load(open('E:/GITHUB/fx-oop/data/natives.json', encoding='utf8'))

def camel(name: str) -> str:
    parts = name.lower().strip('_').split('_')
    return parts[0] + ''.join(p[:1].upper() + p[1:] for p in parts[1:])

ls_by_hash = {}
for ns in LS['namespaces']:
    for n in ns['natives']:
        ls_by_hash[n['hash'].upper() if 'hash' in n else n['native']] = (ns['id'], n)

fx_by_hash = {}
for ns, entries in FX.items():
    for h, n in entries.items():
        fx_by_hash[h.upper()] = n

stats = collections.Counter()
blocked = collections.Counter()
renamed = []
missing_ns = collections.Counter()
for h, n in fx_by_hash.items():
    n.setdefault('name', '_' + h)
    hit = ls_by_hash.get(h) or ls_by_hash.get(n['name'])
    if not hit:
        stats['fivem_only'] += 1
        missing_ns[n['ns']] += 1
        continue
    _, l = hit
    stats['matched'] += 1
    if l.get('blocked'): blocked[l['blocked']] += 1
    for flag in ('checked', 'na', 'issue'):
        if l.get(flag): stats[flag] += 1
    if l['name'] != camel(n['name']) and not n['name'].startswith('_0x'):
        renamed.append((n['name'], l['name']))
    if n['name'].startswith('_0x') or n['name'].startswith('_'):
        stats['fivem_unnamed_or_underscore'] += 1
fx_names = {n['name'] for n in fx_by_hash.values()}
stats['lsmp_only'] = sum(1 for h, (_, l) in ls_by_hash.items() if h not in fx_by_hash and l['native'] not in fx_names)
stats['lsmp_total'] = len(ls_by_hash); stats['fivem_total'] = len(fx_by_hash)
print(dict(stats)); print('blocked', dict(blocked)); print('fivem-only by ns', missing_ns.most_common(10))
print('renamed', len(renamed), renamed[:15])
print('Vector3 type:', json.dumps(LS['types'].get('Vector3'))); print('types', list(LS['types']))
