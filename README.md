# Sistema de Gestión de Envíos y Cadetes — Xoxo Lomas

Versión web sin servidor propio: el frontend (HTML/CSS/JS puro) habla
directo con **Supabase** (base de datos Postgres + login), y se aloja como
sitio estático en **Netlify**.

## 1. Crear el proyecto en Supabase

1. Entrá a [supabase.com](https://supabase.com), creá una cuenta/proyecto (elegí una región cercana, ej. São Paulo).
2. Andá a **SQL Editor → New query**, pegá todo el contenido de `supabase/schema.sql` y hacé clic en **Run**.
   Esto crea las tablas `productos`, `cadetes`, `pedidos`, `pedido_detalle`, y los triggers que:
   - recalculan el total del pedido automáticamente al agregar/quitar productos,
   - sincronizan el estado del cadete (Disponible/Ocupado) al asignarlo o al entregar/cancelar un pedido.
3. Andá a **Authentication → Users → Add user** y creá tu usuario de operador (email + contraseña). Con eso vas a entrar a la app — no hace falta que los clientes ni los cadetes tengan cuenta, es solo para vos y quien gestione los pedidos.
4. Andá a **Settings → API** y copiá:
   - **Project URL**
   - **anon public** key

## 2. Configurar el frontend

Abrí `public/js/config.js` y pegá ahí esos dos valores:

```js
const SUPABASE_URL = "https://tu-proyecto.supabase.co";
const SUPABASE_ANON_KEY = "tu-anon-key-aqui";
```

La *anon key* no es secreta (viaja en el navegador), pero por las políticas
de seguridad (RLS) que trae el esquema, solo un usuario logueado puede leer
o escribir datos — así que aunque alguien la vea, no puede entrar sin la
contraseña de tu usuario de operador.

## 3. Subir a Netlify

Como ahora todo es un sitio estático (sin backend Node corriendo), hay dos formas:

**Opción rápida — arrastrar y soltar:**
Entrá a [app.netlify.com/drop](https://app.netlify.com/drop) y arrastrá la carpeta `public/` completa.

**Opción recomendada — conectar tu repositorio (permite actualizaciones futuras):**
1. Subí esta carpeta a un repo de GitHub/GitLab.
2. En Netlify: **Add new site → Import an existing project**, elegí el repo.
3. En "Publish directory" poné `public` (el `netlify.toml` incluido ya lo configura solo).
4. Deploy.

Cada vez que hagas un cambio y lo subas al repo, Netlify vuelve a publicar el sitio automáticamente.

## 4. Cargar tu catálogo de productos desde Excel

Esto se corre **desde tu computadora** (no en Netlify), porque necesita una
clave especial de Supabase que nunca debe quedar pública:

```bash
npm install

# Definí estas dos variables (una sola vez por sesión de terminal):
export SUPABASE_URL="https://tu-proyecto.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="tu-service-role-key"   # Settings -> API -> "service_role"

npm run import:productos -- ruta/a/tu-archivo.xlsx
```

Tu Excel debe tener una fila de encabezado con columnas `nombre | categoria | precio | stock`
(no importa el orden ni mayúsculas/minúsculas). Si tenés varias hojas:

```bash
npm run import:productos -- ruta/a/tu-archivo.xlsx "Precios"
```

Podés correrlo las veces que quieras: actualiza precios de productos
existentes (por nombre) e inserta los nuevos. `data/productos-ejemplo.json`
sirve para probar el flujo completo.

> Si tu Excel usa otros nombres de columna, avisá la estructura real de tu
> planilla para ajustar el mapeo del script.

## 5. Estructura del proyecto

```
xoxo-lomas-web/
├── netlify.toml                    # Config de Netlify (sirve /public)
├── package.json                    # Solo para el script de importación
├── supabase/
│   ├── schema.sql                  # Tablas + triggers, se corre una vez en Supabase
│   └── migracion_cierres.sql       # Cierre de pedidos por turno (correr después de schema.sql)
├── scripts/
│   └── importar-productos.js       # Importador de Excel/CSV/JSON a Supabase
├── data/
│   └── productos-ejemplo.json
└── public/                         # Esto es lo que se sube a Netlify
    ├── index.html
    ├── css/style.css
    └── js/
        ├── config.js                # Tus credenciales de Supabase (URL + anon key)
        ├── supabaseClient.js        # Inicializa el cliente
        ├── auth.js                  # Login / logout con Supabase Auth
        ├── app.js                   # Lógica de pedidos, cadetes y productos
        └── cierres.js                # Cierre de turnos y dashboard de ventas por turno
```

## 6. Modelo de datos y lógica automática

Igual que en la versión anterior (ver `supabase/schema.sql` para el detalle
completo), con la diferencia de que ahora la lógica de negocio vive en
**triggers de Postgres** en lugar de en un backend Express:

- El **total del pedido** se recalcula solo cada vez que cambian sus productos.
- Al **asignar un cadete**, el pedido pasa a "En Camino" y el cadete a "Ocupado".
- Al marcar **"Entregado" o "Cancelado"**, el cadete asignado vuelve a "Disponible".

## 7. Cierre de pedidos por turno

Además de `supabase/schema.sql`, corré también `supabase/migracion_cierres.sql`
(SQL Editor → New query → pegar → Run). Agrega:

- **Turnos automáticos**: cada pedido nuevo recibe un `turno` (Mañana /
  Tarde-Noche, editable en la tabla `turnos_config`) y una `fecha_operativa`,
  calculados según la hora de creación (zona horaria Argentina). Un turno que
  cruza la medianoche cuenta como el día en que empezó.
- **Cierre de turno**: desde la pestaña **Cierres**, el botón "Cerrar turno"
  archiva los pedidos Entregado/Cancelado de ese turno (quedan bloqueados,
  no se pueden editar ni borrar) y guarda un resumen en la tabla `cierres`.
- **Dashboard de ventas por turno**: filtros por rango de fechas y turno,
  con pedidos entregados/cancelados, monto recaudado, ticket promedio y
  entregas por cadete.
- Los pedidos ya cerrados dejan de listarse entre los "activos"; para verlos
  hay una opción "Cerrados (archivados)" en el filtro de estado de la
  pestaña Pedidos.

## 8. Próximos pasos sugeridos

- Si vas a tener más de un operador, podés crear un usuario por persona en Supabase Auth.
- Dominio propio para el sitio de Netlify (Netlify → Domain settings).
- Notificaciones al cliente por WhatsApp al cambiar el estado del pedido.
- Restringir el cierre de turnos solo a administradores (ver comentario en
  la función `cerrar_turno` dentro de `supabase/migracion_cierres.sql`).
- Función para reabrir un cierre por error (hoy no está incluida, a propósito).
