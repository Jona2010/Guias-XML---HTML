// ----------------------
// CONFIG
// ----------------------
const API_URL = window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "";

// ----------------------
// UBL
// ----------------------
const UBL = {
    cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
};

// ----------------------
// VARIABLES GLOBALES
// ----------------------
let pagina            = 0;
const limite          = 10;
let buscando          = false;
let ultimaGuiaCargada = null;
let hayMasPaginas = true;
let guiaSeleccionadaId = null;

// ── Buscador: control de race conditions ──
let debounceTimer      = null;   // setTimeout del debounce
let busquedaController = null;   // AbortController del fetch activo
let tokenBusqueda      = 0;      // incrementa con cada búsqueda nueva

// ----------------------
// HELPERS XML
// ----------------------
function first(parent, ns, tag){
    if(!parent) return null;
    return parent.getElementsByTagNameNS(ns, tag)[0] || null;
}

function val(parent, ns, tag){
    const e = first(parent, ns, tag);
    return e ? e.textContent.trim() : "";
}

function attr(parent, ns, tag, att){
    const e = first(parent, ns, tag);
    return e ? e.getAttribute(att) || "" : "";
}

// ----------------------
// FETCH JSON SEGURO
// Con soporte para AbortController
// ----------------------
async function fetchJSON(url, options = {}){
    try {
        const res         = await fetch(url, options);
        const contentType = res.headers.get("content-type") || "";

        if(!contentType.includes("application/json")){
            return {
                ok: false, status: res.status, data: null,
                error: `Respuesta inválida (HTTP ${res.status})`
            };
        }

        const data = await res.json();
        return { ok: res.ok, status: res.status, data, error: null };

    } catch(err){
        // Si fue cancelado por AbortController, devolvemos señal especial
        if(err.name === "AbortError"){
            return { ok: false, status: 0, data: null, error: "__ABORTED__" };
        }
        return {
            ok: false, status: 0, data: null,
            error: "❌ No se pudo conectar con el servidor."
        };
    }
}

// ----------------------
// LEER XML
// ----------------------
async function leerGuia(){
    const file = document.getElementById("xmlfile").files[0];
    if(!file){ alert("Selecciona la guía XML"); return; }

    const reader = new FileReader();
    reader.onload = async function(e){
        const xml = new DOMParser().parseFromString(e.target.result, "text/xml");

        let guia           = {};
        guia.numero        = val(xml, UBL.cbc, "ID");
        guia.fecha_emision = val(xml, UBL.cbc, "IssueDate");
        guia.hora_emision  = val(xml, UBL.cbc, "IssueTime");

        const remitente    = first(xml, UBL.cac, "DespatchSupplierParty");
        guia.remitente     = {
            ruc:          val(remitente, UBL.cbc, "ID"),
            razon_social: val(remitente, UBL.cbc, "RegistrationName")
        };

        const destinatario = first(xml, UBL.cac, "DeliveryCustomerParty");
        guia.destinatario  = {
            nombre: val(destinatario, UBL.cbc, "RegistrationName")
        };

        const shipment = first(xml, UBL.cac, "Shipment");
        guia.traslado  = {
            motivo:     val(shipment, UBL.cbc, "HandlingInstructions"),
            peso_total: val(shipment, UBL.cbc, "GrossWeightMeasure")
        };

        const deliveryAddress = first(xml, UBL.cac, "DeliveryAddress");
        const despatchAddress = first(xml, UBL.cac, "DespatchAddress");
        guia.llegada = { direccion: val(deliveryAddress, UBL.cbc, "Line") };
        guia.partida = { direccion: val(despatchAddress,  UBL.cbc, "Line") };

        guia.items = [];
        const lineas = xml.getElementsByTagNameNS(UBL.cac, "DespatchLine");

        for(let i = 0; i < lineas.length; i++){
            const l        = lineas[i];
            const itemNode = first(l, UBL.cac, "Item");

            // 🔥 NUEVO: obtener código de bien
            let codigoBien = "";

            // 1. SellersItemIdentification
            const seller = first(itemNode, UBL.cac, "SellersItemIdentification");
            codigoBien = val(seller, UBL.cbc, "ID");

            // 2. fallback Buyers
            if(!codigoBien){
                const buyer = first(itemNode, UBL.cac, "BuyersItemIdentification");
                codigoBien = val(buyer, UBL.cbc, "ID");
            }

            // 3. fallback Standard
            if(!codigoBien){
                const standard = first(itemNode, UBL.cac, "StandardItemIdentification");
                codigoBien = val(standard, UBL.cbc, "ID");
            }

            const name = itemNode ? val(itemNode, UBL.cbc, "Name")        : "";
            const desc = itemNode ? val(itemNode, UBL.cbc, "Description") : "";

            let descripcion = "";
            if(name && !name.toLowerCase().includes("indicador")){
                descripcion = name;
            } else if(desc && !desc.toLowerCase().includes("indicador")){
                descripcion = desc;
            } else {
                descripcion = val(l, UBL.cbc, "Name")
                           || val(l, UBL.cbc, "Description")
                           || "Item sin descripción";
            }

            guia.items.push({
                linea:       val(l, UBL.cbc, "ID"),
                codigo_bien: codigoBien || null,   // 👈 NUEVO
                descripcion: descripcion,
                cantidad:    val(l, UBL.cbc, "DeliveredQuantity"),
                unidad:      attr(l, UBL.cbc, "DeliveredQuantity", "unitCode")
            });
        }

        console.log(`📄 ${guia.numero} → ${guia.items.length} items`);

        mostrarGuiaBonita(guia);
        await guardarGuia(guia);
        if(!buscando) await mostrarHistorial();
    };
    reader.readAsText(file);
}

