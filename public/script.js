// ============================================================
// CONFIGURACIÓN
// ============================================================
const API_URL = window.location.hostname === "localhost" ? "http://localhost:3000" : "";

const UBL = {
    cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
};

// ============================================================
// VARIABLES GLOBALES
// ============================================================
let pagina = 0;
const limite = 10;
let buscando = false;
let ultimaGuiaCargada = null;
let hayMasPaginas = true;
let guiaSeleccionadaId = null;
let debounceTimer = null;
let busquedaController = null;
let tokenBusqueda = 0;

// NUEVAS VARIABLES PARA ORDENAMIENTO
let resultadosBusqueda = [];
let textoBusquedaActual = '';
let ordenDireccion = 'desc'; // 'asc' o 'desc'

// ============================================================
// HELPERS XML
// ============================================================
function first(parent, ns, tag) {
    if (!parent) return null;
    return parent.getElementsByTagNameNS(ns, tag)[0] || null;
}
function val(parent, ns, tag) {
    const e = first(parent, ns, tag);
    return e ? e.textContent.trim() : "";
}
function attr(parent, ns, tag, att) {
    const e = first(parent, ns, tag);
    return e ? e.getAttribute(att) || "" : "";
}

// ============================================================
// FETCH SEGURO
// ============================================================
async function fetchJSON(url, options = {}) {
    try {
        const res = await fetch(url, options);
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            return { ok: false, status: res.status, data: null, error: `Respuesta inválida (HTTP ${res.status})` };
        }
        const data = await res.json();
        return { ok: res.ok, status: res.status, data, error: null };
    } catch (err) {
        if (err.name === "AbortError") {
            return { ok: false, status: 0, data: null, error: "__ABORTED__" };
        }
        return { ok: false, status: 0, data: null, error: "❌ No se pudo conectar con el servidor." };
    }
}

// ============================================================
// LEER XML
// ============================================================
async function leerGuia() {
    const file = document.getElementById("xmlfile").files[0];
    if (!file) { mostrarAlerta("Selecciona la guía XML", "error"); return; }

    const reader = new FileReader();
    reader.onload = async function(e) {
        const xml = new DOMParser().parseFromString(e.target.result, "text/xml");

        let guia = {};
        guia.numero = val(xml, UBL.cbc, "ID");
        guia.fecha_emision = val(xml, UBL.cbc, "IssueDate");
        guia.hora_emision = val(xml, UBL.cbc, "IssueTime");

        const remitente = first(xml, UBL.cac, "DespatchSupplierParty");
        guia.remitente = {
            ruc: val(remitente, UBL.cbc, "ID"),
            razon_social: val(remitente, UBL.cbc, "RegistrationName")
        };

        const destinatario = first(xml, UBL.cac, "DeliveryCustomerParty");
        guia.destinatario = {
            nombre: val(destinatario, UBL.cbc, "RegistrationName")
        };

        const shipment = first(xml, UBL.cac, "Shipment");
        guia.traslado = {
            motivo: val(shipment, UBL.cbc, "HandlingInstructions"),
            peso_total: val(shipment, UBL.cbc, "GrossWeightMeasure")
        };

        const deliveryAddress = first(xml, UBL.cac, "DeliveryAddress");
        const despatchAddress = first(xml, UBL.cac, "DespatchAddress");
        guia.llegada = { direccion: val(deliveryAddress, UBL.cbc, "Line") };
        guia.partida = { direccion: val(despatchAddress, UBL.cbc, "Line") };

        guia.items = [];
        const lineas = xml.getElementsByTagNameNS(UBL.cac, "DespatchLine");

        for (let i = 0; i < lineas.length; i++) {
            const l = lineas[i];
            const itemNode = first(l, UBL.cac, "Item");

            let codigoBien = "";
            const seller = first(itemNode, UBL.cac, "SellersItemIdentification");
            codigoBien = val(seller, UBL.cbc, "ID");
            if (!codigoBien) {
                const buyer = first(itemNode, UBL.cac, "BuyersItemIdentification");
                codigoBien = val(buyer, UBL.cbc, "ID");
            }
            if (!codigoBien) {
                const standard = first(itemNode, UBL.cac, "StandardItemIdentification");
                codigoBien = val(standard, UBL.cbc, "ID");
            }

            const name = itemNode ? val(itemNode, UBL.cbc, "Name") : "";
            const desc = itemNode ? val(itemNode, UBL.cbc, "Description") : "";

            let descripcion = "";
            if (name && !name.toLowerCase().includes("indicador")) {
                descripcion = name;
            } else if (desc && !desc.toLowerCase().includes("indicador")) {
                descripcion = desc;
            } else {
                descripcion = val(l, UBL.cbc, "Name") || val(l, UBL.cbc, "Description") || "Item sin descripción";
            }

            guia.items.push({
                linea: val(l, UBL.cbc, "ID"),
                codigo_bien: codigoBien || null,
                descripcion: descripcion,
                cantidad: val(l, UBL.cbc, "DeliveredQuantity"),
                unidad: attr(l, UBL.cbc, "DeliveredQuantity", "unitCode")
            });
        }

        console.log(`📄 ${guia.numero} → ${guia.items.length} items`);
        mostrarGuiaBonita(guia);
        await guardarGuia(guia);
        if (!buscando) await mostrarHistorial();
    };
    reader.readAsText(file);
}

