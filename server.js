require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const mysql   = require("mysql2/promise");
const path    = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------
// POOL MYSQL
// ✅ SSL desactivado - hosting no lo soporta
// ----------------------
const pool = mysql.createPool({
    host:     process.env.DB_HOST     || "mysql.us.cloudlogin.co",
    port:     process.env.DB_PORT
                ? Number(process.env.DB_PORT)
                : 3306,
    database: process.env.DB_NAME     || "intelliall_apps",
    user:     process.env.DB_USER     || "intelliall_apps",
    password: process.env.DB_PASS     || "426896",
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    ssl:                false          // ✅ FIX
});

// VERIFICAR CONEXIÓN AL INICIAR
pool.getConnection()
    .then(conn => {
        console.log("✅ MySQL conectado correctamente");
        console.log(`📦 BD:   ${process.env.DB_NAME || "intelliall_apps"}`);
        console.log(`🌐 Host: ${process.env.DB_HOST || "mysql.us.cloudlogin.co"}`);
        conn.release();
    })
    .catch(err => {
        console.error("❌ ERROR CONEXIÓN MYSQL:");
        console.error("   Mensaje:", err.message);
        console.error("   Código:",  err.code);
    });

// ----------------------
// QUERY HELPER
// ----------------------
async function query(sql, params){
    const [rows] = await pool.execute(sql, params);
    return rows;
}

// ----------------------
// RUTA TEST
// ----------------------
app.get("/", (req, res) => {
    res.json({
        ok:      true,
        mensaje: "🚀 API funcionando con MySQL",
        config: {
            host:     process.env.DB_HOST     || "mysql.us.cloudlogin.co",
            database: process.env.DB_NAME     || "intelliall_apps",
            user:     process.env.DB_USER     || "intelliall_apps",
            port:     process.env.DB_PORT     || 3306
        }
    });
});

// ----------------------
// PING - Verificar conexión
// ----------------------
app.get("/ping", async (req, res) => {
    try {
        const rows = await query("SELECT 1 AS ok", []);
        res.json({ ok: true, mysql: "✅ Conectado", resultado: rows });
    } catch(err) {
        res.status(500).json({
            ok:     false,
            mysql:  "❌ Sin conexión",
            error:  err.message,
            codigo: err.code
        });
    }
});

// ----------------------
// CONTAR GUÍAS
// ----------------------
app.get("/contar", async (req, res) => {
    try {
        const rows = await query("SELECT COUNT(*) as total FROM guias", []);
        res.json({ ok: true, total: rows[0].total });
    } catch(err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ----------------------
// BUSCAR GUÍAS
// ----------------------
app.get("/buscar", async (req, res) => {
    const q = (req.query.q || "").trim();
    if(!q) return res.json([]);

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

        for(const g of guias){
            g.items = await query(
                "SELECT * FROM guia_items WHERE guia_id = ? ORDER BY linea ASC",
                [g.id]
            );
        }

        res.json(guias);

    } catch(err) {
        console.error("❌ Error búsqueda:", err.message);
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

// ----------------------
// OBTENER GUÍA POR ID
// ----------------------
app.get("/guias/:id", async (req, res) => {
    try {
        const { id } = req.params;

        const guias = await query(
            "SELECT * FROM guias WHERE id = ?", [id]
        );

        if(guias.length === 0){
            return res.status(404).json({
                ok: false, mensaje: "❌ Guía no encontrada"
            });
        }

        const items = await query(
            `SELECT id, guia_id, linea, descripcion, cantidad, unidad
             FROM guia_items
             WHERE guia_id = ?
             ORDER BY linea ASC`,
            [id]
        );

        res.json({ ok: true, ...guias[0], items });

    } catch(err) {
        console.error("❌ Error obteniendo guía:", err.message);
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

// ----------------------
// GUARDAR GUÍA
// ----------------------
app.post("/guardar-guia", async (req, res) => {
    const g = req.body;

    try {
        const existe = await query(
            "SELECT id FROM guias WHERE numero = ?", [g.numero]
        );

        if(existe.length > 0){
            return res.json({
                ok:      false,
                mensaje: `⚠️ La guía ${g.numero} ya fue procesada`
            });
        }

        const result = await pool.execute(`
            INSERT INTO guias
            (numero, fecha_emision, hora_emision, remitente_ruc,
             remitente_nombre, destinatario_nombre, motivo, peso_total,
             direccion_partida, direccion_llegada)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        `, [
            g.numero,
            g.fecha_emision,
            g.hora_emision,
            g.remitente.ruc,
            g.remitente.razon_social,
            g.destinatario.nombre,
            g.traslado.motivo,
            g.traslado.peso_total,
            g.partida.direccion,
            g.llegada.direccion
        ]);

        const guiaId = result[0].insertId;

        for(const item of g.items){
            await pool.execute(`
                INSERT INTO guia_items
                (guia_id, linea, descripcion, cantidad, unidad)
                VALUES (?,?,?,?,?)
            `, [
                guiaId,
                item.linea,
                item.descripcion,
                item.cantidad,
                item.unidad
            ]);
        }

        res.json({
            ok:      true,
            mensaje: `✅ La guía ${g.numero} fue guardada correctamente`
        });

    } catch(err) {
        console.error("❌ Error guardando guía:", err.message);
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

// ----------------------
// HISTORIAL PAGINADO
// ----------------------
app.get("/guias", async (req, res) => {
    const limit  = Math.max(1, parseInt(req.query.limit,  10) || 10);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    try {
        const guias = await query(
            "SELECT * FROM guias ORDER BY id DESC LIMIT ? OFFSET ?",
            [limit, offset]
        );

        console.log(`📋 /guias → ${guias.length} registros`);
        res.json(guias);

    } catch(err) {
        console.error("❌ Error obteniendo guías:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// FALLBACK FRONTEND
// ----------------------
app.use((req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ----------------------
// INICIAR SERVIDOR
// ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`📦 Entorno: ${process.env.NODE_ENV || "development"}`);
});