// ----------------------
// MOSTRAR GUIA
// ----------------------
function mostrarGuiaBonita(g){
    let html = `
    <div class="guia-card">
        <h3>📄 ${g.numero}</h3>
        <p><b>Fecha:</b> ${formatearFecha(g.fecha_emision)} ${g.hora_emision || ""}</p>
        <p><b>Remitente:</b> ${g.remitente.razon_social} (${g.remitente.ruc})</p>
        <p><b>Destinatario:</b> ${g.destinatario.nombre}</p>
        <hr>
        <p><b>🚚 Motivo de traslado:</b> ${g.traslado.motivo}</p>
        <p><b>⚖️ Peso total:</b> ${g.traslado.peso_total}</p>
        <hr>
        <p><b>📍 Punto de partida:</b> ${g.partida?.direccion || "No disponible"}</p>
        <p><b>📍 Punto de llegada:</b> ${g.llegada?.direccion  || "No disponible"}</p>
        <hr>
        <h4>📦 Items (${g.items.length})</h4>
        <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
            <thead>
                <tr style="background:#1976D2; color:white;">
                    <th style="padding:8px; width:8%;  text-align:center;">#</th>
                    <th style="padding:8px; width:18%;  text-align:center;">Código de Bien</th>
                    <th style="padding:8px; width:62%; text-align:left;">Descripción</th>
                    <th style="padding:8px; width:15%; text-align:center;">Cantidad</th>
                    <th style="padding:8px; width:15%; text-align:center;">Unidad</th>
                </tr>
            </thead>
            <tbody>`;

    if(g.items.length === 0){
        html += `
        <tr>
            <td colspan="4"
                style="padding:20px; text-align:center; color:#999;">
                No hay items registrados
            </td>
        </tr>`;
    } else {
        g.items.forEach((item, idx) => {
            const bg = idx % 2 === 0 ? "#ffffff" : "#f5f5f5";
            html += `
            <tr style="background:${bg};"
                onmouseover="this.style.background='#f1f8ff'"
                onmouseout="this.style.background='${bg}'">

                <td style="padding:8px; border-bottom:1px solid #eee;
                        text-align:center; font-size:13px; vertical-align:middle;">
                    ${item.linea ?? idx + 1}
                </td>

                <td style="
                    padding:8px;
                    border-bottom:1px solid #eee;
                    border-right:1px solid #eee;
                    background:#fafafa;
                    vertical-align:middle;
                ">
                    <span style="
                        font-family:monospace;
                        font-size:11px;
                        color:#1a237e;
                        background:#eef3ff;
                        padding:3px 6px;
                        border-radius:6px;
                        border:1px solid #d6e0ff;
                        display:inline-block;
                        word-break:break-all;
                    ">
                        ${item.codigo_bien || "-"}
                    </span>
                </td>

                <td style="
                    padding:8px;
                    border-bottom:1px solid #eee;
                    font-size:13px;
                    color:#222;
                    font-weight:500;
                    vertical-align:middle;
                ">
                    ${item.descripcion || "-"}
                </td>

                <td style="padding:8px; border-bottom:1px solid #eee;
                        text-align:center; font-size:13px; vertical-align:middle;">
                    ${item.cantidad || "-"}
                </td>

                <td style="padding:8px; border-bottom:1px solid #eee;
                        text-align:center; font-size:13px; vertical-align:middle;">
                    ${item.unidad || "-"}
                </td>

            </tr>`
        });
    }

    html += `</tbody></table></div>`;
    document.getElementById("salida").innerHTML = html;
}