// ============================================================
// MOSTRAR GUÍA (VERSIÓN MEJORADA)
// ============================================================
function mostrarGuiaBonita(g) {
    let html = `
    <div class="guia-card">
        <div class="guia-header">
            <h3>📄 ${g.numero} <small>${formatearFecha(g.fecha_emision)} ${g.hora_emision || ""}</small></h3>
        </div>

        <div class="guia-meta">
            <div class="guia-meta-item">
                <label>Remitente</label>
                <span>${g.remitente.razon_social} (${g.remitente.ruc})</span>
            </div>
            <div class="guia-meta-item">
                <label>Destinatario</label>
                <span>${g.destinatario.nombre}</span>
            </div>
            <div class="guia-meta-item">
                <label>Motivo de traslado</label>
                <span>${g.traslado.motivo || "No especificado"}</span>
            </div>
            <div class="guia-meta-item">
                <label>Peso total</label>
                <span>${g.traslado.peso_total || "0"} kg</span>
            </div>
        </div>

        <div class="guia-direcciones">
            <div class="direccion-block">
                <span class="icon">📍</span>
                <div class="content">
                    <div class="label">Punto de partida</div>
                    <div class="direccion-texto">${g.partida?.direccion || "No disponible"}</div>
                </div>
            </div>
            <div class="direccion-block">
                <span class="icon">🏁</span>
                <div class="content">
                    <div class="label">Punto de llegada</div>
                    <div class="direccion-texto">${g.llegada?.direccion || "No disponible"}</div>
                </div>
            </div>
        </div>

        <div class="guia-items-title">
            <i class="fa-solid fa-box"></i> Items (${g.items.length})
        </div>
        <table class="tabla-items">
            <thead>
                <tr>
                    <th style="width:8%;">#</th>
                    <th style="width:18%;">Código de Bien</th>
                    <th style="width:48%;">Descripción</th>
                    <th style="width:12%;">Cantidad</th>
                    <th style="width:14%;">Unidad</th>
                </tr>
            </thead>
            <tbody>`;

    if (g.items.length === 0) {
        html += `<tr><td colspan="5" style="text-align:center;color:#999;padding:20px;">No hay items registrados</td></tr>`;
    } else {
        g.items.forEach((item, idx) => {
            const bg = idx % 2 === 0 ? "#ffffff" : "#f9fafb";
            html += `
            <tr style="background:${bg};">
                <td style="text-align:center;">${item.linea ?? idx + 1}</td>
                <td>
                    <span class="codigo-bien">${item.codigo_bien || "-"}</span>
                </td>
                <td>${item.descripcion || "-"}</td>
                <td style="text-align:center;">${item.cantidad || "-"}</td>
                <td style="text-align:center;">${item.unidad || "-"}</td>
            </tr>`;
        });
    }

    html += `</tbody></table></div>`;
    document.getElementById("salida").innerHTML = html;
    ultimaGuiaCargada = g;
}

