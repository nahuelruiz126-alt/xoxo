-- =============================================================================
-- Cierre de pedidos por turno — Xoxo Lomas
-- Migración para Supabase (Postgres)
--
-- CÓMO EJECUTARLO (después de schema.sql):
--   1. Supabase Dashboard -> SQL Editor -> New query
--   2. Pegá todo este archivo y hacé clic en "Run"
--
-- Es seguro correrlo más de una vez (usa "if not exists" / "create or replace").
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Configuración de turnos (editable).
--    Si hora_inicio > hora_fin, el turno cruza la medianoche.
-- ---------------------------------------------------------------------------
create table if not exists turnos_config (
  id          bigint generated always as identity primary key,
  nombre      text not null unique,
  hora_inicio time not null,
  hora_fin    time not null,
  orden       int  not null default 0
);

insert into turnos_config (nombre, hora_inicio, hora_fin, orden) values
  ('Mañana',      '06:00', '15:00', 1),
  ('Tarde/Noche', '15:00', '06:00', 2)
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Registro de cada cierre
-- ---------------------------------------------------------------------------
create table if not exists cierres (
  id                  bigint generated always as identity primary key,
  fecha_operativa     date not null,
  turno               text not null,
  cantidad_pedidos    int  not null default 0,
  cantidad_entregados int  not null default 0,
  cantidad_cancelados int  not null default 0,
  monto_total         numeric(12,2) not null default 0,
  notas               text default '',
  cerrado_por         uuid default auth.uid(),
  fecha_cierre        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3) Columnas nuevas en pedidos
-- ---------------------------------------------------------------------------
alter table pedidos
  add column if not exists turno           text,
  add column if not exists fecha_operativa date,
  add column if not exists cierre_id       bigint references cierres(id) on delete restrict;

create index if not exists idx_pedidos_turno_fecha on pedidos(fecha_operativa, turno);
create index if not exists idx_pedidos_cierre      on pedidos(cierre_id);

-- ---------------------------------------------------------------------------
-- 4) Calcula turno + fecha operativa a partir de un timestamp.
--    El turno que cruza la medianoche cuenta como el día en que empezó.
-- ---------------------------------------------------------------------------
do $$ begin
  create type turno_info as (turno text, fecha_operativa date);
exception when duplicate_object then null; end $$;

create or replace function calcular_turno(ts timestamptz) returns turno_info
language plpgsql stable as $$
declare
  loc timestamp := ts at time zone 'America/Argentina/Buenos_Aires';
  t   time := loc::time;
  cfg turnos_config%rowtype;
begin
  for cfg in select * from turnos_config order by orden loop
    if cfg.hora_inicio < cfg.hora_fin then
      if t >= cfg.hora_inicio and t < cfg.hora_fin then
        return row(cfg.nombre, loc::date)::turno_info;
      end if;
    else  -- cruza medianoche
      if t >= cfg.hora_inicio then
        return row(cfg.nombre, loc::date)::turno_info;
      elsif t < cfg.hora_fin then
        return row(cfg.nombre, (loc::date - 1))::turno_info;
      end if;
    end if;
  end loop;
  return row('Sin turno', loc::date)::turno_info;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Asigna turno automáticamente al crear un pedido
-- ---------------------------------------------------------------------------
create or replace function asignar_turno_pedido() returns trigger as $$
declare ti turno_info;
begin
  ti := calcular_turno(coalesce(new.fecha_creacion, now()));
  new.turno := ti.turno;
  new.fecha_operativa := ti.fecha_operativa;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_asignar_turno on pedidos;
create trigger trg_asignar_turno
before insert on pedidos
for each row execute function asignar_turno_pedido();

-- ---------------------------------------------------------------------------
-- 6) Completa los pedidos que ya existían
-- ---------------------------------------------------------------------------
update pedidos
   set turno           = (calcular_turno(fecha_creacion)).turno,
       fecha_operativa = (calcular_turno(fecha_creacion)).fecha_operativa
 where turno is null;

