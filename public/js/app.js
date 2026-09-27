// app.js — logica del frontend, hablando directo con Supabase (Postgres + Auth)

document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

const fmtMoneda = (n) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(n || 0);

function mostrarError(err) {
  console.error(err);
  alert(err.message || "Ocurrió un error. Revisá la consola para más detalle.");
}

/* =========================================================================
   PEDIDOS
========================================================================= */
let itemsPedidoActual = []; // [{producto_id, nombre, precio, cantidad}]

const inputBuscar = document.getElementById("p-buscar-producto");
const resultadosEl = document.getElementById("p-resultados-productos");

inputBuscar.addEventListener("input", async () => {
  const q = inputBuscar.value.trim();
  if (!q) { resultadosEl.innerHTML = ""; return; }
  const { data, error } = await supabaseClient
    .from("productos")
    .select("*")
    .eq("activo", true)
    .ilike("nombre", `%${q}%`)
    .order("nombre");
  if (error) return mostrarError(error);
  resultadosEl.innerHTML = data
    .map(
      (p) => `<li data-id="${p.id}" data-nombre="${p.nombre}" data-precio="${p.precio}">
                 <span>${p.nombre}</span><span>${fmtMoneda(p.precio)}</span>
               </li>`
    )
    .join("");
});

resultadosEl.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  agregarItem({
    producto_id: Number(li.dataset.id),
    nombre: li.dataset.nombre,
    precio: Number(li.dataset.precio),
    cantidad: 1,
  });
  inputBuscar.value = "";
  resultadosEl.innerHTML = "";
});

function agregarItem(item) {
  const existente = itemsPedidoActual.find((i) => i.producto_id === item.producto_id);
  if (existente) existente.cantidad += 1;
  else itemsPedidoActual.push(item);
  renderItemsPedido();
}

function renderItemsPedido() {
  const body = document.getElementById("p-items-body");
  body.innerHTML = itemsPedidoActual
    .map(
      (item, idx) => `
      <tr>
        <td>${item.nombre}</td>
        <td><input type="number" min="1" value="${item.cantidad}" data-idx="${idx}" class="cant-input" style="width:55px" /></td>
        <td>${fmtMoneda(item.precio)}</td>
        <td>${fmtMoneda(item.precio * item.cantidad)}</td>
        <td><button type="button" data-idx="${idx}" class="quitar-item">✕</button></td>
      </tr>`
    )
    .join("");

  const total = itemsPedidoActual.reduce((acc, i) => acc + i.precio * i.cantidad, 0);
  document.getElementById("p-total").textContent = fmtMoneda(total);

  body.querySelectorAll(".quitar-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      itemsPedidoActual.splice(Number(btn.dataset.idx), 1);
      renderItemsPedido();
    })
  );
  body.querySelectorAll(".cant-input").forEach((inp) =>
    inp.addEventListener("change", () => {
      itemsPedidoActual[Number(inp.dataset.idx)].cantidad = Math.max(1, Number(inp.value));
      renderItemsPedido();
    })
  );
}

document.getElementById("form-pedido").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (itemsPedidoActual.length === 0) {
    alert("Agregá al menos un producto al pedido.");
    return;
  }

  // 1) Crear el pedido (el total arranca en 0; el trigger de Supabase lo
  //    recalcula automáticamente apenas insertamos el detalle)
  const { data: pedido, error: errorPedido } = await supabaseClient
    .from("pedidos")
    .insert({
      cliente_nombre: document.getElementById("p-cliente").value,
      direccion: document.getElementById("p-direccion").value,
      telefono: document.getElementById("p-telefono").value,
      metodo_pago: document.getElementById("p-metodo-pago").value,
      estado: "Pendiente",
    })
    .select()
    .single();
  if (errorPedido) return mostrarError(errorPedido);

  // 2) Insertar el detalle de productos del pedido
  const detalle = itemsPedidoActual.map((i) => ({
    pedido_id: pedido.id,
    producto_id: i.producto_id,
    cantidad: i.cantidad,
    precio_unitario: i.precio,
    subtotal: i.precio * i.cantidad,
  }));
  const { error: errorDetalle } = await supabaseClient.from("pedido_detalle").insert(detalle);
  if (errorDetalle) return mostrarError(errorDetalle);

  e.target.reset();
  itemsPedidoActual = [];
  renderItemsPedido();
  cargarPedidos();
});