// ============================================================
// GUARDAR EN BD
// ============================================================
async function guardarGuia(g) {
    const { data, error } = await fetchJSON(`${API_URL}/guardar-guia`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(g)
    });

    if (error) { mostrarAlerta(error, "error"); return; }

    if (!data.ok) {
        mostrarAlerta(data.mensaje || `⚠️ La guía ${g.numero} ya fue procesada`, "error");
        return;
    }

    mostrarAlerta(`✅ Guía ${g.numero} guardada correctamente`, "success");
}

// ============================================================
// VER GUIA POR ID
// ============================================================
async function verGuiaPorId(id) {
    if (!id) { mostrarAlerta("❌ ID inválido", "error"); return; }

    const requestId = Date.now();
    verGuiaPorId._lastRequestId = requestId;

    const response = await fetchJSON(`${API_URL}/guias/${id}`);

    if (requestId !== verGuiaPorId._lastRequestId) return;

    if (response.error) { mostrarAlerta(response.error, "error"); return; }

    const payload = response.data;

    if (!payload || !payload.ok || !payload.data) {
        mostrarAlerta(payload?.mensaje || `⚠️ Guía no encontrada (ID: ${id})`, "error");
        return;
    }

    const g = payload.data;

    let items = [];
    if (Array.isArray(g.items)) {
        items = g.items;
    } else if (typeof g.items === "string") {
        try { items = JSON.parse(g.items); } catch (e) { items = []; }
    }

    const guia = {
        numero: g.numero || "",
        fecha_emision: g.fecha_emision || "",
        hora_emision: g.hora_emision || "",
        remitente: {
            ruc: g.remitente_ruc || "-",
            razon_social: g.remitente_nombre || "-"
        },
        destinatario: {
            nombre: g.destinatario_nombre || "-"
        },
        traslado: {
            motivo: g.motivo || "-",
            peso_total: g.peso_total || "-"
        },
        partida: {
            direccion: g.direccion_partida || ""
        },
        llegada: {
            direccion: g.direccion_llegada || ""
        },
        items: items.map((item, idx) => ({
            linea: item.linea || idx + 1,
            codigo_bien: item.codigo_bien || "-",
            descripcion: item.descripcion || "-",
            cantidad: item.cantidad || "-",
            unidad: item.unidad || "-"
        }))
    };

    mostrarGuiaBonita(guia);
    
    // 🔥 CORREGIDO - Marcar la guía como seleccionada en el historial
    actualizarGuiaSeleccionada(id);
}