// ----------------------
// GUARDAR EN BD
// ----------------------
async function guardarGuia(g){
    const { data, error } = await fetchJSON(`${API_URL}/guardar-guia`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(g)
    });

    if(error){ mostrarAlerta(error, "error"); return; }

    if(!data.ok){
        mostrarAlerta(
            data.mensaje || `⚠️ La guía ${g.numero} ya fue procesada`,
            "error"
        );
        return;
    }

    mostrarAlerta(`✅ Guía ${g.numero} guardada correctamente`, "success");
}

// ----------------------
// VER GUIA POR ID
// ✅ CORREGIDO: "guia is not defined"
// ----------------------
async function verGuiaPorId(id){
    if(!id){ 
        mostrarAlerta("❌ ID inválido", "error"); 
        return; 
    }

    const requestId = Date.now();

    // 🔴 NUEVA variable para control (NO usar ultimaGuiaCargada aquí)
    verGuiaPorId._lastRequestId = requestId;

    const { ok, data, error } = await fetchJSON(`${API_URL}/guias/${id}`);

    // ✅ evitar respuestas viejas
    if(requestId !== verGuiaPorId._lastRequestId) return;

    if(error){
        mostrarAlerta(error, "error");
        return;
    }

    if(!ok || !data || !data.ok){
        mostrarAlerta(
            data?.mensaje || `⚠️ Guía no encontrada (ID: ${id})`,
            "error"
        );
        return;
    }

    const guia = {
        numero:        data.numero        || "",
        fecha_emision: data.fecha_emision || "",
        hora_emision:  data.hora_emision  || "",
        remitente: {
            ruc:          data.remitente_ruc    || "-",
            razon_social: data.remitente_nombre || "-"
        },
        destinatario: {
            nombre: data.destinatario_nombre || "-"
        },
        traslado: {
            motivo:     data.motivo     || "-",
            peso_total: data.peso_total || "-"
        },
        partida: {
            direccion: data.direccion_partida || ""
        },
        llegada: {
            direccion: data.direccion_llegada || ""
        },
        items: Array.isArray(data.items) ? data.items : []
    };

    // ✅ mostrar
    mostrarGuiaBonita(guia);

    // 🔥 GUARDAR LA GUÍA REAL (PARA EXPORTAR)
    ultimaGuiaCargada = guia;
}

