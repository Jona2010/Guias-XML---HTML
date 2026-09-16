require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// En local, Express sirve /public.
// En Vercel, public/** se entrega automáticamente desde el CDN.
if (process.env.VERCEL !== "1") {
    app.use(express.static(path.join(__dirname, "public")));
}

// ----------------------
// POOL MYSQL
// Credenciales SOLO por variables de entorno
// ----------------------
const requiredDbEnv = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASS"];
const missingDbEnv = requiredDbEnv.filter((key) => !process.env[key]);

if (missingDbEnv.length) {
    console.warn(`⚠️ Faltan variables de entorno: ${missingDbEnv.join(", ")}`);
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT || 5),
    queueLimit: 0,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ssl: String(process.env.DB_SSL || "false").toLowerCase() === "true"
        ? { rejectUnauthorized: true }
        : undefined,
    typeCast(field, next) {
        if (field.type === "NEWDECIMAL" || field.type === "DECIMAL") {
            const value = field.string();
            return value === null ? null : parseFloat(value);
        }
        return next();
    }
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
// HEALTH CHECK API
// ----------------------
app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        mensaje: "API de Guías SUNAT operativa",
        entorno: process.env.VERCEL === "1" ? "vercel" : "local"
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
// 🔥 BÚSQUEDA COMPLETA + SIN TILDES
// ----------------------
app.get("/buscar", async (req, res) => {
    const q = (req.query.q || "").trim();

    if (!q) {
        return res.json({
            ok: true,
            data: []
        });
    }

    try {

        // Normalizar la búsqueda del usuario
        // Ejemplo:
        // "Multímetro" → "multimetro"
        const termino = q
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .trim();

        const like = `%${termino}%`;

        const guias = await query(`
            SELECT DISTINCT g.*
            FROM guias g

            LEFT JOIN guia_items i
                ON i.guia_id = g.id

            WHERE

                -- NÚMERO DE GUÍA
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    LOWER(g.numero),
                    'á','a'),
                    'é','e'),
                    'í','i'),
                    'ó','o'),
                    'ú','u'
                ) LIKE ?

                OR

                -- REMITENTE
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    LOWER(g.remitente_nombre),
                    'á','a'),
                    'é','e'),
                    'í','i'),
                    'ó','o'),
                    'ú','u'
                ) LIKE ?

                OR

                -- DESTINATARIO
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    LOWER(g.destinatario_nombre),
                    'á','a'),
                    'é','e'),
                    'í','i'),
                    'ó','o'),
                    'ú','u'
                ) LIKE ?

                OR

                -- DIRECCIÓN DE PARTIDA
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    LOWER(g.direccion_partida),
                    'á','a'),
                    'é','e'),
                    'í','i'),
                    'ó','o'),
                    'ú','u'
                ) LIKE ?

                OR

                -- DIRECCIÓN DE LLEGADA
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    LOWER(g.direccion_llegada),
                    'á','a'),
                    'é','e'),
                    'í','i'),
                    'ó','o'),
                    'ú','u'
                ) LIKE ?

                OR

                -- DESCRIPCIÓN DEL PRODUCTO
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    LOWER(i.descripcion),
                    'á','a'),
                    'é','e'),
                    'í','i'),
                    'ó','o'),
                    'ú','u'
                ) LIKE ?

                OR

                -- CÓDIGO DEL BIEN
                REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    LOWER(i.codigo_bien),
                    'á','a'),
                    'é','e'),
                    'í','i'),
                    'ó','o'),
                    'ú','u'
                ) LIKE ?

            ORDER BY
                g.fecha_emision DESC,
                g.id DESC

            LIMIT 100

        `, [
            like,
            like,
            like,
            like,
            like,
            like,
            like
        ]);

        if (guias.length === 0) {
            console.log(`🔎 /buscar "${q}" → 0 resultados`);

            return res.json({
                ok: true,
                data: []
            });
        }

        // IDs encontrados
        const ids = guias.map(g => g.id);

        // Traer todos los items de las guías encontradas
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
            ORDER BY
                guia_id,
                CAST(linea AS UNSIGNED)
        `, ids);

        // Agrupar items por guía
        const itemsPorGuia = {};

        items.forEach(i => {

            if (!itemsPorGuia[i.guia_id]) {
                itemsPorGuia[i.guia_id] = [];
            }

            itemsPorGuia[i.guia_id].push(i);
        });

        // Construir resultado final
        const resultado = guias.map(g => ({
            ...g,
            items: itemsPorGuia[g.id] || []
        }));

        console.log(
            `🔎 /buscar "${q}" → ${resultado.length} resultados`
        );

        res.json({
            ok: true,
            data: resultado
        });

    } catch (err) {

        console.error("❌ Error búsqueda:", err.message);

        res.status(500).json({
            ok: false,
            mensaje: err.message
        });
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
        res.json({
            ok: true,
            data: guias
        });

    } catch(err) {
        console.error("❌ Error guías:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// OBTENER GUÍA POR ID
// 🔥 FIX CRÍTICO
// ----------------------
app.get("/guias/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        const guias = await query(
            "SELECT * FROM guias WHERE id = ?", [id]
        );

        if(guias.length === 0){
            return res.status(404).json({
                ok: false,
                mensaje: "❌ Guía no encontrada"
            });
        }

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
            WHERE guia_id = ?
            ORDER BY CAST(linea AS UNSIGNED) ASC
        `, [id]);

        res.json({
            ok: true,
            data: {
                ...guias[0],
                items
            }
        });

    } catch(err) {
        console.error("❌ Error guía:", err.message);
        res.status(500).json({
            ok: false,
            mensaje: err.message
        });
    }
});

