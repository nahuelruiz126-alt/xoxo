-- =============================================================================
-- Sistema de Gestión de Envíos y Cadetes — Xoxo Lomas
-- Esquema para Supabase (Postgres)
--
-- CÓMO EJECUTARLO:
--   1. Entrá a tu proyecto en https://supabase.com/dashboard
--   2. Andá a "SQL Editor" -> "New query"
--   3. Pegá todo este archivo y hacé clic en "Run"
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TABLAS
-- ---------------------------------------------------------------------------
create table if not exists productos (
  id        bigint generated always as identity primary key,
  nombre    text not null,
  categoria text default '',
  precio    numeric(12,2) not null check (precio >= 0),
  stock     integer default 0,
  activo    boolean not null default true
);

create table if not exists cadetes (
  id        bigint generated always as identity primary key,
  nombre    text not null,
  apellido  text default '',
  dni       text default '',
  telefono  text not null,
  vehiculo  text not null check (vehiculo in ('Moto', 'Auto')),
  modelo    text default '',
  patente   text default '',
  estado    text not null default 'Disponible'
              check (estado in ('Disponible', 'Ocupado', 'Franco'))
);

create table if not exists pedidos (
  id              bigint generated always as identity primary key,
  cliente_nombre  text not null,
  direccion       text not null,
  telefono        text not null,
  metodo_pago     text not null default 'Efectivo',
  estado          text not null default 'Pendiente'
                    check (estado in ('Pendiente', 'En Camino', 'Entregado', 'Cancelado')),
  cadete_id       bigint references cadetes(id) on delete set null,
  total           numeric(12,2) not null default 0,
  fecha_creacion  timestamptz not null default now(),
  fecha_entrega   timestamptz
);

create table if not exists pedido_detalle (
  id              bigint generated always as identity primary key,
  pedido_id       bigint not null references pedidos(id) on delete cascade,
  producto_id     bigint not null references productos(id),
  cantidad        integer not null check (cantidad > 0),
  precio_unitario numeric(12,2) not null,
  subtotal        numeric(12,2) not null
);

create index if not exists idx_pedidos_estado on pedidos(estado);
create index if not exists idx_detalle_pedido on pedido_detalle(pedido_id);

-- ---------------------------------------------------------------------------
-- LÓGICA AUTOMÁTICA (antes vivía en el backend Express, ahora en la base)
-- ---------------------------------------------------------------------------

-- 1) Recalcula el total del pedido cada vez que se agrega/edita/borra un item
create or replace function recalcular_total_pedido() returns trigger as $$
begin
  update pedidos
     set total = coalesce((
       select sum(subtotal) from pedido_detalle
       where pedido_id = coalesce(new.pedido_id, old.pedido_id)
     ), 0)
   where id = coalesce(new.pedido_id, old.pedido_id);
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_recalcular_total on pedido_detalle;
create trigger trg_recalcular_total
after insert or update or delete on pedido_detalle
for each row execute function recalcular_total_pedido();

-- 2) Cuando un pedido cambia de estado o de cadete asignado, mantiene
--    sincronizado el estado del cadete (Disponible/Ocupado) automáticamente.
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

  -- Al entregar o cancelar, el cadete asignado vuelve a estar Disponible
  if new.estado in ('Entregado', 'Cancelado') and new.cadete_id is not null then
    update cadetes set estado = 'Disponible' where id = new.cadete_id;
    if new.estado = 'Entregado' and new.fecha_entrega is null then
      new.fecha_entrega := now();
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sincronizar_cadete on pedidos;
create trigger trg_sincronizar_cadete
before update on pedidos
for each row execute function sincronizar_estado_cadete();

-- ---------------------------------------------------------------------------
-- SEGURIDAD (RLS)
-- ---------------------------------------------------------------------------
-- Este sistema es de uso interno (vos y tus cadetes/operadores), no público.
-- Para que la app funcione desde el frontend con la "anon key" (que es
-- publicable y viaja en el navegador), habilitamos RLS y damos acceso total
-- SOLO a usuarios autenticados con Supabase Auth. Esto evita que cualquiera
-- que encuentre tu URL de Supabase pueda leer o modificar tus pedidos.
--
-- Ver el README para cómo crear tu usuario/contraseña de operador con
-- Supabase Auth (Authentication -> Users -> Add user).

alter table productos enable row level security;
alter table cadetes enable row level security;
alter table pedidos enable row level security;
alter table pedido_detalle enable row level security;

drop policy if exists "acceso autenticado" on productos;
create policy "acceso autenticado" on productos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "acceso autenticado" on cadetes;
create policy "acceso autenticado" on cadetes
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "acceso autenticado" on pedidos;
create policy "acceso autenticado" on pedidos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "acceso autenticado" on pedido_detalle;
create policy "acceso autenticado" on pedido_detalle
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