// ----------------------
// HISTORIAL
// ----------------------
async function mostrarHistorial(){

    const textoBuscador = document.getElementById("buscador").value.trim();
    if(textoBuscador) return;

    buscando = false;

    const contHistorial = document.getElementById("historial-lista");
    const contBuscador  = document.getElementById("historial-busqueda");

    contHistorial.style.display = "block";
    contBuscador.style.display  = "none";
    contBuscador.innerHTML      = "";

    contHistorial.innerHTML = `
        <p style="color:#999; text-align:center; padding:10px; font-size:13px;">
            Cargando...
        </p>`;

    const { data, error } = await fetchJSON(
        `${API_URL}/guias?limit=${limite}&offset=${pagina * limite}`
    );

    if(error){
        contHistorial.innerHTML = `
            <p style="color:red; font-size:13px; padding:10px;">${error}</p>`;
        return;
    }

    if(!data || data.length === 0){
        contHistorial.innerHTML = `
            <p style="color:#999; text-align:center; padding:20px; font-size:13px;">
                No hay guías registradas
            </p>`;
        return;
    }

    hayMasPaginas = data.length === limite;

    const inicio = (pagina * limite) + 1;
    const fin    = inicio + data.length - 1;

    let html = `
    <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <thead>
            <tr style="background:#1976D2; color:white; font-size:12px;">
                <th style="padding:8px 6px; width:38%; text-align:left;">N° Guía</th>
                <th style="padding:8px 6px; width:38%; text-align:left;">Cliente</th>
                <th style="padding:8px 6px; width:24%; text-align:center;">Fecha</th>
            </tr>
        </thead>
        <tbody>
    `;

    data.forEach(g => {

        // ✅ FIX: truncar con ellipsis en JS
        const cliente = (g.destinatario_nombre || "-").length > 20
            ? (g.destinatario_nombre || "-").substring(0, 20) + "..."
            : (g.destinatario_nombre || "-");

        html += `
        <tr onclick="seleccionarGuia(this, ${g.id})"
            style="cursor:pointer; border-bottom:1px solid #eee; font-size:12px;">
            <td style="padding:7px 6px; white-space:nowrap;
                       overflow:hidden; text-overflow:ellipsis;">
                📄 ${g.numero}
            </td>
            <td style="padding:7px 6px; color:#555; white-space:nowrap;
                       overflow:hidden; text-overflow:ellipsis;"
                title="${g.destinatario_nombre || ''}">
                ${cliente}
            </td>
            <td style="padding:7px 6px; text-align:center; color:#777;
                       white-space:nowrap;">
                ${formatearFecha(g.fecha_emision)}
            </td>
        </tr>`;
    });

    html += `
        </tbody>
    </table>
    <div style="display:flex; justify-content:space-between; align-items:center;
                padding:8px 4px; margin-top:6px; font-size:12px; color:#888;
                border-top:1px solid #eee;">
        <span>Mostrando ${inicio}–${fin}</span>
        <div style="display:flex; gap:6px; align-items:center;">
            <button onclick="anteriorPagina()"
                ${pagina === 0 ? "disabled" : ""}
                style="padding:4px 10px; border:1px solid #ddd; border-radius:4px;
                       background:${pagina === 0 ? '#f5f5f5' : 'white'};
                       cursor:${pagina === 0 ? 'not-allowed' : 'pointer'};
                       color:${pagina === 0 ? '#bbb' : '#333'};">⬅
            </button>
            <span style="font-weight:bold;">Pág. ${pagina + 1}</span>
            <button onclick="siguientePagina()"
                ${!hayMasPaginas ? "disabled" : ""}
                style="padding:4px 10px; border:1px solid #ddd; border-radius:4px;
                    background:${!hayMasPaginas ? '#f5f5f5' : 'white'};
                    cursor:${!hayMasPaginas ? 'not-allowed' : 'pointer'};
                    color:${!hayMasPaginas ? '#bbb' : '#333'};">
                ➡
            </button>
        </div>
    </div>`;

    contHistorial.innerHTML = html;
}