// ----------------------
// BUSCAR POR FECHA
// ----------------------
app.get("/buscar-por-fecha", async (req, res) => {

    const { desde, hasta } = req.query;

    try {

        const [rows] = await pool.query(`
            SELECT *
            FROM guias
            WHERE fecha_emision >= ?
            AND fecha_emision < DATE_ADD(?, INTERVAL 1 DAY)
            ORDER BY fecha_emision DESC
        `, [desde, hasta]);

        console.log("🔎 FILTRO:", desde, hasta);
        console.log("📦 RESULTADOS:", rows.length);

        res.json({
            ok: true,
            data: rows
        });

    } catch (error) {
        console.error(error);

        res.json({
            ok: false,
            mensaje: "Error en servidor"
        });
    }
});

// ----------------------
// BUSCAR POR DIRECCIÓN
// ----------------------
app.get("/buscar-por-direccion", async (req, res) => {
    const { partida, llegada } = req.query;

    try {
        let sql = `
            SELECT g.*
            FROM guias g
            WHERE 1=1
        `;
        const params = [];

        if (partida && partida.trim()) {
            sql += ` AND LOWER(g.direccion_partida) LIKE LOWER(?)`;
            params.push(`%${partida.trim()}%`);
        }

        if (llegada && llegada.trim()) {
            sql += ` AND LOWER(g.direccion_llegada) LIKE LOWER(?)`;
            params.push(`%${llegada.trim()}%`);
        }

        sql += ` ORDER BY g.fecha_emision DESC, g.hora_emision DESC LIMIT 100`;

        const [rows] = await pool.query(sql, params);

        console.log(`🔎 FILTRO DIRECCIÓN: partida="${partida || '—'}" llegada="${llegada || '—'}"`);
        console.log(`📦 RESULTADOS: ${rows.length}`);

        res.json({
            ok: true,
            data: rows
        });

    } catch (error) {
        console.error("❌ Error en búsqueda por dirección:", error.message);
        res.status(500).json({
            ok: false,
            mensaje: error.message
        });
    }
});

// ----------------------
// FALLBACK FRONTEND (solo local)
// En Vercel, public/index.html es servido por el CDN.
// ----------------------
if (process.env.VERCEL !== "1") {
    app.use((req, res) => {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    });
}

// Middleware final de errores
app.use((err, req, res, next) => {
    console.error("❌ Error no controlado:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, mensaje: "Error interno del servidor" });
});

// Vercel detecta el export CommonJS automáticamente.
module.exports = app;

// Ejecución local: npm start
if (require.main === module) {
    const PORT = Number(process.env.PORT || 3000);
    app.listen(PORT, () => {
        console.log(`🚀 http://localhost:${PORT}`);
        console.log(`📦 Entorno: ${process.env.NODE_ENV || "development"}`);
    });
}