async function cargarPedidos() {
  const estado = document.getElementById("filtro-estado").value;

  let consulta = supabaseClient
    .from("pedidos")
    .select("*, cadetes(nombre, apellido)")
    .order("fecha_creacion", { ascending: false });

  // Los pedidos cerrados (archivados) no se mezclan con los activos
  if (estado === "__cerrados") {
    consulta = consulta.not("cierre_id", "is", null);
  } else {
    consulta = consulta.is("cierre_id", null);
    if (estado) consulta = consulta.eq("estado", estado);
  }

  const [{ data: pedidos, error }, { data: cadetesDisponibles }] = await Promise.all([
    consulta,
    supabaseClient.from("cadetes").select("*").eq("estado", "Disponible").order("nombre"),
  ]);
  if (error) return mostrarError(error);

  const opcionesCadetes = (actual) => {
    const lista = [...cadetesDisponibles];
    if (actual && !lista.some((c) => c.id === actual.id)) lista.push(actual);
    return (
      `<option value="">Sin asignar</option>` +
      lista
        .map((c) => `<option value="${c.id}" ${actual && c.id === actual.id ? "selected" : ""}>${c.nombre} ${c.apellido || ""}</option>`)
        .join("")
    );
  };

  document.getElementById("lista-pedidos").innerHTML = pedidos
    .map((p) => {
      const claseBadge = p.estado.replace(" ", "");
      const actual = p.cadetes ? { id: p.cadete_id, nombre: p.cadetes.nombre, apellido: p.cadetes.apellido } : null;
      return `
      <div class="item-card">
        <div class="fila-top">
          <span class="nombre">#${p.id} — ${p.cliente_nombre}</span>
          <span class="badge ${claseBadge}">${p.estado}${p.cierre_id ? " 🔒" : ""}</span>
        </div>
        <div class="detalle">
          ${p.direccion} · ${p.telefono} · ${p.metodo_pago} · <strong>${fmtMoneda(p.total)}</strong>
          ${actual ? `· Cadete: ${actual.nombre} ${actual.apellido}` : ""}
        </div>
        <div class="acciones">
          <select data-id="${p.id}" class="cambiar-estado" ${p.cierre_id ? "disabled" : ""}>
            ${["Pendiente", "En Camino", "Entregado", "Cancelado"]
              .map((s) => `<option ${s === p.estado ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
          <select data-id="${p.id}" class="asignar-cadete" ${p.cierre_id ? "disabled" : ""}>
            ${opcionesCadetes(actual)}
          </select>
        </div>
      </div>`;
    })
    .join("") || "<p>No hay pedidos.</p>";

  document.querySelectorAll(".cambiar-estado").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const { error } = await supabaseClient
        .from("pedidos")
        .update({ estado: sel.value })
        .eq("id", sel.dataset.id);
      if (error) return mostrarError(error);
      cargarPedidos();
      cargarCadetes();
    })
  );
  document.querySelectorAll(".asignar-cadete").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const { error } = await supabaseClient
        .from("pedidos")
        .update({ cadete_id: sel.value ? Number(sel.value) : null })
        .eq("id", sel.dataset.id);
      if (error) return mostrarError(error);
      cargarPedidos();
      cargarCadetes();
    })
  );
}

document.getElementById("btn-refrescar-pedidos").addEventListener("click", cargarPedidos);
document.getElementById("filtro-estado").addEventListener("change", cargarPedidos);

/* =========================================================================
   CADETES
========================================================================= */
document.getElementById("form-cadete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("c-id").value;
  const payload = {
    nombre: document.getElementById("c-nombre").value,
    apellido: document.getElementById("c-apellido").value,
    dni: document.getElementById("c-dni").value,
    telefono: document.getElementById("c-telefono").value,
    vehiculo: document.getElementById("c-vehiculo").value,
    modelo: document.getElementById("c-modelo").value,
    patente: document.getElementById("c-patente").value,
  };
  const query = id
    ? supabaseClient.from("cadetes").update(payload).eq("id", id)
    : supabaseClient.from("cadetes").insert({ ...payload, estado: "Disponible" });
  const { error } = await query;
  if (error) return mostrarError(error);
  resetFormCadete();
  cargarCadetes();
});

document.getElementById("btn-cancelar-edicion").addEventListener("click", resetFormCadete);

function resetFormCadete() {
  document.getElementById("form-cadete").reset();
  document.getElementById("c-id").value = "";
  document.getElementById("cadete-form-titulo").textContent = "Nuevo cadete";
  document.getElementById("btn-cancelar-edicion").hidden = true;
}

async function cargarCadetes() {
  const { data: cadetes, error } = await supabaseClient.from("cadetes").select("*").order("nombre");
  if (error) return mostrarError(error);

  document.getElementById("lista-cadetes").innerHTML = cadetes
    .map(
      (c) => `
      <div class="item-card">
        <div class="fila-top">
          <span class="nombre">${c.nombre} ${c.apellido || ""}</span>
          <span class="badge ${c.estado}">${c.estado}</span>
        </div>
        <div class="detalle">DNI: ${c.dni || "-"} · ${c.telefono} · ${c.vehiculo} ${c.modelo || ""} · Patente: ${c.patente || "-"}</div>
        <div class="acciones">
          <select data-id="${c.id}" class="cambiar-estado-cadete">
            ${["Disponible", "Ocupado", "Franco"]
              .map((s) => `<option ${s === c.estado ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
          <button type="button" data-id="${c.id}" class="editar-cadete">Editar</button>
          <button type="button" data-id="${c.id}" class="eliminar-cadete">Eliminar</button>
        </div>
      </div>`
    )
    .join("") || "<p>No hay cadetes cargados.</p>";

  document.querySelectorAll(".cambiar-estado-cadete").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const { error } = await supabaseClient
        .from("cadetes")
        .update({ estado: sel.value })
        .eq("id", sel.dataset.id);
      if (error) return mostrarError(error);
      cargarCadetes();
    })
  );
  document.querySelectorAll(".editar-cadete").forEach((btn) =>
    btn.addEventListener("click", () => {
      const c = cadetes.find((c) => c.id === Number(btn.dataset.id));
      document.getElementById("c-id").value = c.id;
      document.getElementById("c-nombre").value = c.nombre;
      document.getElementById("c-apellido").value = c.apellido || "";
      document.getElementById("c-dni").value = c.dni || "";
      document.getElementById("c-telefono").value = c.telefono;
      document.getElementById("c-vehiculo").value = c.vehiculo;
      document.getElementById("c-modelo").value = c.modelo;
      document.getElementById("c-patente").value = c.patente;
      document.getElementById("cadete-form-titulo").textContent = `Editando: ${c.nombre}`;
      document.getElementById("btn-cancelar-edicion").hidden = false;
    })
  );
  document.querySelectorAll(".eliminar-cadete").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este cadete?")) return;
      const { error } = await supabaseClient.from("cadetes").delete().eq("id", btn.dataset.id);
      if (error) return mostrarError(error);
      cargarCadetes();
    })
  );
}