// ============================================================
// ACTUALIZAR GUÍA SELECCIONADA
// ============================================================
function actualizarGuiaSeleccionada(id) {
    // Remover clase activa de todas las filas
    document.querySelectorAll(".fila-activa").forEach(el => el.classList.remove("fila-activa"));
    
    // Remover estilos de cards
    document.querySelectorAll(".search-result-card").forEach(card => {
        card.style.borderColor = "";
        card.style.boxShadow = "";
        card.style.borderWidth = "1px";
    });
    
    // 🔥 CORREGIDO - Buscar y marcar en la tabla del historial
    const filaTabla = document.querySelector(`.historial-tabla tr[data-id="${id}"]`);
    if (filaTabla) {
        filaTabla.classList.add("fila-activa");
        // Asegurar que la fila sea visible (scroll)
        filaTabla.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    
    // 🔥 CORREGIDO - Marcar card en resultados de búsqueda
    const cards = document.querySelectorAll(".search-result-card");
    cards.forEach(card => {
        // Verificar si la card contiene el ID (usando onclick)
        const onclickAttr = card.getAttribute("onclick");
        if (onclickAttr && onclickAttr.includes(`seleccionarGuia(this, ${id})`)) {
            card.style.borderColor = "var(--primary)";
            card.style.boxShadow = "var(--shadow-hover)";
            card.style.borderWidth = "2px";
        }
    });
    
    // 🔥 NUEVO - Buscar también en el historial-busqueda (resultados de búsqueda en tabla)
    const filaBusqueda = document.querySelector(`#historial-busqueda tr[data-id="${id}"]`);
    if (filaBusqueda) {
        filaBusqueda.classList.add("fila-activa");
    }
}

// ============================================================
// MOSTRAR HISTORIAL
// ============================================================
async function mostrarHistorial() {
    const textoBuscador = document.getElementById("buscador").value.trim();
    if (textoBuscador) return;

    buscando = false;

    const contHistorial = document.getElementById("historial-lista");
    const contBuscador = document.getElementById("historial-busqueda");

    contHistorial.style.display = "block";
    contBuscador.style.display = "none";
    contBuscador.innerHTML = "";

    contHistorial.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Cargando...</p></div>`;

    const { data, error } = await fetchJSON(`${API_URL}/guias?limit=${limite}&offset=${pagina * limite}`);

    if (error) {
        contHistorial.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${error}</p></div>`;
        return;
    }

    if (!data || !data.data) {
        contHistorial.innerHTML = `<div class="empty-state"><i class="fa-regular fa-folder-open"></i><p>No hay guías registradas</p></div>`;
        return;
    }

    const guias = data.data;
    hayMasPaginas = guias.length === limite;

    if (guias.length === 0) {
        contHistorial.innerHTML = `<div class="empty-state"><i class="fa-regular fa-folder-open"></i><p>No hay guías registradas</p></div>`;
        return;
    }

    const inicio = (pagina * limite) + 1;
    const fin = inicio + guias.length - 1;

    let html = `
    <table class="historial-tabla">
        <thead>
            <tr>
                <th style="width:35%;">N° Guía</th>
                <th style="width:40%;">Cliente</th>
                <th style="width:25%;">Fecha</th>
            </tr>
        </thead>
        <tbody>
    `;

    guias.forEach(g => {
        const cliente = g.destinatario_nombre || "—";
        html += `
        <tr data-id="${g.id}" onclick="seleccionarGuia(this, ${g.id})">
            <td><span class="guia-numero">📄 ${g.numero}</span></td>
            <td><span class="guia-cliente" title="${cliente}">${cliente}</span></td>
            <td><span class="guia-fecha">${formatearFecha(g.fecha_emision)}</span></td>
        </tr>`;
    });

    html += `
        </tbody>
    </table>
    <div class="paginacion">
        <span>📄 Mostrando ${inicio}–${fin}</span>
        <div class="paginacion-controls">
            <button class="btn-icon" onclick="anteriorPagina()" ${pagina === 0 ? "disabled" : ""}>
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            <span class="pagina-actual">${pagina + 1}</span>
            <button class="btn-icon" onclick="siguientePagina()" ${!hayMasPaginas ? "disabled" : ""}>
                <i class="fa-solid fa-chevron-right"></i>
            </button>
        </div>
    </div>`;

    contHistorial.innerHTML = html;
}

