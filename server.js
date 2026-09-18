require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Servir frontend estático tanto en local como en Vercel
app.use(express.static(path.join(__dirname, "public")));

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
    dateStrings: true,
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
                COALESCE(
                    g.fecha_inicio_traslado,
                    g.fecha_emision
                ) DESC,

                g.hora_emision DESC,

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

// ======================================================
// BÚSQUEDA AVANZADA DE GUÍAS
// Producto + partida + llegada + fechas
//
// Ejemplo:
// /buscar-avanzado?producto=multimetro mestek
//     &partida=malaga grenet
//     &llegada=tinajones
//
// La búsqueda del producto trabaja por palabras:
// "multimetro mestek"
//     ↓
// "multimetro" AND "mestek"
//
// Ambas palabras deben existir dentro del mismo item.
// ======================================================
app.get("/buscar-avanzado", async (req, res) => {

    const producto = String(req.query.producto || "").trim();
    const partida  = String(req.query.partida || "").trim();
    const llegada  = String(req.query.llegada || "").trim();
    const desde    = String(req.query.desde || "").trim();
    const hasta    = String(req.query.hasta || "").trim();


    // --------------------------------------------------
    // NORMALIZAR TEXTO
    // Ejemplo:
    // "MULTÍMETRO MESTEK" -> "multimetro mestek"
    // --------------------------------------------------
    const normalizarTexto = (texto) => {
        return String(texto || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    };


    // --------------------------------------------------
    // Si no existe ningún filtro
    // --------------------------------------------------
    if (
        !producto &&
        !partida &&
        !llegada &&
        !desde &&
        !hasta
    ) {
        return res.json({
            ok: true,
            data: [],
            total: 0,
            mensaje: "Ingrese al menos un criterio de búsqueda"
        });
    }


    try {

        const condiciones = [];
        const params = [];


        // ==================================================
        // PRODUCTO
        // ==================================================
        if (producto) {

            const productoNormalizado =
                normalizarTexto(producto);

            const palabrasProducto =
                productoNormalizado
                    .split(" ")
                    .filter(Boolean);


            /*
                Se usa EXISTS para asegurarnos de que:

                multimetro
                +
                mestek

                se encuentren dentro DEL MISMO ITEM.

                No queremos:

                Item 1 -> multimetro
                Item 2 -> mestek

                y que el sistema considere coincidencia.
            */

            const condicionesProducto =
                palabrasProducto.map(() => `

                    REPLACE(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    REPLACE(
                                        LOWER(
                                            CONCAT_WS(
                                                ' ',
                                                i.codigo_bien,
                                                i.descripcion
                                            )
                                        ),
                                        'á','a'
                                    ),
                                    'é','e'
                                ),
                                'í','i'
                            ),
                            'ó','o'
                        ),
                        'ú','u'
                    ) LIKE ?

                `);


            condiciones.push(`

                EXISTS (

                    SELECT 1

                    FROM guia_items i

                    WHERE i.guia_id = g.id

                    AND ${condicionesProducto.join(" AND ")}

                )

            `);


            palabrasProducto.forEach(palabra => {
                params.push(`%${palabra}%`);
            });
        }


        // ==================================================
        // PUNTO DE PARTIDA
        // ==================================================
        if (partida) {

            const partidaNormalizada =
                normalizarTexto(partida);

            condiciones.push(`

                REPLACE(
                    REPLACE(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    LOWER(g.direccion_partida),
                                    'á','a'
                                ),
                                'é','e'
                            ),
                            'í','i'
                        ),
                        'ó','o'
                    ),
                    'ú','u'
                ) LIKE ?

            `);

            params.push(`%${partidaNormalizada}%`);
        }


        // ==================================================
        // PUNTO DE LLEGADA
        // ==================================================
        if (llegada) {

            const llegadaNormalizada =
                normalizarTexto(llegada);

            condiciones.push(`

                REPLACE(
                    REPLACE(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    LOWER(g.direccion_llegada),
                                    'á','a'
                                ),
                                'é','e'
                            ),
                            'í','i'
                        ),
                        'ó','o'
                    ),
                    'ú','u'
                ) LIKE ?

            `);

            params.push(`%${llegadaNormalizada}%`);
        }


        // ==================================================
        // FECHA DESDE
        // ==================================================
        if (desde) {

            condiciones.push(`

                COALESCE(
                    g.fecha_inicio_traslado,
                    g.fecha_emision
                ) >= ?

            `);

            params.push(desde);
        }


        // ==================================================
        // FECHA HASTA
        // ==================================================
        if (hasta) {

            condiciones.push(`

                COALESCE(
                    g.fecha_inicio_traslado,
                    g.fecha_emision
                )
                < DATE_ADD(
                    ?,
                    INTERVAL 1 DAY
                )

            `);

            params.push(hasta);
        }


        // ==================================================
        // CONSULTAR GUÍAS
        // ==================================================
        const sqlGuias = `

            SELECT
                g.*

            FROM guias g

            WHERE
                ${condiciones.join(" AND ")}

            ORDER BY
                COALESCE(
                    g.fecha_inicio_traslado,
                    g.fecha_emision
                ) DESC,

                g.hora_emision DESC,

                g.id DESC

            LIMIT 200

        `;


        const guias =
            await query(sqlGuias, params);


        if (guias.length === 0) {

            console.log(
                "🔎 /buscar-avanzado → 0 resultados",
                {
                    producto,
                    partida,
                    llegada,
                    desde,
                    hasta
                }
            );

            return res.json({
                ok: true,
                data: [],
                total: 0,
                filtros: {
                    producto,
                    partida,
                    llegada,
                    desde,
                    hasta
                }
            });
        }


        // ==================================================
        // OBTENER ITEMS DE LAS GUÍAS ENCONTRADAS
        // ==================================================
        const ids =
            guias.map(g => g.id);


        const placeholders =
            ids.map(() => "?").join(",");


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

            WHERE guia_id IN (${placeholders})

            ORDER BY
                guia_id ASC,
                CAST(linea AS UNSIGNED) ASC

        `, ids);


        // ==================================================
        // AGRUPAR ITEMS POR GUÍA
        // ==================================================
        const itemsPorGuia = {};


        items.forEach(item => {

            if (!itemsPorGuia[item.guia_id]) {
                itemsPorGuia[item.guia_id] = [];
            }

            itemsPorGuia[item.guia_id].push(item);
        });


        // ==================================================
        // PALABRAS DEL PRODUCTO
        // Se utilizarán para identificar qué fila resaltar
        // posteriormente en HTML / PDF.
        // ==================================================
        const palabrasProducto =
            producto
                ? normalizarTexto(producto)
                    .split(" ")
                    .filter(Boolean)
                : [];


        // ==================================================
        // CONSTRUIR RESPUESTA FINAL
        // ==================================================
        const resultado =
            guias.map(guia => {

                const itemsGuia =
                    itemsPorGuia[guia.id] || [];


                // ------------------------------------------
                // Encontrar exactamente los items que
                // provocaron la coincidencia.
                // ------------------------------------------
                const itemsCoincidentes =
                    producto
                        ? itemsGuia.filter(item => {

                            const textoItem =
                                normalizarTexto(
                                    `${item.codigo_bien || ""} ${item.descripcion || ""}`
                                );


                            return palabrasProducto.every(
                                palabra =>
                                    textoItem.includes(palabra)
                            );

                        })
                        : [];


                // ------------------------------------------
                // Cantidad total encontrada
                // ------------------------------------------
                const cantidadCoincidente =
                    itemsCoincidentes.reduce(
                        (total, item) =>
                            total +
                            Number(item.cantidad || 0),
                        0
                    );


                return {

                    ...guia,

                    // Todos los items de la guía
                    items: itemsGuia,

                    // Solo los productos buscados
                    items_coincidentes:
                        itemsCoincidentes,

                    cantidad_coincidencias:
                        itemsCoincidentes.length,

                    cantidad_total_coincidente:
                        cantidadCoincidente

                };

            });


        // ==================================================
        // RESPUESTA
        // ==================================================
        console.log(
            `🔎 /buscar-avanzado → ${resultado.length} guía(s)`,
            {
                producto,
                partida,
                llegada,
                desde,
                hasta
            }
        );


        res.json({

            ok: true,

            total:
                resultado.length,

            filtros: {
                producto,
                partida,
                llegada,
                desde,
                hasta
            },

            data:
                resultado

        });


    } catch (error) {

        console.error(
            "❌ Error /buscar-avanzado:",
            error
        );


        res.status(500).json({

            ok: false,

            mensaje:
                "Error al realizar la búsqueda avanzada",

            error:
                error.message

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

        const [result] =
            await pool.query(
                `
                INSERT INTO guias
                (
                    numero,
                    fecha_emision,
                    hora_emision,
                    fecha_inicio_traslado,
                    remitente_ruc,
                    remitente_nombre,
                    destinatario_nombre,
                    motivo,
                    peso_total,
                    direccion_partida,
                    direccion_llegada
                )
                VALUES
                (
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?
                )
                `,
                [
                    g.numero,

                    g.fecha_emision || null,

                    g.hora_emision || null,

                    g.fecha_inicio_traslado || null,

                    g.remitente.ruc,

                    g.remitente.razon_social,

                    g.destinatario.nombre,

                    g.traslado.motivo,

                    g.traslado.peso_total,

                    g.partida.direccion,

                    g.llegada.direccion
                ]
            );

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
// ----------------------
app.get("/guias", async (req, res) => {

    const limit =
        Number(
            Math.max(
                1,
                parseInt(req.query.limit, 10) || 10
            )
        );

    const offset =
        Number(
            Math.max(
                0,
                parseInt(req.query.offset, 10) || 0
            )
        );


    try {

        // ====================================================
        // TOTAL DE GUÍAS
        // ====================================================
        const [conteo] =
            await pool.query(`
                SELECT COUNT(*) AS total
                FROM guias
            `);


        const total =
            Number(
                conteo[0]?.total || 0
            );


        // ====================================================
        // GUÍAS DE LA PÁGINA ACTUAL
        // ====================================================
        const [guias] =
            await pool.query(
                `
                SELECT *
                    FROM guias

                    ORDER BY
                        COALESCE(
                            fecha_inicio_traslado,
                            fecha_emision
                        ) DESC,

                        CAST(
                            SUBSTRING_INDEX(
                                numero,
                                '-',
                                -1
                            )
                            AS UNSIGNED
                        ) DESC,

                        hora_emision DESC,

                        id DESC

                LIMIT ? OFFSET ?
                `,
                [
                    limit,
                    offset
                ]
            );


        const totalPaginas =
            Math.ceil(
                total / limit
            );


        console.log(
            `📋 /guias → ${guias.length} registros | Total: ${total} | Página: ${
                Math.floor(offset / limit) + 1
            }/${totalPaginas}`
        );


        res.json({

            ok: true,

            data: guias,

            total,

            limit,

            offset,

            totalPaginas

        });


    } catch (err) {

        console.error(
            "❌ Error guías:",
            err.message
        );


        res.status(500).json({

            ok: false,

            error:
                err.message

        });

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

    const {
        desde,
        hasta
    } =
        req.query;


    try {

        const [rows] =
            await pool.query(
                `
                SELECT *
                FROM guias

                WHERE
                    COALESCE(
                        fecha_inicio_traslado,
                        fecha_emision
                    ) >= ?

                AND
                    COALESCE(
                        fecha_inicio_traslado,
                        fecha_emision
                    )
                    < DATE_ADD(
                        ?,
                        INTERVAL 1 DAY
                    )

                ORDER BY
                    COALESCE(
                        fecha_inicio_traslado,
                        fecha_emision
                    ) DESC,

                    hora_emision DESC,

                    id DESC
                `,
                [
                    desde,
                    hasta
                ]
            );


        console.log(
            "🔎 FILTRO:",
            desde,
            hasta
        );


        console.log(
            "📦 RESULTADOS:",
            rows.length
        );


        res.json({
            ok: true,
            data: rows
        });


    } catch (error) {

        console.error(error);


        res.status(500).json({
            ok: false,
            mensaje:
                "Error en servidor"
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

        sql += `
            ORDER BY
                COALESCE(
                    g.fecha_inicio_traslado,
                    g.fecha_emision
                ) DESC,

                g.hora_emision DESC,

                g.id DESC

            LIMIT 100
        `;

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
// FRONTEND
// ----------------------
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
