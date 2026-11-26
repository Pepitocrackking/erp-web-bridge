// Genera infra/saint-sandbox/init/02-seed.sql de forma determinista (PRNG con semilla fija).
// Uso: node infra/saint-sandbox/tools/gen-seed.mjs
// Datos ficticios de una distribuidora venezolana de consumo masivo. Solo ASCII, como suele venir en Saint.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 20261126;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const pick = (arr) => arr[int(0, arr.length - 1)];
const r2 = (n) => Math.round(n * 100) / 100;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---- Catálogo -------------------------------------------------------------
// [codInst, descripción, [[producto, costoBaseUSD], ...], marcas, presentaciones]
const CATEGORIES = [
  ["VIVERES", "VIVERES Y ABARROTES", [["ARROZ BLANCO", 1.1], ["HARINA DE MAIZ PRECOCIDA", 1.2], ["PASTA LARGA", 1.0], ["PASTA CORTA", 1.0], ["AZUCAR REFINADA", 1.3], ["SAL YODADA", 0.5], ["ACEITE VEGETAL", 3.2], ["LENTEJAS", 1.6], ["CARAOTAS NEGRAS", 1.9], ["AVENA EN HOJUELAS", 1.4], ["CAFE MOLIDO", 3.5], ["HARINA DE TRIGO", 1.2]], ["MONICA", "PAN", "MARY", "LA ESPECIAL", "PRIMOR", "DON JUAN", "SELECTA"], ["500 G", "1 KG", "2 KG"]],
  ["BEBIDAS", "BEBIDAS", [["REFRESCO COLA", 1.2], ["REFRESCO NARANJA", 1.2], ["JUGO DE DURAZNO", 1.4], ["JUGO DE PERA", 1.4], ["AGUA MINERAL", 0.6], ["MALTA", 0.9], ["TE FRIO LIMON", 1.3], ["BEBIDA ENERGIZANTE", 2.1]], ["POLAR", "PEPSI", "COCA-COLA", "FRESCOLITA", "HIT", "GATORADE", "NESTEA"], ["355 ML", "1 L", "2 L"]],
  ["LACTEOS", "LACTEOS Y DERIVADOS", [["LECHE EN POLVO", 5.5], ["LECHE LARGA VIDA", 1.4], ["QUESO BLANCO DURO", 4.8], ["MARGARINA", 2.2], ["YOGURT NATURAL", 1.6], ["CREMA DE LECHE", 1.8], ["MANTEQUILLA", 3.0]], ["LA CAMPINA", "NESTLE", "LACTEOS LOS ANDES", "PARMALAT", "MIRAMAR", "NELLY"], ["200 G", "400 G", "900 G"]],
  ["CHARCUT", "CHARCUTERIA Y EMBUTIDOS", [["JAMON COCIDO", 4.2], ["MORTADELA", 2.4], ["SALCHICHA TIPO VIENA", 2.6], ["CHORIZO", 3.4], ["TOCINETA AHUMADA", 5.2]], ["PLUMROSE", "OSCAR MAYER", "VIZCAYA", "PIRRIN"], ["250 G", "500 G", "1 KG"]],
  ["ENLATADOS", "ENLATADOS Y CONSERVAS", [["ATUN EN ACEITE", 1.9], ["ATUN EN AGUA", 1.9], ["SARDINAS EN TOMATE", 1.2], ["MAIZ DULCE", 1.5], ["SALSA DE TOMATE", 1.1], ["MAYONESA", 2.4], ["KETCHUP", 2.0], ["MOSTAZA", 1.3], ["PASTA DE TOMATE", 1.0]], ["MARGARITA", "PESCADOR", "HEINZ", "KRAFT", "MAVESA", "TIO RICO", "DEL FRATE"], ["170 G", "300 G", "500 G"]],
  ["SNACKS", "SNACKS Y GALLETAS", [["GALLETAS DE SODA", 0.8], ["GALLETAS DULCES", 0.9], ["PAPAS FRITAS", 1.1], ["CHICHARRON", 0.9], ["MANI SALADO", 1.0], ["CHOCOLATE EN BARRA", 1.3], ["CARAMELOS SURTIDOS", 1.5], ["TORTILLAS DE MAIZ", 1.0]], ["SAMBA", "SAVOY", "RICOLINO", "PIZZEROLA", "PEPITO", "DORITOS", "CHEETOS"], ["40 G", "100 G", "200 G"]],
  ["LIMPIEZA", "LIMPIEZA DEL HOGAR", [["DETERGENTE EN POLVO", 3.6], ["DETERGENTE LIQUIDO", 4.4], ["CLORO", 1.1], ["DESINFECTANTE", 1.9], ["LAVAPLATOS", 1.6], ["SUAVIZANTE DE ROPA", 3.0], ["LIMPIAPISOS", 1.7], ["JABON DE BARRA PARA ROPA", 0.9]], ["ARIEL", "ACE", "MAS", "NUEVO LAS LLAVES", "AJAX", "FLASH", "DOWNY"], ["500 ML", "1 L", "3 L"]],
  ["CUIDADO", "CUIDADO PERSONAL", [["CHAMPU", 3.2], ["ACONDICIONADOR", 3.4], ["JABON DE TOCADOR", 0.8], ["CREMA DENTAL", 1.7], ["DESODORANTE", 2.9], ["PAPEL HIGIENICO 4 ROLLOS", 2.2], ["TOALLAS SANITARIAS", 2.5], ["PANALES DESECHABLES", 6.5]], ["COLGATE", "PALMOLIVE", "HEAD & SHOULDERS", "REXONA", "ROSAL", "PAMPERS", "HUGGIES"], ["PEQUENO", "MEDIANO", "GRANDE"]],
  ["PAPELERIA", "PAPELERIA Y OFICINA", [["CUADERNO RAYADO", 1.5], ["LAPIZ DE GRAFITO", 0.3], ["BOLIGRAFO AZUL", 0.3], ["RESMA DE PAPEL CARTA", 5.0], ["MARCADOR PERMANENTE", 0.9], ["CARPETA MANILA", 0.4], ["PEGAMENTO ESCOLAR", 0.8]], ["NORMA", "BIC", "FABER-CASTELL", "PELIKAN", "SHARPIE", "SCRIBE"], ["UNIDAD", "CAJA 12", "PAQUETE"]],
  ["MASCOTAS", "ALIMENTO PARA MASCOTAS", [["ALIMENTO PARA PERRO ADULTO", 14.0], ["ALIMENTO PARA CACHORRO", 16.0], ["ALIMENTO PARA GATO", 12.0], ["ARENA SANITARIA PARA GATO", 6.5]], ["PEDIGREE", "DOG CHOW", "CAT CHOW", "WHISKAS", "PURINA"], ["1 KG", "4 KG", "15 KG"]],
];