// ============================================================
// BUSCADOR
// ============================================================
async function filtrarGuias() {
    const input = document.getElementById("buscador");
    const texto = input.value.trim();

    const btnLimpiar = document.getElementById("btn-limpiar");
    const contHistorial = document.getElementById("historial-lista");
    const contBuscador = document.getElementById("historial-busqueda");

    if (btnLimpiar) {
        btnLimpiar.style.display = texto ? "flex" : "none";
    }

    if (!texto) {
        buscando = false;
        pagina = 0;
        contBuscador.style.display = "none";
        contBuscador.innerHTML = "";
        contHistorial.style.display = "block";
        mostrarControlesOrdenamiento(false); // ← AGREGAR ESTA LÍNEA
        await mostrarHistorial();
        return;
    }

    buscando = true;

    if (busquedaController) {
        busquedaController.abort();
    }

    busquedaController = new AbortController();
    const signal = busquedaController.signal;
    const token = ++tokenBusqueda;

    contHistorial.style.display = "none";
    contBuscador.style.display = "block";

    contBuscador.innerHTML = `
        <div class="loading-state">
            <div class="spinner"></div>
            <p>Buscando <strong>"${escapeHtml(texto)}"</strong></p>
        </div>
    `;

    const { data, error } = await fetchJSON(`${API_URL}/buscar?q=${encodeURIComponent(texto)}`, { signal });

    if (token !== tokenBusqueda) return;
    if (error === "__ABORTED__") return;

    if (error) {
        contBuscador.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${error}</p></div>`;
        return;
    }

    if (!data || !data.data || data.data.length === 0) {
        contBuscador.innerHTML = `
            <div class="empty-state">
                <i class="fa-regular fa-face-frown"></i>
                <p>No encontramos resultados para <strong>"${escapeHtml(texto)}"</strong></p>
            </div>
        `;
        return;
    }

    // Ordenar por número de guía (de mayor a menor por defecto)
    const resultados = data.data
        .map(g => ({ ...g, __score: calcularRelevancia(g, texto) }))
        .sort((a, b) => {
            const numA = a.numero || '';
            const numB = b.numero || '';
            return numB.localeCompare(numA); // Mayor a menor por defecto
        });

    renderResultadosBusqueda(resultados, texto);
}

function calcularRelevancia(g, texto) {
    const palabras = normalizarTexto(texto).split(" ").filter(p => p.length > 0);
    let score = 0;

    palabras.forEach(p => {
        if (normalizarTexto(g.numero).includes(p)) score += 100;
        if (normalizarTexto(g.destinatario_nombre).includes(p)) score += 40;
        if (normalizarTexto(g.direccion_partida).includes(p)) score += 25;
        if (normalizarTexto(g.direccion_llegada).includes(p)) score += 25;
        (g.items || []).forEach(item => {
            if (normalizarTexto(item.descripcion).includes(p)) score += 60;
        });
    });

    return score;
}

function normalizarTexto(texto) {
    return (texto || "")
        .toString()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function resaltarTexto(texto, busqueda) {
    if (!busqueda || !texto) return escapeHtml(String(texto));
    const textoStr = String(texto);
    const busquedaEscapada = busqueda.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${busquedaEscapada})`, "gi");
    return textoStr.replace(regex, `<mark>$1</mark>`);
}

function renderResultadosBusqueda(resultados, texto) {
    // Guardar resultados para ordenamiento
    resultadosBusqueda = resultados;
    textoBusquedaActual = texto;

    // Mostrar controles de ordenamiento
    mostrarControlesOrdenamiento(true);
    actualizarBotonesOrden();

    const contenedor = document.getElementById("historial-busqueda");
    let html = "";

    resultados.forEach(g => {
        const palabras = normalizarTexto(texto).split(" ").filter(p => p.length > 0);
        const itemsCoincidentes = (g.items || [])
            .map(item => {
                const desc = normalizarTexto(item.descripcion);
                let coincidencias = 0;
                palabras.forEach(p => { if (desc.includes(p)) coincidencias++; });
                return { ...item, coincidencias };
            })
            .filter(item => item.coincidencias > 0)
            .sort((a, b) => b.coincidencias - a.coincidencias);

        const itemsMostrar = itemsCoincidentes.slice(0, 3);

        html += `
        <div class="search-result-card" onclick="seleccionarGuia(this, ${g.id})">
            <div class="search-card-header">
                <span class="numero">📄 ${resaltarTexto(g.numero, texto)}</span>
                <span class="fecha">${formatearFecha(g.fecha_emision)}</span>
            </div>
            <div class="search-client">
                <i class="fa-regular fa-user"></i>
                <span>${resaltarTexto(g.destinatario_nombre || "—", texto)}</span>
            </div>
            <div class="search-items">
                <strong>📦 Productos encontrados (${itemsCoincidentes.length})</strong>
                ${itemsMostrar.length > 0 ? itemsMostrar.map(item => `
                    <div class="item-match">
                        <i class="fa-regular fa-circle-check"></i>
                        <span>${resaltarTexto(item.descripcion, texto)}</span>
                    </div>
                `).join("") : '<div style="color:#999;font-size:12px;">Sin coincidencias directas</div>'}
                ${itemsCoincidentes.length > 3 ? `<div class="item-more">+${itemsCoincidentes.length - 3} productos más</div>` : ""}
            </div>
            <div class="search-address">
                <div class="addr">
                    <i class="fa-solid fa-location-dot"></i>
                    <span class="text">${g.direccion_partida || "—"}</span>
                </div>
                <div class="addr">
                    <i class="fa-solid fa-flag-checkered"></i>
                    <span class="text">${g.direccion_llegada || "—"}</span>
                </div>
            </div>
        </div>`;
    });

    contenedor.innerHTML = html;
}

