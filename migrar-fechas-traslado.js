require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { DOMParser } = require("@xmldom/xmldom");

// ============================================================
// CONFIGURACIÓN
// ============================================================

// true  = solo revisar, NO modifica MySQL
// false = actualiza la base de datos
const DRY_RUN = false;

const CARPETAS_XML = [
    "C:\\Users\\Odoo\\Documents\\Guias 2024 XML",
    "C:\\Users\\Odoo\\Documents\\Guias 2025 XML",
    "C:\\Users\\Odoo\\Documents\\Guias 2026 XML"
];

// ============================================================
// MYSQL
// ============================================================

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,

    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    connectTimeout: 10000,

    dateStrings: true,

    ssl:
        String(process.env.DB_SSL || "false").toLowerCase() === "true"
            ? { rejectUnauthorized: true }
            : undefined
});

// ============================================================
// NAMESPACES UBL
// ============================================================

const NS = {
    cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
};

// ============================================================
// HELPERS XML
// ============================================================

function firstNS(parent, namespace, name) {
    if (!parent) return null;

    const nodes = parent.getElementsByTagNameNS(namespace, name);

    return nodes.length
        ? nodes[0]
        : null;
}

function textNS(parent, namespace, name) {
    const node = firstNS(parent, namespace, name);

    return node
        ? String(node.textContent || "").trim()
        : "";
}

// ============================================================
// LEER ID Y FECHAS DEL XML
// ============================================================

function leerDatosXML(contenido, archivo) {

    const xml =
        new DOMParser().parseFromString(
            contenido,
            "application/xml"
        );

    const parserErrors =
        xml.getElementsByTagName("parsererror");

    if (parserErrors.length) {
        throw new Error(`XML inválido: ${archivo}`);
    }

    let numero = "";

    // ID principal de DespatchAdvice
    for (const node of Array.from(xml.documentElement.childNodes)) {

        if (
            node.nodeType === 1 &&
            node.localName === "ID" &&
            node.namespaceURI === NS.cbc
        ) {
            numero = String(node.textContent || "").trim();
            break;
        }
    }

    const fechaEmision =
        textNS(
            xml.documentElement,
            NS.cbc,
            "IssueDate"
        );

    const shipment =
        firstNS(
            xml.documentElement,
            NS.cac,
            "Shipment"
        );

    const shipmentStage =
        firstNS(
            shipment,
            NS.cac,
            "ShipmentStage"
        );

    const transitPeriod =
        firstNS(
            shipmentStage,
            NS.cac,
            "TransitPeriod"
        );

    const fechaInicioTraslado =
        textNS(
            transitPeriod,
            NS.cbc,
            "StartDate"
        );

    return {
        numero,
        fecha_emision: fechaEmision || null,
        fecha_inicio_traslado: fechaInicioTraslado || null,
        archivo
    };
}

// ============================================================
// BUSCAR XML RECURSIVAMENTE
// ============================================================

function buscarXMLRecursivo(carpeta) {

    const encontrados = [];

    if (!fs.existsSync(carpeta)) {
        console.warn(`⚠️ Carpeta no encontrada: ${carpeta}`);
        return encontrados;
    }

    const entradas =
        fs.readdirSync(
            carpeta,
            { withFileTypes: true }
        );

    for (const entrada of entradas) {

        const ruta =
            path.join(
                carpeta,
                entrada.name
            );

        if (entrada.isDirectory()) {

            encontrados.push(
                ...buscarXMLRecursivo(ruta)
            );

            continue;
        }

        if (
            entrada.isFile() &&
            path.extname(entrada.name).toLowerCase() === ".xml"
        ) {
            encontrados.push(ruta);
        }
    }

    return encontrados;
}

// ============================================================
// PROCESAR UN XML
// ============================================================

