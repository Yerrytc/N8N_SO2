#!/usr/bin/env python3
"""Verifica el Compose contra las decisiones del informe (sin necesitar el demonio de Docker)."""
import json, subprocess, ipaddress, sys, re, os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def cfg(profile=None):
    cmd = ['docker', 'compose', '-f', f'{root}/infra/compose.yaml', '--env-file', f'{root}/.env.example']
    if profile: cmd += ['--profile', profile]
    return json.loads(subprocess.run(cmd + ['config', '--format', 'json'], capture_output=True, text=True, check=True).stdout)
import shutil
tmp_env = f'{root}/infra/.env'; created = not os.path.exists(tmp_env)
if created: shutil.copy(f'{root}/.env.example', tmp_env)   # compose exige el archivo; se borra al final
try:
    prod, dev = cfg(), cfg('dev')
finally:
    if created: os.remove(tmp_env)
S = prod['services']; res = []
def chk(name, ok, detail=''): res.append((name, ok, detail)); print(('OK   ' if ok else 'FALLA'), name, ('— ' + detail) if detail else '')
chk('C1 el Compose es válido (docker compose config)', True, f"{len(S)} servicios en producción; {len(dev['services'])} con el perfil dev")
chk('C2 las imágenes llevan etiqueta fija (sin latest)', all(not re.search(r':latest$|^[^:]+$', s['image']) for s in S.values()), ', '.join(s['image'] for s in S.values()))
pub = {n: [(p.get('host_ip', '0.0.0.0'), p['published'], p['target']) for p in s.get('ports', [])] for n, s in S.items() if s.get('ports')}
chk('C3 postgres_n8n, api, outbox-worker no publican puertos', not any(n in pub for n in ('postgres_n8n', 'api', 'outbox-worker')), f'puertos publicados: {pub}')
chk('C4 Internet solo ve 80 y 443 (caddy)', sorted(p[1] for p in pub['caddy']) == ['443', '80'] and all(p[0] == '0.0.0.0' for p in pub['caddy']))
chk('C5 el editor de n8n escucha solo en la IP de wg0', pub['n8n'] == [('10.99.0.1', '5678', 5678)], str(pub['n8n']))
chk('C6 todos los servicios: cap_drop ALL y no-new-privileges', all(s.get('cap_drop') == ['ALL'] and 'no-new-privileges:true' in s.get('security_opt', []) for s in S.values()))
chk('C7 n8n y api se ejecutan sin root (1000:1000)', S['n8n']['user'] == '1000:1000' and S['api']['user'] == '1000:1000')
tot = round(sum(int(s['mem_limit']) for s in S.values()) / 2**20)  # compose config devuelve bytes
chk('C8 suma de límites de memoria = 2 784 MB (informe, Tabla 10)', tot == 2784, f'{tot} MB (< 4 GB de la VPS)')
chk('C9 todos tienen reinicio automático', all(s['restart'] == 'unless-stopped' for s in S.values()))
nets = prod['networks']; sub = {k: ipaddress.ip_network(v['ipam']['config'][0]['subnet']) for k, v in nets.items()}
chk('C10 subredes del informe (172.30.10/20/30.0/24)', [str(sub[k]) for k in ('net_edge', 'net_app', 'net_data')] == ['172.30.10.0/24', '172.30.20.0/24', '172.30.30.0/24'])
chk('C11 net_data es interna (sin salida a Internet)', nets['net_data'].get('internal') is True)
ok = True
for n, s in dev['services'].items():
    for net, c in (s.get('networks') or {}).items():
        ip = ipaddress.ip_address(c['ipv4_address']); ok &= ip in sub[net]
chk('C12 cada IP fija pertenece a su subred', ok)
chk('C13 postgres_n8n solo está en la red interna', list(S['postgres_n8n']['networks']) == ['net_data'])
chk('C14 caddy no toca la red de datos', 'net_data' not in S['caddy']['networks'])
chk('C15 el perfil dev no existe en producción', 'postgres_negocio' not in S and 'postgres_negocio' in dev['services'])
chk('C16 servicios con healthcheck (api, caddy, n8n, postgres_n8n)', all('healthcheck' in S[n] for n in ('api', 'caddy', 'n8n', 'postgres_n8n')))
env = open(f'{root}/.env.example').read()
chk('C17 .env.example no contiene secretos reales (todo REDACTED)', all(('REDACTED' in l) or not re.search(r'(SECRET|TOKEN|KEY|PASSWORD)=', l) for l in env.splitlines()))
print(f"\nResultado: {sum(1 for r in res if r[1])}/{len(res)} comprobaciones superadas")
sys.exit(0 if all(r[1] for r in res) else 1)
