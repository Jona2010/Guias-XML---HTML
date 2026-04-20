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

// VARIABLES
let pagina   = 0;
const limite = 10;
let buscando = false;

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
// HELPER: fetch JSON seguro
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
        return {
            ok: false, status: 0, data: null,
            error: "❌ No se pudo conectar con el servidor."
        };
    }
}

// ----------------------
// LEER XML
// ✅ FIX: descripcion en Item > Description
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
        guia.destinatario  = { nombre: val(destinatario, UBL.cbc, "RegistrationName") };

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
            const l    = lineas[i];
            const item = first(l, UBL.cac, "Item");

            // ✅ Buscar descripción en el orden correcto
            let descripcion = "";
            if(item){
                descripcion = val(item, UBL.cbc, "Description")
                           || val(item, UBL.cbc, "Name")
                           || "";
            }
            if(!descripcion){
                descripcion = val(l, UBL.cbc, "Description")
                           || val(l, UBL.cbc, "Name")
                           || "Sin descripción";
            }

            guia.items.push({
                linea:       val(l, UBL.cbc, "ID"),
                descripcion: descripcion,
                cantidad:    val(l, UBL.cbc, "DeliveredQuantity"),
                unidad:      attr(l, UBL.cbc, "DeliveredQuantity", "unitCode")
            });
        }

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
        <p><b>Fecha:</b> ${formatearFecha(g.fecha_emision)}
           ${g.hora_emision || formatearHora(g.fecha_emision)}</p>
        <p><b>Remitente:</b> ${g.remitente.razon_social} (${g.remitente.ruc})</p>
        <p><b>Destinatario:</b> ${g.destinatario.nombre}</p>
        <hr>
        <p><b>🚚 Motivo de traslado:</b> ${g.traslado.motivo}</p>
        <p><b>⚖️ Peso total:</b> ${g.traslado.peso_total}</p>
        <hr>
        <p><b>📍 Punto de partida:</b> ${g.partida?.direccion  || "No disponible"}</p>
        <p><b>📍 Punto de llegada:</b> ${g.llegada?.direccion  || "No disponible"}</p>
        <hr>
        <h4>📦 Items</h4>
        <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
            <thead>
                <tr style="background:#1976D2; color:white;">
                    <th style="padding:8px; width:8%;  text-align:center;">#</th>
                    <th style="padding:8px; width:62%; text-align:left;">Descripción</th>
                    <th style="padding:8px; width:15%; text-align:center;">Cantidad</th>
                    <th style="padding:8px; width:15%; text-align:center;">Unidad</th>
                </tr>
            </thead>
            <tbody>
    `;

    g.items.forEach((i, idx) => {
        const bg = idx % 2 === 0 ? "#ffffff" : "#f5f5f5";
        html += `
        <tr style="background:${bg};">
            <td style="padding:8px; border-bottom:1px solid #eee;
                       text-align:center; font-size:13px;">
                ${i.linea ?? idx + 1}
            </td>
            <td style="padding:8px; border-bottom:1px solid #eee;
                       word-break:break-word; white-space:normal; font-size:13px;">
                ${i.descripcion ?? "-"}
            </td>
            <td style="padding:8px; border-bottom:1px solid #eee;
                       text-align:center; font-size:13px;">
                ${i.cantidad ?? "-"}
            </td>
            <td style="padding:8px; border-bottom:1px solid #eee;
                       text-align:center; font-size:13px;">
                ${i.unidad ?? "-"}
            </td>
        </tr>`;
    });

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
        mostrarAlerta(data.mensaje || `⚠️ La guía ${g.numero} ya fue procesada`, "error");
        return;
    }

    mostrarAlerta(`✅ Guía ${g.numero} guardada correctamente`, "success");
}

// ----------------------
// VER GUIA POR ID
// ✅ Con debug para ver qué llega
// ----------------------
async function verGuiaPorId(id){
    if(!id){ mostrarAlerta("❌ ID inválido", "error"); return; }

    const { ok, data, error } = await fetchJSON(`${API_URL}/guias/${id}`);
    if(error){ mostrarAlerta(error, "error"); return; }

    if(!ok || !data.ok){
        mostrarAlerta(
            data?.mensaje || `⚠️ Guía no encontrada (ID: ${id})`,
            "error"
        );
        return;
    }

    // ✅ DEBUG — ver qué llega del servidor
    console.log("📦 Items recibidos del servidor:");
    (data.items || []).forEach((i, idx) => {
        console.log(`   ${idx + 1}. linea=${i.linea} | desc="${i.descripcion}" | cant=${i.cantidad} | unidad=${i.unidad}`);
    });

    const g    = data;
    const guia = {
        numero:        g.numero,
        fecha_emision: g.fecha_emision,
        hora_emision:  g.hora_emision || "",
        remitente:     { ruc: g.remitente_ruc, razon_social: g.remitente_nombre },
        destinatario:  { nombre: g.destinatario_nombre },
        traslado:      { motivo: g.motivo, peso_total: g.peso_total },
        partida:       { direccion: g.direccion_partida },
        llegada:       { direccion: g.direccion_llegada },
        items:         g.items || []
    };

    mostrarGuiaBonita(guia);
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
        contHistorial.innerHTML = `<p style="color:red; font-size:13px;">${error}</p>`;
        return;
    }

    const guias = data;

    if(!guias || guias.length === 0){
        contHistorial.innerHTML = `
            <p style="color:#999; text-align:center; padding:20px; font-size:13px;">
                No hay guías registradas
            </p>`;
        return;
    }

    const inicio = (pagina * limite) + 1;
    const fin    = inicio + guias.length - 1;

    let html = `
    <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <thead>
            <tr style="background:#1976D2; color:white; font-size:12px;">
                <th style="padding:8px 6px; width:42%; text-align:left;">N° Guía</th>
                <th style="padding:8px 6px; width:36%; text-align:left;">Cliente</th>
                <th style="padding:8px 6px; width:22%; text-align:center;">Fecha</th>
            </tr>
        </thead>
        <tbody>
    `;

    guias.forEach(g => {
        const cliente = (g.destinatario_nombre || "-").length > 22
            ? (g.destinatario_nombre || "-").substring(0, 22) + "..."
            : (g.destinatario_nombre || "-");

        html += `
        <tr onclick="verGuiaPorId(${g.id})"
            style="cursor:pointer; border-bottom:1px solid #eee; font-size:12px;"
            onmouseover="this.style.background='#e3f2fd'"
            onmouseout="this.style.background='white'">
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
                style="padding:4px 10px; border:1px solid #ddd; border-radius:4px;
                       background:white; cursor:pointer;">➡
            </button>
        </div>
    </div>`;

    contHistorial.innerHTML = html;
}

// ----------------------
// BUSCADOR
// ----------------------
async function filtrarGuias(){

    const texto      = document.getElementById("buscador").value.trim();
    const btnLimpiar = document.getElementById("btn-limpiar");
    const contHistorial = document.getElementById("historial-lista");
    const contBuscador  = document.getElementById("historial-busqueda");

    if(btnLimpiar){
        btnLimpiar.style.display = texto ? "flex" : "none";
    }

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
    contHistorial.style.display = "none";
    contBuscador.style.display  = "block";
    contBuscador.innerHTML = `
        <div style="text-align:center; padding:20px; color:#666; font-size:13px;">
            🔍 Buscando "<strong>${texto}</strong>"...
        </div>`;

    const { data, error } = await fetchJSON(
        `${API_URL}/buscar?q=${encodeURIComponent(texto)}`
    );

    if(error){
        contBuscador.innerHTML = `
            <p style="color:red; padding:10px; font-size:13px;">${error}</p>`;
        return;
    }

    if(!data || data.length === 0){
        contBuscador.innerHTML = `
            <div style="text-align:center; padding:20px; color:#666;">
                <p style="font-size:14px;">
                    🔍 Sin resultados para "<strong>${texto}</strong>"
                </p>
                <p style="font-size:12px; color:#999; margin-top:6px;">
                    Busca por número de guía o descripción de items
                </p>
            </div>`;
        return;
    }

    const textoLower = texto.toLowerCase();

    let html = `
        <div style="padding:8px 10px; margin-bottom:8px; background:#e8f5e9;
                    border-radius:6px; border-left:4px solid #4CAF50; font-size:12px;">
            <strong>📊 ${data.length} resultado(s) para: "${texto}"</strong>
        </div>
        <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
            <thead>
                <tr style="background:#1976D2; color:white; font-size:12px;">
                    <th style="padding:7px 6px; width:35%; text-align:left;">N° Guía</th>
                    <th style="padding:7px 6px; width:28%; text-align:left;">Cliente</th>
                    <th style="padding:7px 6px; width:17%; text-align:center;">Fecha</th>
                    <th style="padding:7px 6px; width:20%; text-align:left;">Items</th>
                </tr>
            </thead>
            <tbody>
    `;

    data.forEach(g => {
        const itemsMatch = (g.items || []).filter(i =>
            (i.descripcion || "").toLowerCase().includes(textoLower)
        );

        const itemsCol = itemsMatch.length > 0
            ? itemsMatch.slice(0, 2).map(i => {
                const desc = (i.descripcion || "").length > 28
                    ? (i.descripcion || "").substring(0, 28) + "..."
                    : (i.descripcion || "");
                return `<div style="font-size:11px; color:#1565C0;
                                    white-space:nowrap; overflow:hidden;
                                    text-overflow:ellipsis;">
                    📦 ${resaltarTexto(desc, texto)}
                </div>`;
              }).join("") +
              (itemsMatch.length > 2
                ? `<div style="font-size:11px; color:#999;">
                    +${itemsMatch.length - 2} más
                   </div>`
                : "")
            : `<span style="color:#ccc; font-size:11px;">—</span>`;

        const cliente = (g.destinatario_nombre || "-").length > 18
            ? (g.destinatario_nombre || "-").substring(0, 18) + "..."
            : (g.destinatario_nombre || "-");

        html += `
        <tr onclick="verGuiaPorId(${g.id})"
            style="cursor:pointer; border-bottom:1px solid #eee; font-size:12px;"
            onmouseover="this.style.background='#e3f2fd'"
            onmouseout="this.style.background='white'">
            <td style="padding:7px 6px; white-space:nowrap;
                       overflow:hidden; text-overflow:ellipsis;">
                📄 ${resaltarTexto(g.numero, texto)}
            </td>
            <td style="padding:7px 6px; color:#555; white-space:nowrap;
                       overflow:hidden; text-overflow:ellipsis;"
                title="${g.destinatario_nombre || ""}">
                ${cliente}
            </td>
            <td style="padding:7px 6px; text-align:center; color:#777;
                       white-space:nowrap;">
                ${formatearFecha(g.fecha_emision)}
            </td>
            <td style="padding:7px 6px;">
                ${itemsCol}
            </td>
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
    const fecha = new Date(fechaISO);
    return fecha.toLocaleDateString("es-PE", {
        day: "2-digit", month: "2-digit", year: "numeric"
    });
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
    const { data, error } = await fetchJSON(`${API_URL}/guias`);
    if(error || !data || data.length === 0){
        alert("No hay datos para exportar"); return;
    }
    const g = data[0];
    let rows = [
        ["GUÍA DE REMISIÓN"], [],
        ["Número:",       g.numero],
        ["Fecha:",        formatearFecha(g.fecha_emision)],
        ["Remitente:",    g.remitente_nombre],
        ["RUC:",          g.remitente_ruc],
        ["Destinatario:", g.destinatario_nombre], [],
        ["Motivo:",       g.motivo],
        ["Peso:",         g.peso_total], [],
        ["Partida:",      g.direccion_partida],
        ["Llegada:",      g.direccion_llegada], [],
        ["ITEMS"],
        ["#", "Descripción", "Cantidad", "Unidad"]
    ];
    (g.items || []).forEach(i => {
        rows.push([i.linea, i.descripcion, i.cantidad, i.unidad]);
    });
    let ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"]   = [{wch:5},{wch:50},{wch:10},{wch:10}];
    ws["!merges"] = [{ s:{r:0,c:0}, e:{r:0,c:3} }];
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
    pdf.save("guia_sunat.pdf");
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
// LIMPIAR BÚSQUEDA
// ----------------------
function limpiarBusqueda(){
    const input      = document.getElementById("buscador");
    const btnLimpiar = document.getElementById("btn-limpiar");
    input.value = "";
    buscando    = false;
    pagina      = 0;
    if(btnLimpiar) btnLimpiar.style.display = "none";
    const contBuscador  = document.getElementById("historial-busqueda");
    const contHistorial = document.getElementById("historial-lista");
    contBuscador.style.display  = "none";
    contBuscador.innerHTML      = "";
    contHistorial.style.display = "block";
    mostrarHistorial();
    input.focus();
}

// ----------------------
// PAGINACIÓN
// ----------------------
function siguientePagina(){ pagina++; mostrarHistorial(); }
function anteriorPagina(){
    if(pagina > 0){ pagina--; mostrarHistorial(); }
}

// ----------------------
// INIT
// ----------------------
document.addEventListener("DOMContentLoaded", () => {
    const btnLimpiar = document.getElementById("btn-limpiar");
    if(btnLimpiar) btnLimpiar.style.display = "none";
    const contBuscador = document.getElementById("historial-busqueda");
    if(contBuscador) contBuscador.style.display = "none";
    mostrarHistorial();
});