const MARGINS = { p1: 1.35, p2: 1.25, p3: 1.15 }; // precio 1 detal, 2 mayor, 3 mayor grande
const DEPOTS = [["001", "ALMACEN PRINCIPAL"], ["002", "SUCURSAL VALENCIA"], ["003", "MOSTRADOR TIENDA"]];

const products = [];
for (const [cod, , items, brands, sizes] of CATEGORIES) {
  for (const [name, baseCost] of items) {
    // Cada producto base se ofrece en 3 a 5 combinaciones marca/presentación distintas.
    const combos = new Set();
    const target = int(3, 5);
    while (combos.size < target) combos.add(`${pick(brands)}|${pick(sizes)}`);
    for (const combo of [...combos].sort()) {
      const [brand, size] = combo.split("|");
      const sizeFactor = sizes.indexOf(size) === 0 ? 1 : sizes.indexOf(size) === 1 ? 1.7 : 2.8;
      const cost = r2(baseCost * sizeFactor * (0.9 + rnd() * 0.25));
      products.push({
        cod, desc: `${name} ${brand} ${size}`, cost,
        p1: r2(cost * MARGINS.p1), p2: r2(cost * MARGINS.p2), p3: r2(cost * MARGINS.p3),
      });
    }
  }
}
products.sort((a, b) => (a.cod + a.desc < b.cod + b.desc ? -1 : 1));
products.forEach((p, i) => {
  p.code = "P" + String(i + 1).padStart(5, "0");
  p.active = rnd() < 0.05 ? 0 : 1;
  p.stock = DEPOTS.map(([dep], di) => {
    if (!p.active) return 0;
    if (rnd() < 0.08) return 0; // agotado en ese depósito
    const max = di === 0 ? 400 : di === 1 ? 120 : 40;
    return int(1, max);
  });
});