/* =========================================================================
   PRODUCTOS
========================================================================= */
document.getElementById("form-producto").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    nombre: document.getElementById("pr-nombre").value,
    categoria: document.getElementById("pr-categoria").value,
    precio: Number(document.getElementById("pr-precio").value),
    stock: Number(document.getElementById("pr-stock").value),
  };
  const { error } = await supabaseClient.from("productos").insert(payload);
  if (error) return mostrarError(error);
  e.target.reset();
  cargarProductos();
});

async function cargarProductos() {
  const { data: productos, error } = await supabaseClient
    .from("productos")
    .select("*")
    .eq("activo", true)
    .order("nombre");
  if (error) return mostrarError(error);

  document.getElementById("lista-productos").innerHTML = productos
    .map(
      (p) => `
      <div class="item-card">
        <div class="fila-top">
          <span class="nombre">${p.nombre}</span>
          <span>${fmtMoneda(p.precio)}</span>
        </div>
        <div class="detalle">${p.categoria || "Sin categoría"} · Stock: ${p.stock}</div>
        <div class="acciones">
          <button type="button" data-id="${p.id}" class="eliminar-producto">Dar de baja</button>
        </div>
      </div>`
    )
    .join("") || "<p>No hay productos cargados. Importá tu catálogo o agregá uno arriba.</p>";

  document.querySelectorAll(".eliminar-producto").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("¿Dar de baja este producto?")) return;
      const { error } = await supabaseClient
        .from("productos")
        .update({ activo: false })
        .eq("id", btn.dataset.id);
      if (error) return mostrarError(error);
      cargarProductos();
    })
  );
}

// Nota: la carga inicial (cargarPedidos/cargarCadetes/cargarProductos) la
// dispara auth.js apenas confirma que hay una sesión activa.
