require("dotenv").config();

const express = require("express");
const cors    = require("express");
const mysql   = require("mysql2/promise");
const path    = require("path");

const app = require("express")();

app.use(require("cors")());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------
// POOL MYSQL
// ✅ SSL desactivado
// ----------------------
const pool = mysql.createPool({
    host:     process.env.DB_HOST || "mysql.us.cloudlogin.co",
    port:     Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "intelliall_apps",
    user:     process.env.DB_USER || "intelliall_apps",
    password: process.env.DB_PASS || "426896",
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    ssl:                false,
    // ✅ Forzar tipos numéricos correctos
    typeCast: function(field, next){
        if(field.type === "NEWDECIMAL" || field.type === "DECIMAL"){
            return parseFloat(field.string());
        }
        return next();
    }
});

// VERIFICAR CONEXIÓN
pool.getConnection()
    .then(conn => {
        console.log("✅ MySQL conectado");
        console.log(`📦 BD: ${process.env.DB_NAME || "intelliall_apps"}`);
        conn.release();
    })
    .catch(err => {
        console.error("❌ Error MySQL:", err.message, err.code);
    });

// ----------------------
// QUERY HELPER
// ✅ Usa pool.query (no execute) para LIMIT/OFFSET
// ----------------------
async function query(sql, params = []){
    const [rows] = await pool.query(sql, params);
    return rows;
}

// ----------------------
// RUTA TEST
// ----------------------
app.get("/", (req, res) => {
    res.json({
        ok:      true,
        mensaje: "🚀 API funcionando con MySQL",
        host:    process.env.DB_HOST || "mysql.us.cloudlogin.co",
        db:      process.env.DB_NAME || "intelliall_apps"
    });
});

// ----------------------
// PING
// ----------------------
app.get("/ping", async (req, res) => {
    try {
        const rows = await query("SELECT 1 AS ok");
        res.json({ ok: true, mysql: "✅ Conectado", rows });
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
        const rows = await query("SELECT COUNT(*) AS total FROM guias");
        res.json({ ok: true, total: rows[0].total });
    } catch(err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ----------------------
// BUSCAR GUÍAS
// ✅ Ahora incluye partida y llegada
// ----------------------
app.get("/buscar", async (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);

    try {
        const termino = `%${q.toLowerCase()}%`;

        // 🔹 1. Obtener guías que coinciden
        const guias = await query(`
            SELECT DISTINCT g.*
            FROM guias g
            LEFT JOIN guia_items i ON i.guia_id = g.id
            WHERE LOWER(g.numero)            LIKE ?
               OR LOWER(g.direccion_partida) LIKE ?
               OR LOWER(g.direccion_llegada) LIKE ?
               OR LOWER(i.descripcion)       LIKE ?
               OR LOWER(i.codigo_bien)       LIKE ?
            ORDER BY g.id DESC
            LIMIT 50
        `, [termino, termino, termino, termino, termino]);

        if (guias.length === 0) {
            return res.json([]);
        }

        // 🔹 2. Obtener IDs de las guías encontradas
        const ids = guias.map(g => g.id);

        // 🔹 3. Traer TODOS los items de esas guías
        const items = await query(`
            SELECT 
                id,
                guia_id,
                linea,
                codigo_bien,
                descripcion,
                cantidad,
                unidad
            FROM guia_items
            WHERE guia_id IN (${ids.map(() => "?").join(",")})
            ORDER BY guia_id, CAST(linea AS UNSIGNED)
        `, ids);

        // 🔹 4. Agrupar items por guía
        const itemsPorGuia = {};
        items.forEach(i => {
            if (!itemsPorGuia[i.guia_id]) {
                itemsPorGuia[i.guia_id] = [];
            }
            itemsPorGuia[i.guia_id].push(i);
        });

        // 🔹 5. Inyectar items en cada guía
        const resultado = guias.map(g => ({
            ...g,
            items: itemsPorGuia[g.id] || []
        }));

        res.json({
            ok: true,
            data: resultado
        });

    } catch (err) {
        console.error("❌ Error búsqueda:", err.message);
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

        const [result] = await pool.query(`
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

        const guiaId = result.insertId;

        for (const item of g.items) {
            await pool.query(`
                INSERT INTO guia_items 
                (guia_id, linea, codigo_bien, descripcion, cantidad, unidad)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                guiaId,
                item.linea,
                item.codigo_bien,
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
        console.error("❌ Error guardando:", err.message);
        res.status(500).json({ ok: false, mensaje: err.message });
    }
});

// ----------------------
// HISTORIAL PAGINADO
// ✅ FIX PRINCIPAL - pool.query + Number()
// ----------------------
app.get("/guias", async (req, res) => {

    const limit  = Number(Math.max(1, parseInt(req.query.limit,  10) || 10));
    const offset = Number(Math.max(0, parseInt(req.query.offset, 10) || 0));

    try {
        const [guias] = await pool.query(
            "SELECT * FROM guias ORDER BY id DESC LIMIT ? OFFSET ?",
            [limit, offset]
        );

        console.log(`📋 /guias → ${guias.length} registros (L:${limit} O:${offset})`);
        res.json(guias);

    } catch(err) {
        console.error("❌ Error guías:", err.message);
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
// INICIAR
// ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Puerto: ${PORT}`);
    console.log(`📦 Entorno: ${process.env.NODE_ENV || "development"}`);
});