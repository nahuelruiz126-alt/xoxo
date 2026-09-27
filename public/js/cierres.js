// cierres.js — Cierre de turnos + dashboard de ventas por turno

const hoyISO = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

function fechaLinda(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function iniciarCierres() {
  const hoy = hoyISO();
  const hace7 = new Date(Date.now() - 6 * 86400000).toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const desde = document.getElementById("v-desde");
  const hasta = document.getElementById("v-hasta");
  if (!desde.value) desde.value = hace7;
  if (!hasta.value) hasta.value = hoy;

  await cargarTurnosSelect();
  cargarPendientesCierre();
  cargarHistorialCierres();
  cargarVentasPorTurno();
}

async function cargarTurnosSelect() {
  const { data, error } = await supabaseClient.from("turnos_config").select("nombre").order("orden");
  if (error) return mostrarError(error);
  const sel = document.getElementById("v-turno");
  const actual = sel.value;
  sel.innerHTML =
    `<option value="">Todos</option>` +
    data.map((t) => `<option value="${t.nombre}">${t.nombre}</option>`).join("");
  sel.value = actual;
}

/* ---------- Turnos pendientes de cierre ---------- */
async function cargarPendientesCierre() {
  const { data, error } = await supabaseClient
    .from("pedidos")
    .select("fecha_operativa, turno, estado, total")
    .is("cierre_id", null)
    .order("fecha_operativa", { ascending: false });
  if (error) return mostrarError(error);

  const grupos = new Map();
  for (const p of data) {
    const k = `${p.fecha_operativa}|${p.turno}`;
    const g =
      grupos.get(k) ||
      { fecha: p.fecha_operativa, turno: p.turno, entregados: 0, cancelados: 0, enCurso: 0, monto: 0 };
    if (p.estado === "Entregado") {
      g.entregados++;
      g.monto += Number(p.total);
    } else if (p.estado === "Cancelado") g.cancelados++;
    else g.enCurso++;
    grupos.set(k, g);
  }

  // Solo tiene sentido cerrar turnos con algo entregado/cancelado
  const cerrables = [...grupos.values()].filter((g) => g.entregados + g.cancelados > 0);

  document.getElementById("lista-pendientes-cierre").innerHTML =
    cerrables
      .map(
        (g) => `
      <div class="item-card">
        <div class="fila-top">
          <span class="nombre">${fechaLinda(g.fecha)} · ${g.turno}</span>
          <strong>${fmtMoneda(g.monto)}</strong>
        </div>
        <div class="detalle">
          ${g.entregados} entregados · ${g.cancelados} cancelados
          ${g.enCurso ? `· <span style="color:var(--pendiente)">${g.enCurso} en curso</span>` : ""}
        </div>
        <div class="acciones">
          <button type="button" class="btn-cerrar-turno"
                  data-fecha="${g.fecha}" data-turno="${g.turno}" data-encurso="${g.enCurso}">
            Cerrar turno
          </button>
        </div>
      </div>`
      )
      .join("") || "<p>No hay turnos pendientes de cierre. ✅</p>";

  document.querySelectorAll(".btn-cerrar-turno").forEach((btn) =>
    btn.addEventListener("click", () =>
      cerrarTurno(btn.dataset.fecha, btn.dataset.turno, Number(btn.dataset.encurso))
    )
  );
}

async function cerrarTurno(fecha, turno, enCurso) {
  let permitirPendientes = false;
  if (enCurso > 0) {
    permitirPendientes = confirm(
      `Hay ${enCurso} pedido(s) todavía en curso en este turno.\n\n` +
        `Si continuás, solo se cierran los entregados/cancelados y los pedidos en curso quedan abiertos.\n\n¿Continuar?`
    );
    if (!permitirPendientes) return;
  }
  const notas = prompt("Notas del cierre (opcional):") ?? "";
  if (
    !confirm(
      `¿Confirmás el cierre de "${turno}" del ${fechaLinda(fecha)}?\nLos pedidos cerrados no se podrán modificar.`
    )
  )
    return;

  const { data, error } = await supabaseClient.rpc("cerrar_turno", {
    p_fecha: fecha,
    p_turno: turno,
    p_notas: notas,
    p_permitir_pendientes: permitirPendientes,
  });
  if (error) return mostrarError(error);

  alert(
    `Cierre realizado: ${data.cantidad_entregados} entregados · ${fmtMoneda(data.monto_total)} recaudados.`
  );
  cargarPendientesCierre();
  cargarHistorialCierres();
  cargarVentasPorTurno();
  if (typeof cargarPedidos === "function") cargarPedidos();
}

/* ---------- Historial de cierres ---------- */
async function cargarHistorialCierres() {
  const { data, error } = await supabaseClient
    .from("cierres")
    .select("*")
    .order("fecha_cierre", { ascending: false })
    .limit(30);
  if (error) return mostrarError(error);

  document.getElementById("lista-cierres").innerHTML =
    data
      .map(
        (c) => `
      <div class="item-card">
        <div class="fila-top">
          <span class="nombre">${fechaLinda(c.fecha_operativa)} · ${c.turno}</span>
          <strong>${fmtMoneda(c.monto_total)}</strong>
        </div>
        <div class="detalle">
          ${c.cantidad_entregados} entregados · ${c.cantidad_cancelados} cancelados ·
          cerrado el ${new Date(c.fecha_cierre).toLocaleString("es-AR")}
          ${c.notas ? `<br>📝 ${c.notas}` : ""}
        </div>
      </div>`
      )
      .join("") || "<p>Todavía no hay cierres.</p>";
}

/* ---------- Dashboard: ventas por turno ---------- */
async function cargarVentasPorTurno() {
  const args = {
    p_desde: document.getElementById("v-desde").value,
    p_hasta: document.getElementById("v-hasta").value,
    p_turno: document.getElementById("v-turno").value || null,
  };
  if (!args.p_desde || !args.p_hasta) return;

  const [ventas, cadetes] = await Promise.all([
    supabaseClient.rpc("resumen_ventas_por_turno", args),
    supabaseClient.rpc("resumen_por_cadete", args),
  ]);
  if (ventas.error) return mostrarError(ventas.error);
  if (cadetes.error) return mostrarError(cadetes.error);

  const filas = ventas.data;

  // KPIs
  const entregados = filas.reduce((a, f) => a + Number(f.entregados), 0);
  const cancelados = filas.reduce((a, f) => a + Number(f.cancelados), 0);
  const monto = filas.reduce((a, f) => a + Number(f.monto_recaudado), 0);
  document.getElementById("kpi-entregados").textContent = entregados;
  document.getElementById("kpi-cancelados").textContent = cancelados;
  document.getElementById("kpi-monto").textContent = fmtMoneda(monto);
  document.getElementById("kpi-ticket").textContent = fmtMoneda(entregados ? monto / entregados : 0);

  // Gráfico de barras simple (sin librerías): monto recaudado por fecha+turno
  const max = Math.max(1, ...filas.map((f) => Number(f.monto_recaudado)));
  document.getElementById("grafico-turnos").innerHTML =
    [...filas]
      .reverse()
      .map((f) => {
        const pct = (Number(f.monto_recaudado) / max) * 100;
        return `
      <div class="barra-fila">
        <span class="barra-label">${fechaLinda(f.fecha_operativa)} · ${f.turno}</span>
        <div class="barra-track"><div class="barra ${f.cerrado ? "cerrada" : ""}" style="width:${pct}%"></div></div>
        <span class="barra-valor">${fmtMoneda(f.monto_recaudado)}</span>
      </div>`;
      })
      .join("") || "<p>Sin datos para el rango elegido.</p>";

  // Tabla
  document.getElementById("tabla-ventas-body").innerHTML =
    filas
      .map(
        (f) => `
      <tr>
        <td>${fechaLinda(f.fecha_operativa)}</td>
        <td>${f.turno}</td>
        <td>${f.total_pedidos}</td>
        <td>${f.entregados}</td>
        <td>${f.cancelados}</td>
        <td>${f.en_curso}</td>
        <td><strong>${fmtMoneda(f.monto_recaudado)}</strong></td>
        <td>${f.cerrado ? "🔒 Cerrado" : "🟡 Abierto"}</td>
      </tr>`
      )
      .join("") || `<tr><td colspan="8">Sin resultados.</td></tr>`;

  document.getElementById("tabla-cadetes-body").innerHTML =
    cadetes.data
      .map(
        (c) => `
      <tr>
        <td>${c.cadete}</td><td>${c.turno}</td>
        <td>${c.entregas}</td><td>${fmtMoneda(c.monto_recaudado)}</td>
      </tr>`
      )
      .join("") || `<tr><td colspan="4">Sin entregas en el rango.</td></tr>`;
}

document.getElementById("btn-consultar-ventas").addEventListener("click", cargarVentasPorTurno);