// ============================================================
// ORDENAR RESULTADOS DE BÚSQUEDA
// ============================================================
function ordenarResultados() {
    if (resultadosBusqueda.length === 0) return;

    // Cambiar dirección ASC <-> DESC
    ordenDireccion = ordenDireccion === 'asc' ? 'desc' : 'asc';

    // Actualizar botones
    actualizarBotonesOrden();

    // Ordenar resultados por número de guía
    const resultadosOrdenados = [...resultadosBusqueda].sort((a, b) => {
        const numA = a.numero || '';
        const numB = b.numero || '';
        
        if (ordenDireccion === 'asc') {
            return numA.localeCompare(numB); // Ascendente (menor a mayor)
        } else {
            return numB.localeCompare(numA); // Descendente (mayor a menor)
        }
    });

    renderResultadosBusqueda(resultadosOrdenados, textoBusquedaActual);
}

function actualizarBotonesOrden() {
    // Remover clases de todos los botones
    document.querySelectorAll('.btn-orden').forEach(btn => {
        btn.classList.remove('activo-asc', 'activo-desc');
    });

    // Botón toggle de dirección
    const btnToggle = document.getElementById('orden-toggle-btn');
    if (btnToggle) {
        btnToggle.classList.remove('activo-asc', 'activo-desc');
        btnToggle.classList.add(ordenDireccion === 'asc' ? 'activo-asc' : 'activo-desc');
        btnToggle.innerHTML = `<i class="fa-solid ${ordenDireccion === 'asc' ? 'fa-arrow-up-wide-short' : 'fa-arrow-down-wide-short'}"></i> ${ordenDireccion === 'asc' ? 'ASC' : 'DESC'}`;
    }
}

function mostrarControlesOrdenamiento(mostrar) {
    const controls = document.getElementById('orden-controls');
    if (controls) {
        controls.style.display = mostrar ? 'flex' : 'none';
    }
}

// ============================================================
// TOGGLE ORDEN DIRECCIÓN
// ============================================================
function toggleOrdenDireccion() {
    if (resultadosBusqueda.length === 0) return;
    ordenarResultados(); // Cambia ASC <-> DESC
}

// ============================================================
// FECHAS
// ============================================================
function formatearFecha(fechaISO) {
    if (!fechaISO) return "";
    const fecha = fechaISO.split("T")[0];
    const [year, month, day] = fecha.split("-");
    return `${day}/${month}/${year}`;
}

// ============================================================
// SELECCIONAR GUIA
// ============================================================
function seleccionarGuia(fila, id) {
    // 1. Remover clase activa de todo (tabla y cards)
    document.querySelectorAll(".fila-activa").forEach(el => el.classList.remove("fila-activa"));
    document.querySelectorAll(".search-result-card").forEach(card => {
        card.style.borderColor = "";
        card.style.boxShadow = "";
        card.style.borderWidth = "1px";
        card.classList.remove("activa"); // 🔥 NUEVO
    });
    
    // 2. Si es una fila de la tabla, marcarla
    if (fila) {
        // Si es un TR (tabla)
        if (fila.tagName === "TR") {
            fila.classList.add("fila-activa");
        }
        // Si es una card (resultado de búsqueda)
        else if (fila.classList.contains("search-result-card")) {
            fila.style.borderColor = "var(--primary)";
            fila.style.boxShadow = "var(--shadow-hover)";
            fila.style.borderWidth = "2px";
            fila.classList.add("activa"); // 🔥 NUEVO
        }
    }
    
    // 3. Buscar y marcar también la fila correspondiente en la tabla
    const filaTabla = document.querySelector(`.historial-tabla tr[data-id="${id}"]`);
    if (filaTabla) filaTabla.classList.add("fila-activa");
    
    // 4. Guardar ID y cargar guía
    guiaSeleccionadaId = id;
    verGuiaPorId(id);
}

// ============================================================
// PAGINACIÓN
// ============================================================
function siguientePagina() {
    if (!hayMasPaginas) return;
    pagina++;
    mostrarHistorial();
}