// ---- Clientes --------------------------------------------------------------
const BIZ_KIND = ["BODEGA", "ABASTOS", "SUPERMERCADO", "MINIMARKET", "AUTOMERCADO", "DISTRIBUIDORA", "COMERCIAL", "INVERSIONES", "LICORERIA", "PANADERIA", "CAFETIN", "RESTAURANT", "CHARCUTERIA", "KIOSCO", "MAYORISTA"];
const BIZ_NAME = ["EL PORTUGUES", "LA ESQUINA", "SAN JOSE", "LOS ANDES", "EL TRIUNFO", "LA FORTUNA", "EL ROSAL", "LOS TRES HERMANOS", "SANTA ROSA", "LA CANDELARIA", "EL SOL", "BOLIVAR", "EL CAMINO", "LA ECONOMICA", "LAS DELICIAS", "SAN MIGUEL", "LA PERLA", "EL MIRADOR", "PAEZ", "LA GUAIRA", "EL PROGRESO", "LOS GEMELOS", "NUEVA ESPARTA", "LA UNION", "EL BUEN PRECIO", "MARACAY", "LOS ROBLES", "EL TUNAL", "CARABOBO", "LA VICTORIA", "EL CAMPESINO", "LAS MERCEDES", "SAN FELIPE", "EL ARROYO", "LA PRADERA", "AMAZONAS", "EL GUAMO", "TACHIRA", "LOS CORALES", "EL PARAISO", "LA CHINITA", "ANDINA", "LLANERA", "EL DORADO", "COSTA AZUL"];
const SUFFIX = ["C.A.", "S.R.L.", "C.A.", "C.A."];
const clients = [];
const usedNames = new Set();
for (let i = 0; i < 48; i++) {
  let desc;
  do { desc = `${pick(BIZ_KIND)} ${BIZ_NAME[i % BIZ_NAME.length]} ${pick(SUFFIX)}`; } while (usedNames.has(desc));
  usedNames.add(desc);
  const limit = pick([500, 1000, 1500, 2500, 4000, 6000, 10000, 15000, 25000]);
  // Algunos clientes quedan al borde o por encima del límite, para probar la validación de crédito.
  const pct = i % 12 === 0 ? 0.98 : i % 17 === 0 ? 1.05 : rnd() * 0.85;
  clients.push({
    code: "C" + String(i + 1).padStart(5, "0"),
    desc,
    rif: `J-${int(30000000, 31999999)}-${int(0, 9)}`,
    limit,
    saldo: r2(limit * pct),
    active: i % 23 === 22 ? 0 : 1,
  });
}

// ---- Emisión de SQL --------------------------------------------------------
const out = [];
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
out.push(
  "-- Sandbox de Saint: datos de ejemplo (GENERADO, no editar a mano).",
  "-- Regenerar con: node infra/saint-sandbox/tools/gen-seed.mjs",
  `-- Semilla fija ${SEED}; mismo resultado en cada generación. Datos ficticios.`,
  "-- Idempotente: cada tabla se carga solo si está vacía. Para restaurar el estado original usa scripts/saint-sandbox (reset).",
  "",
  "USE SAINT_DEMO;",
  "GO",
  "",
  "SET NOCOUNT ON;",
  "GO",
  ""
);
out.push("IF NOT EXISTS (SELECT 1 FROM dbo.SAINSTA)", "INSERT INTO dbo.SAINSTA (CodInst, Descrip) VALUES");
out.push(CATEGORIES.map(([c, d]) => `  (${q(c)}, ${q(d)})`).join(",\n") + ";", "GO", "");
out.push("IF NOT EXISTS (SELECT 1 FROM dbo.SADEPO)", "INSERT INTO dbo.SADEPO (CodUbic, Descrip) VALUES");
out.push(DEPOTS.map(([c, d]) => `  (${q(c)}, ${q(d)})`).join(",\n") + ";", "GO", "");

out.push("IF NOT EXISTS (SELECT 1 FROM dbo.SAPROD)", "BEGIN");
for (const part of chunks(products, 100)) {
  out.push("INSERT INTO dbo.SAPROD (CodProd, Descrip, CodInst, Costo, Precio1, Precio2, Precio3, Existen, Activo) VALUES");
  out.push(part.map((p) => `  (${q(p.code)}, ${q(p.desc)}, ${q(p.cod)}, ${p.cost.toFixed(4)}, ${p.p1.toFixed(4)}, ${p.p2.toFixed(4)}, ${p.p3.toFixed(4)}, ${p.stock.reduce((a, b) => a + b, 0).toFixed(3)}, ${p.active})`).join(",\n") + ";");
}
out.push("END", "GO", "");

out.push("IF NOT EXISTS (SELECT 1 FROM dbo.SAEXIS)", "BEGIN");
const exis = products.flatMap((p) => DEPOTS.map(([dep], i) => `  (${q(p.code)}, ${q(dep)}, ${p.stock[i].toFixed(3)})`));
for (const part of chunks(exis, 500)) {
  out.push("INSERT INTO dbo.SAEXIS (CodProd, CodUbic, Existen) VALUES", part.join(",\n") + ";");
}
out.push("END", "GO", "");

out.push("IF NOT EXISTS (SELECT 1 FROM dbo.SACLIE)", "INSERT INTO dbo.SACLIE (CodClie, Descrip, ID3, LimiteCred, Saldo, Activo) VALUES");
out.push(clients.map((c) => `  (${q(c.code)}, ${q(c.desc)}, ${q(c.rif)}, ${c.limit.toFixed(2)}, ${c.saldo.toFixed(2)}, ${c.active})`).join(",\n") + ";", "GO", "");

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "init", "02-seed.sql");
writeFileSync(target, out.join("\n"), "utf8");
console.log(`02-seed.sql: ${products.length} productos, ${CATEGORIES.length} categorias, ${DEPOTS.length} depositos, ${clients.length} clientes`);
