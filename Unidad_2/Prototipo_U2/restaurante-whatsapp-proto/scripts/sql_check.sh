#!/usr/bin/env bash
# Pruebas del esquema en un PostgreSQL 16 efímero (se crea y se destruye en /tmp). Requiere los binarios de PostgreSQL.
set -u
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DIR=$(mktemp -d /tmp/pgproto.XXXXXX); chown postgres "$DIR"
PORT=${PGPORT:-54329}
runuser -u postgres -- "$PGBIN/initdb" -D "$DIR/data" -A trust >/dev/null
runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null
psqlc() { runuser -u postgres -- psql -h "$DIR" -p $PORT -X -q "$@"; }
echo "# $(runuser -u postgres -- "$PGBIN/postgres" --version)"
psqlc -d postgres -c "CREATE DATABASE restaurante;" >/dev/null
echo "## Aplicación del esquema (database/001_schema.sql)"
psqlc -d restaurante -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../database/001_schema.sql" && echo "esquema aplicado sin errores: $(psqlc -d restaurante -Atc "select count(*) from information_schema.tables where table_schema='public'") tablas"
echo "## Pruebas S1 a S10"
psqlc -d restaurante -f "$(dirname "$0")/../tests/sql_tests.sql" 2>&1 | sed -E 's/^psql:[^:]+:[0-9]+: //'
echo "## Respaldo y restauración (T20 / PT-19 parcial)"
BEFORE=$(psqlc -d restaurante -Atc "select (select count(*) from customers)||'/'||(select count(*) from orders)||'/'||(select count(*) from order_items)||'/'||(select count(*) from messages)||'/'||(select count(*) from audit_log)")
runuser -u postgres -- "$PGBIN/pg_dump" -h "$DIR" -p $PORT -Fc -f "$DIR/respaldo.dump" restaurante
psqlc -d postgres -c "CREATE DATABASE restaurante_restaurada;" >/dev/null
START=$(date +%s.%N)
runuser -u postgres -- "$PGBIN/pg_restore" -h "$DIR" -p $PORT -d restaurante_restaurada "$DIR/respaldo.dump"
END=$(date +%s.%N)
AFTER=$(psqlc -d restaurante_restaurada -Atc "select (select count(*) from customers)||'/'||(select count(*) from orders)||'/'||(select count(*) from order_items)||'/'||(select count(*) from messages)||'/'||(select count(*) from audit_log)")
echo "filas (clientes/pedidos/líneas/mensajes/auditoría) origen=$BEFORE restaurada=$AFTER"
[ "$BEFORE" = "$AFTER" ] && echo "restauración íntegra: SÍ" || echo "restauración íntegra: NO"
echo "tiempo de restauración del volcado de prueba: $(printf '%.2f' "$(echo "$END - $START" | bc)") s (base pequeña, no representa el RTO real)"
runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null; rm -rf "$DIR"