// ----------------------
// BUSCADOR
// ✅ Ahora muestra también partida/llegada en resultados
// ----------------------
async function filtrarGuias(){

    const input         = document.getElementById("buscador");
    const texto         = input.value.trim();
    const btnLimpiar    = document.getElementById("btn-limpiar");
    const contHistorial = document.getElementById("historial-lista");
    const contBuscador  = document.getElementById("historial-busqueda");

    // 🔹 Mostrar botón limpiar
    if(btnLimpiar){
        btnLimpiar.style.display = texto ? "flex" : "none";
    }

    // 🔹 Si está vacío → volver a historial
    if(!texto){
        buscando = false;
        pagina   = 0;

        contBuscador.style.display  = "none";
        contBuscador.innerHTML      = "";
        contHistorial.style.display = "block";

        await mostrarHistorial();
        return;
    }

    buscando = true;

    // 🔴 CANCELAR búsqueda anterior
    if(busquedaController){
        busquedaController.abort();
    }

    busquedaController = new AbortController();
    const signal = busquedaController.signal;

    // 🔴 TOKEN para evitar sobrescritura
    const currentToken = ++tokenBusqueda;

    contHistorial.style.display = "none";
    contBuscador.style.display  = "block";

    contBuscador.innerHTML = `
        <div style="text-align:center; padding:20px; color:#666;">
            🔍 Buscando "<strong>${texto}</strong>"...
        </div>`;

    const { data, error } = await fetchJSON(
        `${API_URL}/buscar?q=${encodeURIComponent(texto)}`,
        { signal }
    );

    // 🔴 IGNORAR RESPUESTAS VIEJAS
    if(currentToken !== tokenBusqueda) return;

    // 🔴 IGNORAR abort
    if(error === "__ABORTED__") return;

    if(error){
        contBuscador.innerHTML = `<p style="color:red">${error}</p>`;
        return;
    }

    if(!data || data.length === 0){
        contBuscador.innerHTML = `
            <div style="text-align:center; padding:20px;">
                🔍 Sin resultados para "<strong>${texto}</strong>"
            </div>`;
        return;
    }

    const textoLower = texto.toLowerCase();

    let html = `
    <table style="width:100%; border-collapse:collapse;">
        <thead>
            <tr style="background:#1976D2; color:white;">
                <th style="padding:6px;">Guía</th>
                <th style="padding:6px;">Cliente</th>
                <th style="padding:6px;">Items</th>
                <th style="padding:6px;">Partida</th>
                <th style="padding:6px;">Llegada</th>
            </tr>
        </thead>
        <tbody>
    `;

    data.forEach(g => {

        // 🔹 Items separados
        const items = (g.items || []).filter(i =>
            (i.descripcion || "").toLowerCase().includes(textoLower)
        );

        const itemsHTML = items.length
            ? items.slice(0,2).map(i =>
                `<div style="font-size:11px;">
                    📦 ${resaltarTexto(i.descripcion, texto)}
                </div>`
              ).join("")
            : `<span style="color:#ccc;">—</span>`;

        // 🔹 Partida separada
        const partida = g.direccion_partida &&
            g.direccion_partida.toLowerCase().includes(textoLower)
            ? resaltarTexto(g.direccion_partida, texto)
            : `<span style="color:#ccc;">—</span>`;

        // 🔹 Llegada separada
        const llegada = g.direccion_llegada &&
            g.direccion_llegada.toLowerCase().includes(textoLower)
            ? resaltarTexto(g.direccion_llegada, texto)
            : `<span style="color:#ccc;">—</span>`;

        html += `
        <tr onclick="seleccionarGuia(this, ${g.id})"
            style="cursor:pointer; border-bottom:1px solid #eee;">
            
            <td>📄 ${resaltarTexto(g.numero, texto)}</td>
            <td>${g.destinatario_nombre || "-"}</td>
            <td>${itemsHTML}</td>
            <td>🚀 ${partida}</td>
            <td>🏁 ${llegada}</td>

        </tr>`;
    });

    html += `</tbody></table>`;
    contBuscador.innerHTML = html;
}

// ----------------------
// HELPER: Resaltar texto sin regex
// ----------------------
function resaltarTexto(texto, busqueda){
    if(!busqueda || !texto) return String(texto);
    const textoStr    = String(texto);
    const busquedaStr = String(busqueda);
    const posicion    = textoStr.toLowerCase().indexOf(busquedaStr.toLowerCase());
    if(posicion === -1) return textoStr;
    const antes    = textoStr.substring(0, posicion);
    const coincide = textoStr.substring(posicion, posicion + busquedaStr.length);
    const despues  = textoStr.substring(posicion + busquedaStr.length);
    return antes +
        '<mark style="background:#FFF176; padding:1px 2px;' +
        'border-radius:2px; color:#000;">' +
        coincide + '</mark>' + despues;
}

