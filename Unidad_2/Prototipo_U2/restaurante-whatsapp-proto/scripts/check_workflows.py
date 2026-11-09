#!/usr/bin/env python3
"""Comprobación estática de los workflows exportados de n8n (NO los ejecuta)."""
import json, glob, os, re, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bad = 0
def chk(name, ok, d=''):
    global bad; bad += 0 if ok else 1; print(('OK   ' if ok else 'FALLA'), name, ('— ' + d) if d else '')
for f in sorted(glob.glob(f'{root}/automation/workflows/*.json')):
    w = json.load(open(f)); n = os.path.basename(f); names = [x['name'] for x in w['nodes']]; ids = [x['id'] for x in w['nodes']]
    print('##', n, f"({len(names)} nodos)")
    chk('JSON válido con nodos y conexiones', bool(w['nodes']) and bool(w['connections']))
    chk('nombres e IDs de nodo únicos', len(set(names)) == len(names) and len(set(ids)) == len(ids))
    refs = [k for k in w['connections']] + [t['node'] for v in w['connections'].values() for br in v['main'] for t in br]
    chk('toda conexión apunta a un nodo existente', all(r in names for r in refs))
    trig = [x for x in w['nodes'] if x['type'].endswith('.webhook')]
    chk('un disparador webhook con autenticación por cabecera', len(trig) == 1 and trig[0]['parameters'].get('authentication') == 'headerAuth')
    seen, todo = set(), [trig[0]['name']]
    while todo:
        c = todo.pop()
        if c in seen: continue
        seen.add(c); todo += [t['node'] for br in w['connections'].get(c, {'main': []})['main'] for t in br]
    chk('todos los nodos son alcanzables desde el disparador', seen == set(names), f'{len(seen)}/{len(names)}')
    txt = json.dumps(w, ensure_ascii=False)
    chk('sin secretos incrustados (solo referencias a credenciales)', not re.search(r'(sk-|Bearer [A-Za-z0-9]{12,}|EAA[A-Za-z0-9]{20,})', txt) and all(set(c) == {'id', 'name'} for x in w['nodes'] for c in x.get('credentials', {}).values()))
    http = [x for x in w['nodes'] if x['type'].endswith('httpRequest')]
    chk('las llamadas HTTP usan credencial y reintentos (máx. 3)', all(x['credentials'] and x['parameters']['options']['retry']['maxTries'] == 3 for x in http), f'{len(http)} llamadas')
    posts = [x for x in http if x['parameters']['method'] == 'POST']
    chk('todo POST envía Idempotency-Key', all(any(h['name'] == 'Idempotency-Key' for h in x['parameters']['headerParameters']['parameters']) for x in posts), f'{len(posts)} POST')
    chk('controla errores con un workflow dedicado (WF-08)', w['settings'].get('errorWorkflow') == 'WF-08_errors_and_retries')
    if 'WF-05' in n:
        chk("el acuse nunca dice que el pago está aprobado/pagado", not re.search(r'pago (aprobado|verificado|confirmado)|pagado', txt.split('Estamos verificando')[0].lower().split('text:')[-1]) and 'Estamos verificando el pago' in txt)
print('\nResultado:', 'todas las comprobaciones superadas' if bad == 0 else f'{bad} fallas'); sys.exit(1 if bad else 0)