async function procesarXML(archivo, resumen) {

    resumen.xml_leidos++;

    try {

        const contenido =
            fs.readFileSync(
                archivo,
                "utf8"
            );

        const datos =
            leerDatosXML(
                contenido,
                archivo
            );

        if (!datos.numero) {

            resumen.sin_numero++;

            console.log(
                `⚠️ SIN NÚMERO: ${archivo}`
            );

            return;
        }

        if (!datos.fecha_inicio_traslado) {

            resumen.sin_startdate++;

            console.log(
                `⚠️ ${datos.numero} → sin StartDate`
            );

            return;
        }

        const [filas] =
            await pool.query(
                `
                SELECT
                    id,
                    numero,
                    fecha_emision,
                    fecha_inicio_traslado
                FROM guias
                WHERE numero = ?
                LIMIT 1
                `,
                [datos.numero]
            );

        if (!filas.length) {

            resumen.no_encontradas_bd++;

            console.log(
                `❓ ${datos.numero} → no existe en BD`
            );

            return;
        }

        const guiaBD = filas[0];

        if (
            guiaBD.fecha_inicio_traslado ===
            datos.fecha_inicio_traslado
        ) {

            resumen.sin_cambios++;

            console.log(
                `✅ ${datos.numero} → ya correcta: ${datos.fecha_inicio_traslado}`
            );

            return;
        }

        console.log(
            `🔄 ${datos.numero}`
        );

        console.log(
            `   Emisión XML:   ${datos.fecha_emision || "-"}`
        );

        console.log(
            `   Traslado BD:   ${guiaBD.fecha_inicio_traslado || "NULL"}`
        );

        console.log(
            `   Traslado XML:  ${datos.fecha_inicio_traslado}`
        );

        if (DRY_RUN) {

            resumen.pendientes++;

            console.log(
                "   🧪 DRY RUN → no se actualizó"
            );

            return;
        }

        await pool.query(
            `
            UPDATE guias
            SET fecha_inicio_traslado = ?
            WHERE id = ?
            `,
            [
                datos.fecha_inicio_traslado,
                guiaBD.id
            ]
        );

        resumen.actualizadas++;

        console.log(
            "   💾 ACTUALIZADA"
        );

    } catch (error) {

        resumen.errores++;

        console.error(
            `❌ ERROR: ${archivo}`
        );

        console.error(
            `   ${error.message}`
        );
    }
}

// ============================================================
// MAIN
// ============================================================

async function main() {

    console.log("");
    console.log("============================================");
    console.log(" MIGRACIÓN FECHA INICIO DE TRASLADO");
    console.log("============================================");
    console.log(
        `Modo: ${
            DRY_RUN
                ? "🧪 DRY RUN"
                : "💾 ACTUALIZACIÓN REAL"
        }`
    );
    console.log("");

    await pool.query("SELECT 1");

    console.log("✅ Conexión MySQL correcta");
    console.log("");

    let archivosXML = [];

    for (const carpeta of CARPETAS_XML) {

        console.log(
            `📁 Revisando: ${carpeta}`
        );

        archivosXML.push(
            ...buscarXMLRecursivo(carpeta)
        );
    }

    archivosXML =
        [...new Set(archivosXML)];

    console.log("");
    console.log(
        `📄 XML encontrados: ${archivosXML.length}`
    );
    console.log("");

    const resumen = {
        xml_leidos: 0,
        actualizadas: 0,
        pendientes: 0,
        sin_cambios: 0,
        sin_startdate: 0,
        sin_numero: 0,
        no_encontradas_bd: 0,
        errores: 0
    };

    for (
        let i = 0;
        i < archivosXML.length;
        i++
    ) {

        console.log(
            `[${i + 1}/${archivosXML.length}] ${path.basename(archivosXML[i])}`
        );

        await procesarXML(
            archivosXML[i],
            resumen
        );
    }

    console.log("");
    console.log("============================================");
    console.log(" RESUMEN");
    console.log("============================================");

    console.log(
        `XML leídos:               ${resumen.xml_leidos}`
    );

    console.log(
        `Pendientes de actualizar: ${resumen.pendientes}`
    );

    console.log(
        `Actualizadas:              ${resumen.actualizadas}`
    );

    console.log(
        `Ya correctas:              ${resumen.sin_cambios}`
    );

    console.log(
        `Sin StartDate:             ${resumen.sin_startdate}`
    );

    console.log(
        `Sin número:                ${resumen.sin_numero}`
    );

    console.log(
        `No encontradas en BD:      ${resumen.no_encontradas_bd}`
    );

    console.log(
        `Errores:                   ${resumen.errores}`
    );

    console.log("============================================");
    console.log("");

    if (DRY_RUN) {

        console.log(
            "🧪 No se modificó ningún registro."
        );

        console.log(
            "Cuando validemos el resultado cambia DRY_RUN a false."
        );
    }

    await pool.end();
}

// ============================================================
// INICIAR
// ============================================================

main()
    .catch(async error => {

        console.error(
            "❌ Error fatal:",
            error
        );

        try {
            await pool.end();
        } catch {}

        process.exit(1);
    });