// ----------------------
// FECHAS
// ----------------------
function formatearFecha(fechaISO){
    if(!fechaISO) return "";

    // 🔥 cortar solo la fecha antes de la T
    const fecha = fechaISO.split("T")[0];

    const [year, month, day] = fecha.split("-");
    return `${day}/${month}/${year}`;
}

function formatearHora(fechaISO){
    const fecha = new Date(fechaISO);
    return fecha.toLocaleTimeString("es-PE", {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
}

// ----------------------
// EXPORTAR EXCEL
// ----------------------
async function exportarExcel(){

    const g = ultimaGuiaCargada;

    if(!g){
        alert("Primero selecciona o carga una guía");
        return;
    }

    let rows = [
        ["GUÍA DE REMISIÓN"], [],
        ["Número:",       g.numero],
        ["Fecha:",        formatearFecha(g.fecha_emision)],
        ["Remitente:",    g.remitente.razon_social],
        ["RUC:",          g.remitente.ruc],
        ["Destinatario:", g.destinatario.nombre], [],
        ["Motivo:",       g.traslado.motivo],
        ["Peso:",         g.traslado.peso_total], [],
        ["Partida:",      g.partida.direccion],
        ["Llegada:",      g.llegada.direccion], [],
        ["ITEMS"],
        ["#", "Código", "Descripción", "Cantidad", "Unidad"]
    ];

    // 🔹 Guardar posición donde empieza ITEMS
    const filaHeaderItems = rows.length;

    g.items.forEach((i, idx) => {
        rows.push([
            i.linea || idx + 1,
            i.codigo_bien || "-",
            i.descripcion,
            i.cantidad,
            i.unidad
        ]);
    });

    let ws = XLSX.utils.aoa_to_sheet(rows);

    // 📏 Anchos de columna
    ws["!cols"] = [
        { wch: 5 },   // #
        { wch: 20 },  // código
        { wch: 50 },  // descripción
        { wch: 12 },  // cantidad
        { wch: 10 }   // unidad
    ];

    // 🔥 MERGE título
    ws["!merges"] = [
        { s:{r:0,c:0}, e:{r:0,c:4} }
    ];

    // 🔵 ESTILO TÍTULO
    if(ws["A1"]){
        ws["A1"].s = {
            font: { bold: true, sz: 14 },
            alignment: { horizontal: "center" }
        };
    }

    // 🔵 ESTILO ENCABEZADO ITEMS
    const headerRow = filaHeaderItems; // fila dinámica

    ["A","B","C","D","E"].forEach(col => {
        const cell = ws[`${col}${headerRow}`];
        if(cell){
            cell.s = {
                font: { bold: true, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "1976D2" } },
                alignment: { horizontal: "center" }
            };
        }
    });

    // 🔹 CENTRAR columnas específicas
    for(let i = headerRow + 1; i <= rows.length; i++){
        ["A","B","D","E"].forEach(col => {
            const cell = ws[`${col}${i}`];
            if(cell){
                cell.s = {
                    alignment: { horizontal: "center" }
                };
            }
        });
    }

    // 🔹 BORDES (opcional pero PRO)
    for(let i = headerRow; i <= rows.length; i++){
        ["A","B","C","D","E"].forEach(col => {
            const cell = ws[`${col}${i}`];
            if(cell){
                cell.s = {
                    ...cell.s,
                    border: {
                        top:    { style: "thin" },
                        bottom: { style: "thin" },
                        left:   { style: "thin" },
                        right:  { style: "thin" }
                    }
                };
            }
        });
    }

    let wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Guía");

    XLSX.writeFile(wb, `guia_${g.numero}.xlsx`);
}

// ----------------------
// EXPORTAR PDF
// ----------------------
async function exportarPDF(){
    const contenido = document.getElementById("salida");
    if(!contenido || contenido.innerText.trim().length < 50){
        alert("Primero selecciona o carga una guía"); return;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const canvas  = await html2canvas(contenido, { scale: 3, useCORS: true });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf       = new jsPDF("p", "mm", "a4");
    const pageWidth  = 210;
    const pageHeight = 297;
    const imgWidth   = pageWidth;
    const imgHeight  = canvas.height * imgWidth / canvas.width;
    let heightLeft = imgHeight;
    let position   = 0;
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while(heightLeft > 0){
        position   = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
    }

    const nombre = ultimaGuiaCargada?.numero || "sin_numero";
    pdf.save(`guia_${ultimaGuiaCargada.numero}.pdf`);
}

// ----------------------
// ALERTAS
// ----------------------
function mostrarAlerta(msg, tipo = "info"){
    const div = document.createElement("div");
    div.innerText = msg;
    Object.assign(div.style, {
        position:     "fixed",
        top:          "20px",
        right:        "20px",
        padding:      "14px 22px",
        borderRadius: "10px",
        color:        "white",
        zIndex:       "9999",
        fontWeight:   "bold",
        boxShadow:    "0 4px 12px rgba(0,0,0,0.2)",
        opacity:      "0",
        transition:   "all 0.4s ease",
        background:   tipo === "error" ? "#d32f2f" : "#2e7d32"
    });
    document.body.appendChild(div);
    setTimeout(() => {
        div.style.opacity   = "1";
        div.style.transform = "translateY(0)";
    }, 50);
    setTimeout(() => {
        div.style.opacity   = "0";
        div.style.transform = "translateY(-10px)";
        setTimeout(() => div.remove(), 400);
    }, 3000);
}

// ----------------------
// HANDLE CLICK GUIA
// ----------------------
function handleClickGuia(el, id){
    if(el.dataset.loading === "1") return;
    el.dataset.loading = "1";
    el.style.opacity   = "0.6";
    verGuiaPorId(id);
    setTimeout(() => {
        el.dataset.loading = "0";
        el.style.opacity   = "1";
    }, 500);
}

// ----------------------
// LIMPIAR BÚSQUEDA
// ----------------------
function limpiarBusqueda(){
    const input         = document.getElementById("buscador");
    const btnLimpiar    = document.getElementById("btn-limpiar");
    const contBuscador  = document.getElementById("historial-busqueda");
    const contHistorial = document.getElementById("historial-lista");

    input.value = "";
    buscando    = false;
    pagina      = 0;

    if(btnLimpiar) btnLimpiar.style.display = "none";

    contBuscador.style.display  = "none";
    contBuscador.innerHTML      = "";
    contHistorial.style.display = "block";

    mostrarHistorial();
    input.focus();
}

// ----------------------
// RESALTADO
// ----------------------
function seleccionarGuia(fila, id){

    // 🔴 Quitar selección anterior
    document.querySelectorAll(".fila-activa").forEach(el => {
        el.classList.remove("fila-activa");
    });

    // 🟢 Marcar nueva
    fila.classList.add("fila-activa");

    guiaSeleccionadaId = id;

    // 🔥 cargar guía
    verGuiaPorId(id);
}

// ----------------------
// PAGINACIÓN
// ----------------------
function siguientePagina(){
    if(!hayMasPaginas) return; // 🔥 BLOQUEAR
    pagina++;
    mostrarHistorial();
}
function anteriorPagina(){
    if(pagina > 0){ pagina--; mostrarHistorial(); }
}

// ----------------------
// INIT
// ----------------------
document.addEventListener("DOMContentLoaded", () => {
    const btnLimpiar   = document.getElementById("btn-limpiar");
    const contBuscador = document.getElementById("historial-busqueda");

    if(btnLimpiar)   btnLimpiar.style.display   = "none";
    if(contBuscador) contBuscador.style.display = "none";

    // 🔥 👉 AGREGA ESTO AQUÍ
    const inputBuscador = document.getElementById("buscador");

    if(inputBuscador){
        inputBuscador.addEventListener("input", () => {

            if(debounceTimer){
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                filtrarGuias();
            }, 400);
        });
    }

    // 🔚 FIN DEL AGREGADO

    mostrarHistorial();
});