-- ---------------------------------------------------------------------------
-- 7) Un pedido cerrado no se puede modificar ni borrar
--    (el nombre trg_bloquear_cerrado corre antes que trg_sincronizar_cadete)
-- ---------------------------------------------------------------------------
create or replace function bloquear_pedido_cerrado() returns trigger as $$
begin
  if old.cierre_id is not null then
    raise exception 'El pedido #% pertenece a un cierre y no se puede modificar', old.id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_bloquear_cerrado on pedidos;
create trigger trg_bloquear_cerrado
before update or delete on pedidos
for each row execute function bloquear_pedido_cerrado();

create or replace function bloquear_detalle_cerrado() returns trigger as $$
declare pid bigint;
begin
  if tg_op = 'DELETE' then pid := old.pedido_id; else pid := new.pedido_id; end if;
  if exists (select 1 from pedidos where id = pid and cierre_id is not null) then
    raise exception 'El pedido #% está cerrado y no admite cambios', pid;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_bloquear_detalle_cerrado on pedido_detalle;
create trigger trg_bloquear_detalle_cerrado
before insert or update or delete on pedido_detalle
for each row execute function bloquear_detalle_cerrado();

-- ---------------------------------------------------------------------------
-- 8) CORRECCIÓN del trigger existente sincronizar_estado_cadete.
--    Antes, cualquier UPDATE de un pedido Entregado/Cancelado ponía al cadete
--    en "Disponible", incluso si ya tenía otro pedido en curso. Como el cierre
--    hace UPDATEs masivos, ahora solo lo libera cuando el ESTADO cambia.
-- ---------------------------------------------------------------------------
create or replace function sincronizar_estado_cadete() returns trigger as $$
begin
  -- Libera al cadete anterior si cambió la asignación
  if old.cadete_id is not null and old.cadete_id is distinct from new.cadete_id then
    update cadetes set estado = 'Disponible' where id = old.cadete_id;
  end if;

  -- Si se asignó un cadete nuevo, lo marca Ocupado y el pedido pasa a "En Camino"
  if new.cadete_id is not null and old.cadete_id is distinct from new.cadete_id then
    update cadetes set estado = 'Ocupado' where id = new.cadete_id;
    if new.estado = 'Pendiente' then
      new.estado := 'En Camino';
    end if;
  end if;

  -- Al entregar o cancelar (solo cuando el estado CAMBIA), libera al cadete
  if new.estado in ('Entregado', 'Cancelado')
     and old.estado is distinct from new.estado
     and new.cadete_id is not null then
    update cadetes set estado = 'Disponible' where id = new.cadete_id;
    if new.estado = 'Entregado' and new.fecha_entrega is null then
      new.fecha_entrega := now();
    end if;
  end if;

  return new;
end $$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 9) Seguridad (RLS): mismo criterio que el resto, solo usuarios autenticados
-- ---------------------------------------------------------------------------
alter table turnos_config enable row level security;
alter table cierres       enable row level security;

drop policy if exists "acceso autenticado" on turnos_config;
create policy "acceso autenticado" on turnos_config
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "acceso autenticado" on cierres;
create policy "acceso autenticado" on cierres
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- =============================================================================
-- FUNCIONES RPC (se llaman desde el frontend con supabaseClient.rpc(...))
-- =============================================================================

-- ---------------------------------------------------------------------------
-- cerrar_turno: archiva los pedidos Entregado/Cancelado de un turno y fecha
-- ---------------------------------------------------------------------------
create or replace function cerrar_turno(
  p_fecha date,
  p_turno text,
  p_notas text default '',
  p_permitir_pendientes boolean default false
) returns cierres
language plpgsql as $$
declare
  v_abiertos int;
  v_cierre   cierres;
