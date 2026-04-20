require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, "public")));

// Crear pool conexión MySQL con datos de .env o valores por defecto
const pool = mysql.createPool({
  host: process.env.DB_HOST || "190.237.242.22",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  database: process.env.DB_NAME || "intelliall_apps",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Query helper
async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// Ruta test para verificar que API funciona
app.get("/", (req, res) => {
  res.send("🚀 API funcionando correctamente con MySQL");
});

// Buscar guías por número o items (UNION)
app.get("/buscar", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);

  try {
    const termino = `%${q.toLowerCase()}%`;

    const guias = await query(`
      SELECT DISTINCT g.*
      FROM guias g
      WHERE LOWER(g.numero) LIKE ?

      UNION

      SELECT DISTINCT g.*
      FROM guias g
      INNER JOIN guia_items i ON i.guia_id = g.id
      WHERE LOWER(i.descripcion) LIKE ?

      ORDER BY id DESC
    `, [termino, termino]);

    // Agregar items a cada guía
    for (const g of guias) {
      g.items = await query(
        "SELECT * FROM guia_items WHERE guia_id = ? ORDER BY linea ASC",
        [g.id]
      );
    }

    res.json(guias);
  } catch (err) {
    console.error("❌ Error en búsqueda:", err);
    res.status(500).json({ ok: false, mensaje: "Error realizando búsqueda" });
  }
});

// Obtener guía por id
app.get("/guias/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const guias = await query("SELECT * FROM guias WHERE id = ?", [id]);

    if (guias.length === 0) {
      return res.status(404).json({ ok: false, mensaje: "❌ Guía no encontrada" });
    }

    const items = await query("SELECT * FROM guia_items WHERE guia_id = ? ORDER BY linea ASC", [id]);

    res.json({ ok: true, ...guias[0], items });
  } catch (err) {
    console.error("❌ Error obteniendo guía:", err);
    res.status(500).json({ ok: false, mensaje: "Error obteniendo guía" });
  }
});

// Guardar guía y items
app.post("/guardar-guia", async (req, res) => {
  const g = req.body;
  try {
    // Verificar si ya existe guía
    const existe = await query("SELECT id FROM guias WHERE numero = ?", [g.numero]);

    if (existe.length > 0) {
      return res.json({ ok: false, mensaje: `⚠️ La guía ${g.numero} ya fue procesada` });
    }

    // Insertar guía
    const result = await pool.execute(
      `INSERT INTO guias
      (numero, fecha_emision, hora_emision, remitente_ruc, remitente_nombre,
       destinatario_nombre, motivo, peso_total, direccion_partida, direccion_llegada)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        g.numero,
        g.fecha_emision,
        g.hora_emision,
        g.remitente.ruc,
        g.remitente.razon_social,
        g.destinatario.nombre,
        g.traslado.motivo,
        g.traslado.peso_total,
        g.partida.direccion,
        g.llegada.direccion,
      ]
    );

    const guiaId = result[0].insertId;

    // Insertar items
    for (const item of g.items) {
      await pool.execute(
        `INSERT INTO guia_items (guia_id, linea, descripcion, cantidad, unidad)
        VALUES (?, ?, ?, ?, ?)`,
        [guiaId, item.linea, item.descripcion, item.cantidad, item.unidad]
      );
    }

    res.json({ ok: true, mensaje: `✅ La guía ${g.numero} fue guardada correctamente` });
  } catch (err) {
    console.error("❌ Error guardando guía:", err);
    res.status(500).json({ ok: false, mensaje: "❌ Error guardando guía" });
  }
});

// Obtener historial paginado
app.get("/guias", async (req, res) => {
    
   const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
   const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  try {
    const guias = await query(
    "SELECT * FROM guias ORDER BY id DESC LIMIT ? OFFSET ?",
    [limit, offset]
    );
    res.json(guias);
  } catch (err) {
    console.error("❌ Error obteniendo guías:", err);
    res.json([]);
  }
});

// 👇 fallback SOLO al final
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📦 Entorno: ${process.env.NODE_ENV || "development"}`);
});
