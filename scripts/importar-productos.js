/**
 * scripts/importar-productos.js
 * -------------------------------------------------------------------------
 * Importa tu catálogo de productos (Excel, CSV o JSON) directo a la tabla
 * `productos` de tu proyecto de Supabase.
 *
 * ESTO CORRE EN TU COMPUTADORA (no en Netlify, no en el navegador), porque
 * necesita la "service role key" de Supabase, que es secreta y NUNCA debe
 * viajar al frontend ni subirse a un repo público.
 *
 * CONFIGURACIÓN (una sola vez):
 *   1. En tu proyecto de Supabase: Settings -> API -> copiá:
 *        - "Project URL"
 *        - "service_role" key (OJO: no es la "anon" key, es otra)
 *   2. Definilas como variables de entorno antes de correr el script:
 *        macOS/Linux:
 *          export SUPABASE_URL="https://tu-proyecto.supabase.co"
 *          export SUPABASE_SERVICE_ROLE_KEY="tu-service-role-key"
 *        Windows (PowerShell):
 *          $env:SUPABASE_URL="https://tu-proyecto.supabase.co"
 *          $env:SUPABASE_SERVICE_ROLE_KEY="tu-service-role-key"
 *
 * USO:
 *   npm install
 *   npm run import:productos -- ruta/a/tu-archivo.xlsx
 *   npm run import:productos -- ruta/a/tu-archivo.xlsx "Nombre de la hoja"
 *   npm run import:productos -- ruta/a/tu-archivo.json
 *   npm run import:productos -- ruta/a/tu-archivo.csv
 *
 * FORMATO ESPERADO: una fila/objeto por producto, con columnas (el orden no
 * importa, no distingue mayúsculas/minúsculas):
 *   nombre | categoria | precio | stock
 *
 * Si tu Excel usa otros nombres de columna (ej: "Producto", "Precio Unitario"),
 * avisale a Claude la estructura real de tu planilla para ajustar el mapeo.
 *
 * Los productos existentes con el mismo nombre se ACTUALIZAN (precio/stock);
 * los nuevos se insertan. Podés correrlo cada vez que actualices tu Excel.
 * -------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Faltan variables de entorno. Definí SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY antes de correr el script (ver comentario al inicio de este archivo)."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function parseCSV(contenido) {
  const [encabezado, ...filas] = contenido
    .split(/\r?\n/)
    .filter((linea) => linea.trim() !== "");
  const columnas = encabezado.split(",").map((c) => c.trim().toLowerCase());
  return filas.map((fila) => {
    const valores = fila.split(",").map((v) => v.trim());
    const obj = {};
    columnas.forEach((col, i) => (obj[col] = valores[i]));
    return {
      nombre: obj.nombre,
      categoria: obj.categoria || "",
      precio: parseFloat(obj.precio),
      stock: parseInt(obj.stock || "0", 10),
    };
  });
}

function parseExcel(rutaArchivo, nombreHoja) {
  const libro = XLSX.readFile(rutaArchivo);
  const hoja = nombreHoja ? libro.Sheets[nombreHoja] : libro.Sheets[libro.SheetNames[0]];
  if (!hoja) {
    throw new Error(
      `No se encontro la hoja "${nombreHoja}". Hojas disponibles: ${libro.SheetNames.join(", ")}`
    );
  }
  const filas = XLSX.utils.sheet_to_json(hoja, { defval: "" });
  return filas.map((fila) => {
    const normalizada = {};
    for (const [clave, valor] of Object.entries(fila)) {
      normalizada[clave.trim().toLowerCase()] = valor;
    }
    return {
      nombre: String(normalizada.nombre || "").trim(),
      categoria: String(normalizada.categoria || "").trim(),
      precio: parseFloat(normalizada.precio),
      stock: parseInt(normalizada.stock || 0, 10),
    };
  });
}

function cargarArchivo(rutaArchivo, nombreHoja) {
  const extension = path.extname(rutaArchivo).toLowerCase();
  if (extension === ".xlsx" || extension === ".xls") return parseExcel(rutaArchivo, nombreHoja);
  if (extension === ".json") return JSON.parse(fs.readFileSync(rutaArchivo, "utf-8"));
  if (extension === ".csv") return parseCSV(fs.readFileSync(rutaArchivo, "utf-8"));
  throw new Error("Formato no soportado. Usa un archivo .xlsx, .json o .csv");
}

async function importar(rutaArchivo, nombreHoja) {
  const filas = cargarArchivo(rutaArchivo, nombreHoja).filter(
    (p) => p.nombre && !Number.isNaN(p.precio)
  );
  if (filas.length === 0) {
    console.log("No se encontraron filas válidas para importar.");
    return;
  }

  // Trae los productos existentes para decidir cuáles actualizar vs insertar
  const { data: existentes, error: errorLectura } = await supabase
    .from("productos")
    .select("id, nombre");
  if (errorLectura) throw errorLectura;

  const idPorNombre = new Map(existentes.map((p) => [p.nombre, p.id]));

  const aInsertar = [];
  const aActualizar = [];
  for (const p of filas) {
    if (idPorNombre.has(p.nombre)) {
      aActualizar.push({ id: idPorNombre.get(p.nombre), ...p });
    } else {
      aInsertar.push(p);
    }
  }

  if (aInsertar.length > 0) {
    const { error } = await supabase.from("productos").insert(aInsertar);
    if (error) throw error;
  }
  for (const p of aActualizar) {
    const { id, ...campos } = p;
    const { error } = await supabase.from("productos").update(campos).eq("id", id);
    if (error) throw error;
  }

  console.log(
    `Importación completa: ${aInsertar.length} productos creados, ${aActualizar.length} actualizados.`
  );
}

const rutaArchivo = process.argv[2];
const nombreHoja = process.argv[3];
if (!rutaArchivo) {
  console.error(
    'Uso: npm run import:productos -- <archivo.xlsx|archivo.json|archivo.csv> ["Nombre de hoja"]'
  );
  process.exit(1);
}
importar(rutaArchivo, nombreHoja).catch((err) => {
  console.error("Error al importar:", err.message);
  process.exit(1);
});