begin
  -- (Opcional) restringir a administradores: en Supabase Auth guardá
  -- {"rol":"admin"} en app_metadata del usuario y descomentá:
  -- if coalesce(auth.jwt() -> 'app_metadata' ->> 'rol', '') <> 'admin' then
  --   raise exception 'Solo un administrador puede cerrar turnos';
  -- end if;

  select count(*) into v_abiertos
    from pedidos
   where fecha_operativa = p_fecha and turno = p_turno
     and cierre_id is null and estado in ('Pendiente', 'En Camino');

  if v_abiertos > 0 and not p_permitir_pendientes then
    raise exception 'Hay % pedido(s) Pendiente/En Camino en este turno. Resolvelos antes de cerrar.', v_abiertos;
  end if;

  insert into cierres (fecha_operativa, turno, notas)
  values (p_fecha, p_turno, coalesce(p_notas, ''))
  returning * into v_cierre;

  update pedidos set cierre_id = v_cierre.id
   where fecha_operativa = p_fecha and turno = p_turno
     and cierre_id is null and estado in ('Entregado', 'Cancelado');

  update cierres c set
    cantidad_pedidos    = s.n,
    cantidad_entregados = s.ent,
    cantidad_cancelados = s.can,
    monto_total         = s.monto
  from (
    select count(*) as n,
           count(*) filter (where estado = 'Entregado') as ent,
           count(*) filter (where estado = 'Cancelado') as can,
           coalesce(sum(total) filter (where estado = 'Entregado'), 0) as monto
      from pedidos where cierre_id = v_cierre.id
  ) s
  where c.id = v_cierre.id
  returning c.* into v_cierre;

  if v_cierre.cantidad_pedidos = 0 then
    raise exception 'No hay pedidos entregados/cancelados para cerrar en ese turno';
  end if;  -- la excepción revierte todo, incluido el INSERT del cierre

  return v_cierre;
end $$;

-- ---------------------------------------------------------------------------
-- resumen_ventas_por_turno: métricas por fecha operativa y turno (con filtros)
-- ---------------------------------------------------------------------------
create or replace function resumen_ventas_por_turno(
  p_desde date, p_hasta date, p_turno text default null
) returns table (
  fecha_operativa date, turno text,
  total_pedidos bigint, entregados bigint, cancelados bigint, en_curso bigint,
  monto_recaudado numeric, ticket_promedio numeric, cerrado boolean
)
language sql stable as $$
  select p.fecha_operativa, p.turno,
         count(*),
         count(*) filter (where p.estado = 'Entregado'),
         count(*) filter (where p.estado = 'Cancelado'),
         count(*) filter (where p.estado in ('Pendiente', 'En Camino')),
         coalesce(sum(p.total) filter (where p.estado = 'Entregado'), 0),
         coalesce(round(avg(p.total) filter (where p.estado = 'Entregado'), 2), 0),
         bool_and(p.cierre_id is not null)
    from pedidos p
   where p.fecha_operativa between p_desde and p_hasta
     and (p_turno is null or p.turno = p_turno)
   group by p.fecha_operativa, p.turno
   order by p.fecha_operativa desc, p.turno;
$$;

-- ---------------------------------------------------------------------------
-- resumen_por_cadete: entregas y monto por cadete dentro del rango/turno
-- ---------------------------------------------------------------------------
create or replace function resumen_por_cadete(
  p_desde date, p_hasta date, p_turno text default null
) returns table (
  cadete_id bigint, cadete text, turno text, entregas bigint, monto_recaudado numeric
)
language sql stable as $$
  select c.id, trim(c.nombre || ' ' || coalesce(c.apellido, '')), p.turno,
         count(*), coalesce(sum(p.total), 0)
    from pedidos p
    join cadetes c on c.id = p.cadete_id
   where p.estado = 'Entregado'
     and p.fecha_operativa between p_desde and p_hasta
     and (p_turno is null or p.turno = p_turno)
   group by c.id, c.nombre, c.apellido, p.turno
   order by p.turno, count(*) desc;
$$;
