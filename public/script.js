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
let pagina = 0;
const limite = 10;
let buscando = false; // ✅ Flag para saber si estamos buscando

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
        const res = await fetch(url, options);
        const contentType = res.headers.get("content-type") || "";

        if(!contentType.includes("application/json")){
            return {
                ok: false,
                status: res.status,
                data: null,
                error: `El servidor devolvió una respuesta inválida (HTTP ${res.status})`
            };
        }

        const data = await res.json();
        return { ok: res.ok, status: res.status, data, error: null };

    } catch(err) {
        return {
            ok: false,
            status: 0,
            data: null,
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

        let guia = {};
        guia.numero        = val(xml, UBL.cbc, "ID");
        guia.fecha_emision = val(xml, UBL.cbc, "IssueDate");
        guia.hora_emision  = val(xml, UBL.cbc, "IssueTime");

        const remitente = first(xml, UBL.cac, "DespatchSupplierParty");
        guia.remitente = {
            ruc:          val(remitente, UBL.cbc, "ID"),
            razon_social: val(remitente, UBL.cbc, "RegistrationName")
        };

        const destinatario = first(xml, UBL.cac, "DeliveryCustomerParty");
        guia.destinatario = {
            nombre: val(destinatario, UBL.cbc, "RegistrationName")
        };

        const shipment = first(xml, UBL.cac, "Shipment");
        guia.traslado = {
            motivo:     val(shipment, UBL.cbc, "HandlingInstructions"),
            peso_total: val(shipment, UBL.cbc, "GrossWeightMeasure")
        };

        const deliveryAddress = first(xml, UBL.cac, "DeliveryAddress");
        const despatchAddress  = first(xml, UBL.cac, "DespatchAddress");

        guia.llegada = { direccion: val(deliveryAddress, UBL.cbc, "Line") };
        guia.partida = { direccion: val(despatchAddress,  UBL.cbc, "Line") };

        guia.items = [];
        const lineas = xml.getElementsByTagNameNS(UBL.cac, "DespatchLine");

        for(let i = 0; i < lineas.length; i++){
            const l = lineas[i];
            guia.items.push({
                linea:       val(l, UBL.cbc, "ID"),
                descripcion: val(l, UBL.cbc, "Name"),
                cantidad:    val(l, UBL.cbc, "DeliveredQuantity"),
                unidad:      attr(l, UBL.cbc, "DeliveredQuantity", "unitCode")
            });
        }

        mostrarGuiaBonita(guia);
        await guardarGuia(guia);
        await mostrarHistorial();
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
        <p><b>📍 Punto de partida:</b> ${g.partida?.direccion || "No disponible"}</p>
        <p><b>📍 Punto de llegada:</b> ${g.llegada?.direccion || "No disponible"}</p>
        <hr>
        <h4>📦 Items</h4>
        <table style="width:100%; border-collapse:collapse;">
            <thead>
                <tr style="background:#1976D2; color:white;">
                    <th style="padding:10px; width:5%;">#</th>
                    <th style="padding:10px; width:60%;">Descripción</th>
                    <th style="padding:10px; width:15%;">Cantidad</th>
                    <th style="padding:10px; width:20%;">Unidad</th>
                </tr>
            </thead>
            <tbody>
    `;

    g.items.forEach((i, idx) => {
        const bg = idx % 2 === 0 ? "#ffffff" : "#f5f5f5";
        html += `
            <tr style="background:${bg};">
                <td style="padding:8px 10px; border-bottom:1px solid #eee;">
                    ${i.linea ?? idx + 1}
                </td>
                <td style="padding:8px 10px; border-bottom:1px solid #eee;">
                    ${i.descripcion ?? "-"}
                </td>
                <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:center;">
                    ${i.cantidad ?? "-"}
                </td>
                <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:center;">
                    ${i.unidad ?? "-"}
                </td>
            </tr>
        `;
    });

    html += `</tbody></table></div>`;
    document.getElementById("salida").innerHTML = html;
}

// ----------------------
// GUARDAR EN BD
// ----------------------
async function guardarGuia(g){
    const { data, error } = await fetchJSON(`${API_URL}/guardar-guia`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(g)
    });

    if(error){ mostrarAlerta(error, "error"); return; }

    if(!data.ok){
        mostrarAlerta(data.mensaje || `⚠️ La guía ${g.numero} ya fue procesada`, "error");
        return;
    }

    mostrarAlerta(`✅ Guía ${g.numero} guardada correctamente`, "success");
    await mostrarHistorial();
}

// ----------------------
// VER GUIA POR ID
// ----------------------
async function verGuiaPorId(id){
    if(!id){ mostrarAlerta("❌ ID inválido", "error"); return; }

    const { ok, data, error } = await fetchJSON(`${API_URL}/guias/${id}`);

    if(error){ mostrarAlerta(error, "error"); return; }

    if(!ok || !data.ok){
        mostrarAlerta(data?.mensaje || `⚠️ Guía no encontrada (ID: ${id})`, "error");
        return;
    }

    const g = data;
    const guia = {
        numero:        g.numero,
        fecha_emision: g.fecha_emision,
        hora_emision:  g.hora_emision || "",
        remitente: {
            ruc:          g.remitente_ruc,
            razon_social: g.remitente_nombre
        },
        destinatario: { nombre: g.destinatario_nombre },
        traslado: {
            motivo:     g.motivo,
            peso_total: g.peso_total
        },
        partida: { direccion: g.direccion_partida },
        llegada: { direccion: g.direccion_llegada },
        items:   g.items || []
    };

    mostrarGuiaBonita(guia);
}

// ----------------------
// HISTORIAL DESDE BD
// ✅ Solo se ejecuta si NO estamos buscando
// ----------------------
async function mostrarHistorial(){

    // ✅ Si hay texto en el buscador, no sobreescribir resultados
    const textoBuscador = document.getElementById("buscador").value.trim();
    if(textoBuscador){
        return;
    }

    buscando = false;
    const cont = document.getElementById("historial");

    const { ok, data, error } = await fetchJSON(
        `${API_URL}/guias?limit=${limite}&offset=${pagina * limite}`
    );

    if(error){
        cont.innerHTML = `<p style="color:red;">${error}</p>`;
        return;
    }

    const guias = data;

    if(!guias || guias.length === 0){
        cont.innerHTML = "<p>No hay más guías</p>";
        return;
    }

    const inicio = (pagina * limite) + 1;
    const fin    = inicio + guias.length - 1;

    let html = `
    <div class="historial-wrapper">
    <table class="historial-tabla">
        <thead>
            <tr>
                <th>N° Guía</th>
                <th>Cliente</th>
                <th>Fecha</th>
            </tr>
        </thead>
        <tbody>
    `;

    guias.forEach(g => {
        html += `
        <tr onclick="verGuiaPorId(${g.id})" style="cursor:pointer;">
            <td>📄 ${g.numero}</td>
            <td title="${g.destinatario_nombre || ''}">${g.destinatario_nombre || "-"}</td>
            <td>${formatearFecha(g.fecha_emision)}</td>
        </tr>
        `;
    });

    html += `
        </tbody>
    </table>
    </div>
    <div class="paginacion">
        <div class="paginacion-info">Mostrando ${inicio} - ${fin}</div>
        <div class="paginacion-botones">
            <button onclick="anteriorPagina()"
                ${pagina === 0 ? "disabled" : ""}>⬅ Anterior</button>
            <span>Página ${pagina + 1}</span>
            <button onclick="siguientePagina()">Siguiente ➡</button>
        </div>
    </div>
    `;

    cont.innerHTML = html;
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
// HELPER: Resaltar texto
// ✅ Sin regex - 100% seguro
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
        '<mark style="background:#FFF176; padding:1px 3px;' +
        'border-radius:3px; color:#000;">' +
        coincide + '</mark>' + despues;
}

// ----------------------
// 🔍 BUSCADOR
// ✅ Reemplaza historial completamente
// ----------------------
async function filtrarGuias(){

    const texto = document.getElementById("buscador").value.trim();
    const cont  = document.getElementById("historial");

    // ✅ Mostrar/ocultar botón X
    const btnLimpiar = document.getElementById("btn-limpiar");
    if(btnLimpiar){
        btnLimpiar.style.display = texto ? "flex" : "none";
    }

    // Si vacío → historial normal
    if(!texto){
        buscando = false;
        pagina = 0;
        mostrarHistorial();
        return;
    }

    buscando = true;

    // ✅ Limpiar historial ANTES de mostrar resultados
    cont.innerHTML = `
        <div style="text-align:center; padding:30px; color:#666;">
            <p>🔍 Buscando "<strong>${texto}</strong>"...</p>
        </div>
    `;

    const { data, error } = await fetchJSON(
        `${API_URL}/buscar?q=${encodeURIComponent(texto)}`
    );

    if(error){
        cont.innerHTML = `<p style="color:red;">${error}</p>`;
        return;
    }

    if(!data || data.length === 0){
        cont.innerHTML = `
            <div style="text-align:center; padding:40px; color:#666;">
                <p style="font-size:16px;">
                    🔍 No se encontraron guías con
                    "<strong>${texto}</strong>"
                </p>
                <p style="font-size:13px; margin-top:8px; color:#999;">
                    Busca por: número de guía o descripción de items
                </p>
            </div>
        `;
        return;
    }

    const textoLower = texto.toLowerCase();

    // ✅ Tabla de resultados SIN paginación debajo
    let html = `
        <div style="margin-bottom:12px; padding:12px 15px;
                    background:#e8f5e9; border-radius:8px;
                    border-left:4px solid #4CAF50; font-size:14px;">
            <strong>📊 ${data.length} resultado(s) para: "${texto}"</strong>
        </div>
        <table class="historial-tabla">
            <thead>
                <tr>
                    <th>N° Guía</th>
                    <th>Cliente</th>
                    <th>Fecha</th>
                    <th>Items encontrados</th>
                </tr>
            </thead>
            <tbody>
    `;

    data.forEach(g => {
        const itemsMatch = (g.items || []).filter(i =>
            (i.descripcion || "").toLowerCase().includes(textoLower)
        );

        const itemsCol = itemsMatch.length > 0
            ? `<div style="font-size:12px; color:#1565C0; line-height:1.6;">
                ${itemsMatch.slice(0, 2).map(i => {
                    const desc = i.descripcion.length > 50
                        ? i.descripcion.substring(0, 50) + "..."
                        : i.descripcion;
                    return `📦 ${resaltarTexto(desc, texto)}`;
                }).join("<br>")}
                ${itemsMatch.length > 2
                    ? `<br><em style="color:#999;">+${itemsMatch.length - 2} más</em>`
                    : ""}
               </div>`
            : `<span style="color:#999; font-size:12px;">—</span>`;

        html += `
        <tr onclick="verGuiaPorId(${g.id})" style="cursor:pointer;"
            title="Click para ver detalle">
            <td>📄 ${resaltarTexto(g.numero, texto)}</td>
            <td title="${g.destinatario_nombre || ""}">
                ${g.destinatario_nombre || "-"}
            </td>
            <td>${formatearFecha(g.fecha_emision)}</td>
            <td>${itemsCol}</td>
        </tr>
        `;
    });

    html += `</tbody></table>`;

    // ✅ Reemplaza TODO el contenido del historial
    cont.innerHTML = html;
}

// ----------------------
// EXPORTAR EXCEL
// ----------------------
async function exportarExcel(){
    const { data, error } = await fetchJSON(`${API_URL}/guias`);

    if(error || !data || data.length === 0){
        alert("No hay datos para exportar");
        return;
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
        alert("Primero selecciona o carga una guía");
        return;
    }

    await new Promise(resolve => setTimeout(resolve, 300));

    const canvas  = await html2canvas(contenido, { scale: 3, useCORS: true });
    const imgData = canvas.toDataURL("image/png");

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");

    const pageWidth  = 210;
    const pageHeight = 297;
    const imgWidth   = pageWidth;
    const imgHeight  = canvas.height * imgWidth / canvas.width;

    let heightLeft = imgHeight;
    let position   = 0;

    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while(heightLeft > 0){
        position = heightLeft - imgHeight;
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
    setTimeout(() => { div.style.opacity = "1"; div.style.transform = "translateY(0)"; }, 50);
    setTimeout(() => {
        div.style.opacity = "0";
        div.style.transform = "translateY(-10px)";
        setTimeout(() => div.remove(), 400);
    }, 3000);
}

// ----------------------
// LIMPIAR BÚSQUEDA
// ✅ Oculta la X y vuelve al historial
// ----------------------
function limpiarBusqueda(){
    const input = document.getElementById("buscador");
    const btnLimpiar = document.getElementById("btn-limpiar");

    input.value = "";
    buscando = false;
    pagina = 0;

    // ✅ Ocultar botón X
    if(btnLimpiar) btnLimpiar.style.display = "none";

    mostrarHistorial();
    input.focus();
}

// ----------------------
// PAGINACIÓN
// ----------------------
function siguientePagina(){ pagina++; mostrarHistorial(); }
function anteriorPagina(){ if(pagina > 0){ pagina--; mostrarHistorial(); } }

// ----------------------
// INIT
// ----------------------
document.addEventListener("DOMContentLoaded", () => {

    // ✅ Ocultar X al inicio
    const btnLimpiar = document.getElementById("btn-limpiar");
    if(btnLimpiar) btnLimpiar.style.display = "none";

    mostrarHistorial();
});