function anteriorPagina() {
    if (pagina > 0) { pagina--; mostrarHistorial(); }
}

// ============================================================
// LIMPIAR BÚSQUEDA
// ============================================================
function limpiarBusqueda() {
    const input = document.getElementById("buscador");
    const btnLimpiar = document.getElementById("btn-limpiar");
    const contBuscador = document.getElementById("historial-busqueda");
    const contHistorial = document.getElementById("historial-lista");

    input.value = "";
    buscando = false;
    pagina = 0;
    resultadosBusqueda = []; // ← AGREGAR ESTA LÍNEA
    textoBusquedaActual = ''; // ← AGREGAR ESTA LÍNEA

    if (btnLimpiar) btnLimpiar.style.display = "none";

    contBuscador.style.display = "none";
    contBuscador.innerHTML = "";
    contHistorial.style.display = "block";
    mostrarControlesOrdenamiento(false); // ← AGREGAR ESTA LÍNEA

    mostrarHistorial();
    input.focus();
}

// ============================================================
// FILTRO POR FECHA
// ============================================================
async function filtrarPorFecha() {
    const desde = document.getElementById("fecha-desde").value;
    const hasta = document.getElementById("fecha-hasta").value;

    if (!desde || !hasta) {
        mostrarAlerta("Selecciona ambas fechas", "error");
        return;
    }

    const contHistorial = document.getElementById("historial-lista");
    const contBuscador = document.getElementById("historial-busqueda");

    contHistorial.style.display = "none";
    contBuscador.style.display = "block";

    contBuscador.innerHTML = `
        <div class="loading-state">
            <div class="spinner"></div>
            <p>Filtrando desde ${formatearFecha(desde)} hasta ${formatearFecha(hasta)}</p>
        </div>
    `;

    const { data, error } = await fetchJSON(`${API_URL}/buscar-por-fecha?desde=${desde}&hasta=${hasta}`);

    if (error) {
        contBuscador.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${error}</p></div>`;
        return;
    }

    if (!data || !data.data || data.data.length === 0) {
        contBuscador.innerHTML = `
            <div class="empty-state">
                <i class="fa-regular fa-calendar-xmark"></i>
                <p>Sin resultados en ese rango</p>
            </div>
        `;
        return;
    }

    // Mostrar resultados en tabla
    let html = `
    <table class="historial-tabla">
        <thead>
            <tr>
                <th style="width:35%;">N° Guía</th>
                <th style="width:40%;">Cliente</th>
                <th style="width:25%;">Fecha</th>
            </tr>
        </thead>
        <tbody>
    `;

    data.data.forEach(g => {
        html += `
        <tr data-id="${g.id}" onclick="seleccionarGuia(this, ${g.id})">
            <td><span class="guia-numero">📄 ${g.numero}</span></td>
            <td><span class="guia-cliente">${g.destinatario_nombre || "—"}</span></td>
            <td><span class="guia-fecha">${formatearFecha(g.fecha_emision)}</span></td>
        </tr>`;
    });

    html += `</tbody></table>`;
    contBuscador.innerHTML = html;
}

function limpiarFiltroFecha() {
    document.getElementById("fecha-desde").value = "";
    document.getElementById("fecha-hasta").value = "";
    document.getElementById("historial-busqueda").style.display = "none";
    document.getElementById("historial-lista").style.display = "block";
    mostrarHistorial();
}

// ============================================================
// EXPORTAR EXCEL
// ============================================================
async function exportarExcel() {
    const g = ultimaGuiaCargada;
    if (!g) { mostrarAlerta("Primero selecciona o carga una guía", "error"); return; }

    let rows = [
        ["GUÍA DE REMISIÓN"], [],
        ["Número:", g.numero],
        ["Fecha:", formatearFecha(g.fecha_emision)],
        ["Remitente:", g.remitente.razon_social],
        ["RUC:", g.remitente.ruc],
        ["Destinatario:", g.destinatario.nombre], [],
        ["Motivo:", g.traslado.motivo],
        ["Peso:", g.traslado.peso_total + " kg"], [],
        ["Partida:", g.partida.direccion],
        ["Llegada:", g.llegada.direccion], [],
        ["ITEMS"],
        ["#", "Código", "Descripción", "Cantidad", "Unidad"]
    ];

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
    ws["!cols"] = [
        { wch: 5 }, { wch: 20 }, { wch: 50 }, { wch: 12 }, { wch: 10 }
    ];
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];

    if (ws["A1"]) ws["A1"].s = {
        font: { bold: true, sz: 14 },
        alignment: { horizontal: "center" }
    };

    ["A", "B", "C", "D", "E"].forEach(col => {
        const cell = ws[`${col}${filaHeaderItems}`];
        if (cell) {
            cell.s = {
                font: { bold: true, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "0A5C8C" } },
                alignment: { horizontal: "center" }
            };
        }
    });

    for (let i = filaHeaderItems + 1; i <= rows.length; i++) {
        ["A", "B", "D", "E"].forEach(col => {
            const cell = ws[`${col}${i}`];
            if (cell) {
                cell.s = { alignment: { horizontal: "center" } };
            }
        });
    }

    for (let i = filaHeaderItems; i <= rows.length; i++) {
        ["A", "B", "C", "D", "E"].forEach(col => {
            const cell = ws[`${col}${i}`];
            if (cell) {
                cell.s = {
                    ...cell.s,
                    border: {
                        top: { style: "thin" },
                        bottom: { style: "thin" },
                        left: { style: "thin" },
                        right: { style: "thin" }
                    }
                };
            }
        });
    }

    let wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Guía");
    XLSX.writeFile(wb, `guia_${g.numero}.xlsx`);
    mostrarAlerta(`✅ Excel exportado: guia_${g.numero}.xlsx`, "success");
}

// ============================================================
// EXPORTAR PDF
// ============================================================
async function exportarPDF() {
    const contenido = document.getElementById("salida");
    if (!contenido || contenido.innerText.trim().length < 50) {
        mostrarAlerta("Primero selecciona o carga una guía", "error");
        return;
    }

    await new Promise(resolve => setTimeout(resolve, 300));
    const canvas = await html2canvas(contenido, { scale: 3, useCORS: true });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = 210;
    const pageHeight = 297;
    const imgWidth = pageWidth;
    const imgHeight = canvas.height * imgWidth / canvas.width;
    let heightLeft = imgHeight;
    let position = 0;
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
    }

    const nombre = ultimaGuiaCargada?.numero || "sin_numero";
    pdf.save(`guia_${nombre}.pdf`);
    mostrarAlerta(`✅ PDF exportado: guia_${nombre}.pdf`, "success");
}

// ============================================================
// ALERTAS (TOAST)
// ============================================================
function mostrarAlerta(msg, tipo = "info") {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const div = document.createElement("div");
    div.className = `toast ${tipo}`;
    div.textContent = msg;
    document.body.appendChild(div);

    // Trigger animation
    requestAnimationFrame(() => {
        div.classList.add("show");
    });

    setTimeout(() => {
        div.classList.remove("show");
        setTimeout(() => div.remove(), 400);
    }, 4000);
}

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
    const btnLimpiar = document.getElementById("btn-limpiar");
    const contBuscador = document.getElementById("historial-busqueda");

    if (btnLimpiar) btnLimpiar.style.display = "none";
    if (contBuscador) contBuscador.style.display = "none";

    const inputBuscador = document.getElementById("buscador");
    if (inputBuscador) {
        inputBuscador.addEventListener("input", () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                filtrarGuias();
            }, 400);
        });
    }

    // Mostrar nombre del archivo seleccionado
    const inputFile = document.getElementById("xmlfile");
    const fileName = document.getElementById("file-name");

    if (inputFile) {
        inputFile.addEventListener("change", function() {
            const nombre = this.files[0]?.name || "Ningún archivo seleccionado";
            if (fileName) fileName.textContent = nombre;
        });
    }

    // Filtro por fecha automático
    const fechaDesde = document.getElementById("fecha-desde");
    const fechaHasta = document.getElementById("fecha-hasta");
    if (fechaDesde) fechaDesde.addEventListener("change", filtrarPorFecha);
    if (fechaHasta) fechaHasta.addEventListener("change", filtrarPorFecha);

    // Cargar historial inicial
    mostrarHistorial();
});