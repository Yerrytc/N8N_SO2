# RETEQUE-OS · Prueba de concepto de la II Unidad

Prototipo mínimo que verifica el **diseño** descrito en el informe técnico de la II Unidad
(Sistemas Operativos II, UPT). No es la implementación de la III Unidad.

## Qué contiene

| Carpeta | Contenido |
|---|---|
| `apps/api` | API de negocio en Node.js (sin dependencias): webhook de Meta con firma HMAC, idempotencia por `wamid`, cotización con precios en céntimos, máquina de estados, regla *comprobante ≠ pago*, roles, auditoría y outbox con reintentos. Almacén en memoria. |
| `automation/sim` | Simulador del orquestador n8n (WF-01 a WF-06) para ejercitar la API sin levantar n8n. |
| `automation/workflows` | Exportaciones JSON de dos workflows n8n (`WF-01`, `WF-05`), sin secretos. |
| `database` | Esquema PostgreSQL con las restricciones que el documento de arquitectura dejaba pendientes. |
| `infra` | `compose.yaml` y `Caddyfile` de la VPS, tal como se describen en el informe. |
| `tests`, `scripts` | Pruebas SQL, comprobaciones de infraestructura y de workflows, demo de extremo a extremo y ensayo de carga. |
| `evidence` | Salidas reales de la última ejecución. |

## Cómo reproducirlo

```bash
./scripts/run_all.sh                 # todo, guarda la salida en evidence/
cd apps/api && node --test test/pt.test.js   # solo las pruebas de la API (Node 22 o superior)
node scripts/e2e_demo.js             # "Hola, quiero dos hamburguesas" hasta pedido CONFIRMED
python3 scripts/check_infra.py       # valida compose.yaml (requiere docker CLI + compose; no necesita el demonio)
```

`scripts/sql_check.sh` levanta un PostgreSQL 16 efímero en `/tmp` (requiere los binarios de PostgreSQL y ejecutarse como root).

## Qué se ejecutó y qué NO

Ejecutado: pruebas de la API (13), demo extremo a extremo, ensayo de latencia y de 50 pedidos, esquema y respaldo/restauración en PostgreSQL 16 real, y validación del Compose con `docker compose config`.

**No ejecutado en este prototipo:** contenedores (`docker compose up`), n8n real, Caddy, WireGuard, WhatsApp Cloud API real, descarga de medios desde Graph API, ni la VPS. Los tiempos medidos corresponden a un entorno de desarrollo, no a la VPS de 2 vCPU/4 GB.

## Para completar la evidencia en una máquina con Docker (lo que debe hacer el equipo)

1. `cp .env.example infra/.env` y completar valores de prueba; `docker compose -f infra/compose.yaml --profile dev up -d`.
2. Importar `automation/workflows/*.json` en n8n y crear las credenciales `API interna RETEQUE` y `Secreto compartido del despachador`.
3. Enviar un webhook firmado de prueba (ver `apps/api/test/helpers.js`) y capturar: `docker compose ps` (healthy), la ejecución del workflow en n8n, y `curl` al webhook con firma válida e inválida.
4. Guardar las capturas en `evidence/capturas/`.
