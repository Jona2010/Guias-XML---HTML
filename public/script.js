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
// BÚSQUEDA AVANZADA
// ============================================================
let resultadosBusquedaAvanzada = [];
let guiasSeleccionadasAvanzadas = new Set();
let filtrosBusquedaAvanzadaActuales = {};
let busquedaAvanzadaActiva = false;

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

        const fetchOptions = {
            ...options,
            cache: "no-store",
            headers: {
                ...(options.headers || {}),
                "Cache-Control": "no-cache"
            }
        };

        const res = await fetch(url, fetchOptions);

        const contentType =
            res.headers.get("content-type") || "";

        if (!contentType.includes("application/json")) {
            return {
                ok: false,
                status: res.status,
                data: null,
                error: `Respuesta inválida (HTTP ${res.status})`
            };
        }

        const data = await res.json();

        return {
            ok: res.ok,
            status: res.status,
            data,
            error: null
        };

    } catch (err) {

        if (err.name === "AbortError") {
            return {
                ok: false,
                status: 0,
                data: null,
                error: "__ABORTED__"
            };
        }

        console.error("❌ Error fetch:", err);

        return {
            ok: false,
            status: 0,
            data: null,
            error: "❌ No se pudo conectar con el servidor."
        };
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
// MOSTRAR HISTORIAL - CORREGIDO CON ORDENAMIENTO
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

    // 🔥 CORREGIDO: Ordenar por fecha (más reciente primero) y luego por número de guía
    const guiasOrdenadas = [...guias].sort((a, b) => {
        const fechaA = a.fecha_emision || '';
        const fechaB = b.fecha_emision || '';
        
        if (fechaA !== fechaB) {
            return fechaB.localeCompare(fechaA);
        }
        
        const numA = a.numero || '';
        const numB = b.numero || '';
        return numB.localeCompare(numA);
    });

    const inicio = (pagina * limite) + 1;
    const fin = inicio + guiasOrdenadas.length - 1;

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

    guiasOrdenadas.forEach(g => {
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
        .map(g => ({
            ...g,
            __score: calcularRelevancia(g, texto)
        }))
        .sort((a, b) => {
            const fechaA = a.fecha_emision || "";
            const fechaB = b.fecha_emision || "";

            if (fechaA !== fechaB) {
                return fechaB.localeCompare(fechaA);
            }

            return (b.id || 0) - (a.id || 0);
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
// FILTRO POR FECHA - CORREGIDO CON ORDENAMIENTO
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

    // 🔥 CORREGIDO: Ordenar por fecha (más reciente primero) y luego por número de guía
    const guiasOrdenadas = data.data.sort((a, b) => {
        // Primero ordenar por fecha (descendente - más reciente primero)
        const fechaA = a.fecha_emision || '';
        const fechaB = b.fecha_emision || '';
        
        if (fechaA !== fechaB) {
            return fechaB.localeCompare(fechaA);
        }
        
        // Si misma fecha, ordenar por número de guía (descendente)
        const numA = a.numero || '';
        const numB = b.numero || '';
        return numB.localeCompare(numA);
    });

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

    guiasOrdenadas.forEach(g => {
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
// BÚSQUEDA AVANZADA - ABRIR / CERRAR PANEL
// ============================================================
function toggleBusquedaAvanzada() {

    const panel = document.getElementById("panel-busqueda-avanzada");
    const boton = document.getElementById("btn-toggle-avanzada");

    if (!panel || !boton) return;

    const estaAbierto = panel.style.display !== "none";

    panel.style.display = estaAbierto ? "none" : "block";

    boton.classList.toggle("activo", !estaAbierto);
}


// ============================================================
// BÚSQUEDA AVANZADA - EJECUTAR
// ============================================================
async function buscarGuiasAvanzado() {

    const producto = document.getElementById("av-producto")?.value.trim() || "";
    const partida  = document.getElementById("av-partida")?.value.trim() || "";
    const llegada  = document.getElementById("av-llegada")?.value.trim() || "";
    const desde    = document.getElementById("av-desde")?.value || "";
    const hasta    = document.getElementById("av-hasta")?.value || "";

    if (
        !producto &&
        !partida &&
        !llegada &&
        !desde &&
        !hasta
    ) {
        mostrarAlerta(
            "Ingresa al menos un criterio de búsqueda",
            "error"
        );
        return;
    }


    // Validar rango de fechas
    if (desde && hasta && desde > hasta) {
        mostrarAlerta(
            "La fecha desde no puede ser mayor que la fecha hasta",
            "error"
        );
        return;
    }


    busquedaAvanzadaActiva = true;
    buscando = true;

    filtrosBusquedaAvanzadaActuales = {
        producto,
        partida,
        llegada,
        desde,
        hasta
    };


    // Limpiar buscador normal visualmente
    const buscadorNormal =
        document.getElementById("buscador");

    if (buscadorNormal) {
        buscadorNormal.value = "";
    }

    const btnLimpiar =
        document.getElementById("btn-limpiar");

    if (btnLimpiar) {
        btnLimpiar.style.display = "none";
    }

    mostrarControlesOrdenamiento(false);


    // Contenedores
    const historialNormal =
        document.getElementById("historial-lista");

    const historialBusqueda =
        document.getElementById("historial-busqueda");

    const historialAvanzado =
        document.getElementById("historial-avanzado");

    const resumen =
        document.getElementById("resumen-busqueda-avanzada");

    const barraSeleccion =
        document.getElementById("barra-seleccion-guias");


    if (historialNormal) {
        historialNormal.style.display = "none";
    }

    if (historialBusqueda) {
        historialBusqueda.style.display = "none";
        historialBusqueda.innerHTML = "";
    }

    if (historialAvanzado) {
        historialAvanzado.style.display = "block";

        historialAvanzado.innerHTML = `
            <div class="loading-state">
                <div class="spinner"></div>
                <p>Buscando guías...</p>
            </div>
        `;
    }

    if (resumen) {
        resumen.style.display = "none";
    }

    if (barraSeleccion) {
        barraSeleccion.style.display = "none";
    }


    // Construir URL
    const params = new URLSearchParams();

    if (producto) params.set("producto", producto);
    if (partida)  params.set("partida", partida);
    if (llegada)  params.set("llegada", llegada);
    if (desde)    params.set("desde", desde);
    if (hasta)    params.set("hasta", hasta);

    const urlBusqueda =
        `${API_URL}/buscar-avanzado?${params.toString()}&_=${Date.now()}`;

    /*console.log("========================================");
    console.log("🔎 URL BÚSQUEDA AVANZADA:");
    console.log(urlBusqueda);*/

    const response = await fetch(urlBusqueda, {
        method: "GET",
        cache: "no-store",
        headers: {
            "Accept": "application/json"
        }
    });

    /*console.log("🌐 HTTP STATUS:", response.status);*/

    let data;

    try {

        data = await response.json();

    } catch (error) {

        /*console.error(
            "❌ La respuesta no es JSON válido:",
            error
        );*/

        historialAvanzado.innerHTML = `
            <div class="sin-resultados-avanzados">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <strong>Respuesta inválida</strong>
                <span>
                    El servidor no devolvió JSON válido.
                </span>
            </div>
        `;

        return;
    }


    /*console.log("📦 RESPUESTA COMPLETA:", data);
    console.log("📊 TOTAL SERVIDOR:", data?.total);
    console.log(
        "📋 CANTIDAD ARRAY:",
        Array.isArray(data?.data)
            ? data.data.length
            : "NO ES ARRAY"
    );*/


    if (!response.ok) {

        historialAvanzado.innerHTML = `
            <div class="sin-resultados-avanzados">

                <i class="fa-solid fa-triangle-exclamation"></i>

                <strong>Error en la búsqueda</strong>

                <span>
                    ${
                        escapeHtml(
                            data?.mensaje ||
                            data?.error ||
                            `HTTP ${response.status}`
                        )
                    }
                </span>

            </div>
        `;

        return;
    }

    if (
        !data ||
        data.ok !== true ||
        !Array.isArray(data.data)
    ) {

        /*console.error(
            "❌ ESTRUCTURA DE RESPUESTA INCORRECTA:",
            data
        );*/

        historialAvanzado.innerHTML = `
            <div class="sin-resultados-avanzados">

                <i class="fa-solid fa-triangle-exclamation"></i>

                <strong>No se pudo realizar la búsqueda</strong>

            </div>
        `;

        return;
    }


    // ========================================================
    // GUARDAR RESULTADOS RECIBIDOS DEL SERVIDOR
    // ========================================================
    resultadosBusquedaAvanzada = data.data;


    /*console.log(
        "✅ RESULTADOS GUARDADOS EN JS:",
        resultadosBusquedaAvanzada.length
    );


    console.log(
        "✅ PRIMER RESULTADO:",
        resultadosBusquedaAvanzada[0]
    );*/


    // ========================================================
    // LIMPIAR SELECCIÓN ANTERIOR
    // ========================================================
    guiasSeleccionadasAvanzadas.clear();


    // ========================================================
    // RENDERIZAR RESULTADOS
    // ========================================================
    renderResultadosBusquedaAvanzada(
        resultadosBusquedaAvanzada
    );


    // ========================================================
    // ACTUALIZAR RESUMEN
    // ========================================================
    actualizarResumenBusquedaAvanzada();


    // ========================================================
    // ACTUALIZAR BARRA DE SELECCIÓN
    // ========================================================
    actualizarBarraSeleccionAvanzada();
}


// ============================================================
// RENDER RESULTADOS BÚSQUEDA AVANZADA
// ============================================================
function renderResultadosBusquedaAvanzada(guias) {

    const contenedor =
        document.getElementById("historial-avanzado");

    if (!contenedor) return;


    if (!guias || guias.length === 0) {

        contenedor.innerHTML = `
            <div class="sin-resultados-avanzados">

                <i class="fa-regular fa-folder-open"></i>

                <strong>
                    No se encontraron guías
                </strong>

                <span>
                    Prueba cambiando alguno de los criterios.
                </span>

            </div>
        `;

        return;
    }


    const productoBuscado =
        filtrosBusquedaAvanzadaActuales.producto || "";


    let html = "";


    guias.forEach(g => {

        const seleccionada =
            guiasSeleccionadasAvanzadas.has(Number(g.id));


        const coincidencias =
            Array.isArray(g.items_coincidentes)
                ? g.items_coincidentes
                : [];


        html += `

        <div
            class="guia-avanzada-card
                ${seleccionada ? "seleccionada" : ""}"
            data-id="${g.id}"
        >

            <div class="guia-avanzada-selector">

                <input
                    type="checkbox"
                    class="checkbox-guia-avanzada"
                    data-id="${g.id}"
                    ${seleccionada ? "checked" : ""}
                >


                <div
                    class="guia-avanzada-contenido"
                    data-ver-guia="${g.id}"
                >

                    <div class="guia-avanzada-header">

                        <span class="guia-avanzada-numero">
                            📄 ${escapeHtml(g.numero || "Sin número")}
                        </span>

                        <span class="guia-avanzada-fecha">
                            ${formatearFecha(g.fecha_emision)}
                        </span>

                    </div>


                    <div class="search-client">

                        <i class="fa-regular fa-user"></i>

                        <span>
                            ${escapeHtml(
                                g.destinatario_nombre || "—"
                            )}
                        </span>

                    </div>


                    <div class="guia-avanzada-ruta">

                        <div class="guia-avanzada-ruta-item">

                            <i class="fa-solid fa-location-dot"></i>

                            <span>
                                ${escapeHtml(
                                    g.direccion_partida || "—"
                                )}
                            </span>

                        </div>


                        <div class="guia-avanzada-ruta-item">

                            <i class="fa-solid fa-flag-checkered"></i>

                            <span>
                                ${escapeHtml(
                                    g.direccion_llegada || "—"
                                )}
                            </span>

                        </div>

                    </div>


                    ${
                        productoBuscado
                        ? `
                        <div class="coincidencias-avanzadas">

                            <div class="coincidencias-avanzadas-titulo">

                                <i class="fa-solid fa-highlighter"></i>

                                Coincidencia${
                                    coincidencias.length !== 1
                                        ? "s"
                                        : ""
                                } (${coincidencias.length})

                            </div>


                            ${
                                coincidencias.length > 0

                                ? coincidencias
                                    .map(item => `

                                        <div class="item-coincidente-avanzado">

                                            <strong>
                                                ${
                                                    resaltarPalabrasAvanzado(
                                                        item.descripcion || "—",
                                                        productoBuscado
                                                    )
                                                }
                                            </strong>

                                            <div class="item-coincidente-meta">

                                                <span>
                                                    Cantidad:
                                                    ${
                                                        escapeHtml(
                                                            String(
                                                                item.cantidad ?? "—"
                                                            )
                                                        )
                                                    }
                                                </span>

                                                <span>
                                                    Unidad:
                                                    ${
                                                        escapeHtml(
                                                            String(
                                                                item.unidad || "—"
                                                            )
                                                        )
                                                    }
                                                </span>

                                            </div>

                                        </div>

                                    `)
                                    .join("")

                                : `
                                    <div
                                        style="
                                            color:#94a3b8;
                                            font-size:11px;
                                        "
                                    >
                                        Sin coincidencia de producto
                                    </div>
                                `
                            }

                        </div>
                        `
                        : ""
                    }

                </div>

            </div>

        </div>

        `;
    });


    contenedor.innerHTML = html;


    // ========================================================
    // EVENTOS DE CHECKBOX
    // ========================================================
    contenedor
        .querySelectorAll(".checkbox-guia-avanzada")
        .forEach(checkbox => {

            checkbox.addEventListener("change", event => {

                event.stopPropagation();

                const id =
                    Number(event.currentTarget.dataset.id);

                cambiarSeleccionGuiaAvanzada(
                    id,
                    event.currentTarget.checked
                );

            });

        });


    // ========================================================
    // CLICK SOBRE INFORMACIÓN DE LA GUÍA
    // Abre la guía en el visor
    // ========================================================
    contenedor
        .querySelectorAll("[data-ver-guia]")
        .forEach(elemento => {

            elemento.addEventListener("click", () => {

                const id =
                    Number(elemento.dataset.verGuia);

                verGuiaPorId(id);

            });

        });
}


// ============================================================
// RESALTAR PALABRAS DE LA BÚSQUEDA
// Ejemplo:
// multimetro mestek
// ============================================================
function resaltarPalabrasAvanzado(texto, busqueda) {

    let resultado =
        escapeHtml(String(texto || ""));


    const palabras =
        normalizarTexto(busqueda)
            .split(" ")
            .filter(Boolean);


    palabras.forEach(palabra => {

        const escapada =
            palabra.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            );


        const regex =
            new RegExp(
                `(${escapada})`,
                "gi"
            );


        resultado =
            resultado.replace(
                regex,
                "<mark>$1</mark>"
            );

    });


    return resultado;
}


// ============================================================
// SELECCIONAR / DESELECCIONAR UNA GUÍA
// ============================================================
function cambiarSeleccionGuiaAvanzada(
    id,
    seleccionada
) {

    id = Number(id);


    if (seleccionada) {

        guiasSeleccionadasAvanzadas.add(id);

    } else {

        guiasSeleccionadasAvanzadas.delete(id);

    }


    const card =
        document.querySelector(
            `.guia-avanzada-card[data-id="${id}"]`
        );


    if (card) {

        card.classList.toggle(
            "seleccionada",
            seleccionada
        );

    }


    actualizarBarraSeleccionAvanzada();
}


// ============================================================
// SELECCIONAR TODAS
// ============================================================
function seleccionarTodasGuiasAvanzadas(
    seleccionar
) {

    guiasSeleccionadasAvanzadas.clear();


    if (seleccionar) {

        resultadosBusquedaAvanzada.forEach(g => {

            guiasSeleccionadasAvanzadas.add(
                Number(g.id)
            );

        });

    }


    document
        .querySelectorAll(".checkbox-guia-avanzada")
        .forEach(checkbox => {

            checkbox.checked =
                seleccionar;

        });


    document
        .querySelectorAll(".guia-avanzada-card")
        .forEach(card => {

            card.classList.toggle(
                "seleccionada",
                seleccionar
            );

        });


    actualizarBarraSeleccionAvanzada();
}


// ============================================================
// ACTUALIZAR BARRA DE SELECCIÓN
// ============================================================
function actualizarBarraSeleccionAvanzada() {

    const barra =
        document.getElementById("barra-seleccion-guias");

    const contador =
        document.getElementById("contador-seleccionadas");

    const seleccionarTodas =
        document.getElementById("seleccionar-todas-guias");

    const btnPdf =
        document.getElementById("btn-pdf-seleccionadas");

    const btnExcel =
        document.getElementById("btn-excel-seleccionadas");


    const total =
        resultadosBusquedaAvanzada.length;

    const seleccionadas =
        guiasSeleccionadasAvanzadas.size;


    if (barra) {

        barra.style.display =
            total > 0
                ? "block"
                : "none";

    }


    if (contador) {

        contador.textContent =
            `${seleccionadas} ${
                seleccionadas === 1
                    ? "seleccionada"
                    : "seleccionadas"
            }`;

    }


    if (seleccionarTodas) {

        seleccionarTodas.checked =
            total > 0 &&
            seleccionadas === total;


        seleccionarTodas.indeterminate =
            seleccionadas > 0 &&
            seleccionadas < total;

    }


    if (btnPdf) {

        btnPdf.disabled =
            seleccionadas === 0;

    }


    if (btnExcel) {

        btnExcel.disabled =
            seleccionadas === 0;

    }
}


// ============================================================
// RESUMEN DE BÚSQUEDA AVANZADA
// ============================================================
function actualizarResumenBusquedaAvanzada() {

    const resumen =
        document.getElementById("resumen-busqueda-avanzada");

    const total =
        document.getElementById("total-resultados-avanzados");

    const criterios =
        document.getElementById("criterios-busqueda-avanzada");


    if (!resumen || !total || !criterios) {
        return;
    }


    resumen.style.display = "block";


    total.textContent =
        `${resultadosBusquedaAvanzada.length} ${
            resultadosBusquedaAvanzada.length === 1
                ? "guía"
                : "guías"
        }`;


    const filtros =
        filtrosBusquedaAvanzadaActuales;


    const chips = [];


    if (filtros.producto) {

        chips.push(`

            <div class="criterio-avanzado-chip">

                <i class="fa-solid fa-box"></i>

                <span>
                    ${escapeHtml(filtros.producto)}
                </span>

            </div>

        `);

    }


    if (filtros.partida) {

        chips.push(`

            <div class="criterio-avanzado-chip">

                <i class="fa-solid fa-location-dot"></i>

                <span>
                    ${escapeHtml(filtros.partida)}
                </span>

            </div>

        `);

    }


    if (filtros.llegada) {

        chips.push(`

            <div class="criterio-avanzado-chip">

                <i class="fa-solid fa-flag-checkered"></i>

                <span>
                    ${escapeHtml(filtros.llegada)}
                </span>

            </div>

        `);

    }


    if (filtros.desde) {

        chips.push(`

            <div class="criterio-avanzado-chip">

                <i class="fa-regular fa-calendar"></i>

                <span>
                    Desde ${formatearFecha(filtros.desde)}
                </span>

            </div>

        `);

    }


    if (filtros.hasta) {

        chips.push(`

            <div class="criterio-avanzado-chip">

                <i class="fa-regular fa-calendar-check"></i>

                <span>
                    Hasta ${formatearFecha(filtros.hasta)}
                </span>

            </div>

        `);

    }


    criterios.innerHTML =
        chips.join("");
}


// ============================================================
// LIMPIAR BÚSQUEDA AVANZADA
// ============================================================
function limpiarBusquedaAvanzada() {

    [
        "av-producto",
        "av-partida",
        "av-llegada",
        "av-desde",
        "av-hasta"

    ].forEach(id => {

        const input =
            document.getElementById(id);

        if (input) {
            input.value = "";
        }

    });


    resultadosBusquedaAvanzada = [];

    guiasSeleccionadasAvanzadas.clear();

    filtrosBusquedaAvanzadaActuales = {};

    busquedaAvanzadaActiva = false;

    buscando = false;


    const avanzado =
        document.getElementById("historial-avanzado");

    const resumen =
        document.getElementById("resumen-busqueda-avanzada");

    const barra =
        document.getElementById("barra-seleccion-guias");

    const normal =
        document.getElementById("historial-lista");


    if (avanzado) {

        avanzado.innerHTML = "";
        avanzado.style.display = "none";

    }


    if (resumen) {
        resumen.style.display = "none";
    }


    if (barra) {
        barra.style.display = "none";
    }


    if (normal) {
        normal.style.display = "block";
    }


    pagina = 0;

    mostrarHistorial();
}

// ============================================================
// CREAR HTML DE UNA GUÍA PARA PDF DE BÚSQUEDA AVANZADA
// ============================================================
function crearHTMLGuiaSeleccionadaPDF(g) {

    const idsCoincidentes = new Set(
        (g.items_coincidentes || [])
            .map(item => Number(item.id))
            .filter(id => Number.isFinite(id))
    );


    const productoBuscado =
        filtrosBusquedaAvanzadaActuales.producto || "";


    const palabrasProducto =
        normalizarTexto(productoBuscado)
            .split(" ")
            .filter(Boolean);


    const esItemCoincidente = (item) => {

        // Primero usamos los IDs que devuelve el backend
        if (
            item.id != null &&
            idsCoincidentes.has(Number(item.id))
        ) {
            return true;
        }


        // Fallback por texto
        if (palabrasProducto.length === 0) {
            return false;
        }


        const textoItem =
            normalizarTexto(
                `${item.codigo_bien || ""} ${item.descripcion || ""}`
            );


        return palabrasProducto.every(
            palabra => textoItem.includes(palabra)
        );
    };


    const items =
        Array.isArray(g.items)
            ? g.items
            : [];


    let filas = "";


    items.forEach((item, index) => {

        const coincide =
            esItemCoincidente(item);


        const fondo =
            coincide
                ? "#fff3a3"
                : index % 2 === 0
                    ? "#ffffff"
                    : "#f8fafc";


        const borde =
            coincide
                ? "2px solid #e0a800"
                : "1px solid #d9e2ea";


        filas += `
            <tr
                style="
                    background:${fondo};
                    border:${borde};
                "
            >

                <td
                    style="
                        padding:7px;
                        text-align:center;
                        border:1px solid #d9e2ea;
                    "
                >
                    ${escapeHtml(
                        String(
                            item.linea ??
                            index + 1
                        )
                    )}
                </td>


                <td
                    style="
                        padding:7px;
                        border:1px solid #d9e2ea;
                    "
                >
                    ${escapeHtml(
                        String(
                            item.codigo_bien || "-"
                        )
                    )}
                </td>


                <td
                    style="
                        padding:7px;
                        border:1px solid #d9e2ea;
                        font-weight:${
                            coincide
                                ? "700"
                                : "400"
                        };
                    "
                >
                    ${escapeHtml(
                        String(
                            item.descripcion || "-"
                        )
                    )}

                    ${
                        coincide
                            ? `
                                <div
                                    style="
                                        margin-top:3px;
                                        color:#8a6500;
                                        font-size:9px;
                                        font-weight:700;
                                    "
                                >
                                    COINCIDENCIA DE BÚSQUEDA
                                </div>
                            `
                            : ""
                    }
                </td>


                <td
                    style="
                        padding:7px;
                        text-align:center;
                        border:1px solid #d9e2ea;
                    "
                >
                    ${escapeHtml(
                        String(
                            item.cantidad ?? "-"
                        )
                    )}
                </td>


                <td
                    style="
                        padding:7px;
                        text-align:center;
                        border:1px solid #d9e2ea;
                    "
                >
                    ${escapeHtml(
                        String(
                            item.unidad || "-"
                        )
                    )}
                </td>

            </tr>
        `;
    });


    return `

        <div
            style="
                width:900px;
                background:#ffffff;
                color:#1f2937;
                font-family:Arial, sans-serif;
                padding:28px;
                box-sizing:border-box;
            "
        >

            <!-- CABECERA -->
            <div
                style="
                    border-bottom:3px solid #0a5c8c;
                    padding-bottom:14px;
                    margin-bottom:18px;
                "
            >

                <div
                    style="
                        font-size:22px;
                        font-weight:700;
                        color:#0a5c8c;
                    "
                >
                    GUÍA DE REMISIÓN
                </div>

                <div
                    style="
                        margin-top:5px;
                        font-size:18px;
                        font-weight:700;
                    "
                >
                    ${escapeHtml(
                        g.numero || "Sin número"
                    )}
                </div>

                <div
                    style="
                        margin-top:4px;
                        color:#64748b;
                        font-size:12px;
                    "
                >
                    Fecha:
                    ${escapeHtml(
                        formatearFecha(
                            g.fecha_emision
                        )
                    )}

                    ${
                        g.hora_emision
                            ? ` · ${escapeHtml(
                                String(
                                    g.hora_emision
                                )
                            )}`
                            : ""
                    }
                </div>

            </div>


            <!-- DATOS GENERALES -->
            <div
                style="
                    display:grid;
                    grid-template-columns:1fr 1fr;
                    gap:10px;
                    margin-bottom:16px;
                "
            >

                <div
                    style="
                        padding:10px;
                        background:#f8fafc;
                        border:1px solid #e2e8f0;
                        border-radius:6px;
                    "
                >
                    <strong>Remitente</strong><br>

                    ${escapeHtml(
                        g.remitente_nombre || "-"
                    )}

                    <br>

                    <span
                        style="
                            font-size:11px;
                            color:#64748b;
                        "
                    >
                        RUC:
                        ${escapeHtml(
                            g.remitente_ruc || "-"
                        )}
                    </span>
                </div>


                <div
                    style="
                        padding:10px;
                        background:#f8fafc;
                        border:1px solid #e2e8f0;
                        border-radius:6px;
                    "
                >
                    <strong>Destinatario</strong><br>

                    ${escapeHtml(
                        g.destinatario_nombre || "-"
                    )}
                </div>

            </div>


            <!-- RUTA -->
            <div
                style="
                    margin-bottom:16px;
                    padding:12px;
                    background:#f8fafc;
                    border:1px solid #e2e8f0;
                    border-radius:6px;
                "
            >

                <div
                    style="
                        margin-bottom:8px;
                    "
                >
                    <strong>
                        Punto de partida
                    </strong>

                    <br>

                    ${escapeHtml(
                        g.direccion_partida || "-"
                    )}
                </div>


                <div>
                    <strong>
                        Punto de llegada
                    </strong>

                    <br>

                    ${escapeHtml(
                        g.direccion_llegada || "-"
                    )}
                </div>

            </div>


            <!-- CRITERIO -->
            ${
                productoBuscado
                    ? `
                        <div
                            style="
                                margin-bottom:14px;
                                padding:9px 11px;
                                border-left:4px solid #e0a800;
                                background:#fff9df;
                                font-size:11px;
                            "
                        >

                            <strong>
                                Producto buscado:
                            </strong>

                            ${escapeHtml(
                                productoBuscado
                            )}

                            <br>

                            <span
                                style="
                                    color:#806900;
                                "
                            >
                                Las filas amarillas corresponden
                                a coincidencias de la búsqueda.
                            </span>

                        </div>
                    `
                    : ""
            }


            <!-- TABLA -->
            <table
                style="
                    width:100%;
                    border-collapse:collapse;
                    font-size:11px;
                "
            >

                <thead>

                    <tr
                        style="
                            background:#0a5c8c;
                            color:#ffffff;
                        "
                    >

                        <th
                            style="
                                width:7%;
                                padding:8px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            #
                        </th>

                        <th
                            style="
                                width:17%;
                                padding:8px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            Código
                        </th>

                        <th
                            style="
                                width:50%;
                                padding:8px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            Descripción
                        </th>

                        <th
                            style="
                                width:13%;
                                padding:8px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            Cantidad
                        </th>

                        <th
                            style="
                                width:13%;
                                padding:8px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            Unidad
                        </th>

                    </tr>

                </thead>


                <tbody>

                    ${
                        filas ||
                        `
                            <tr>
                                <td
                                    colspan="5"
                                    style="
                                        padding:20px;
                                        text-align:center;
                                    "
                                >
                                    Sin items
                                </td>
                            </tr>
                        `
                    }

                </tbody>

            </table>

        </div>
    `;
}


// ============================================================
// EXPORTAR PDF DE GUÍAS SELECCIONADAS
// ============================================================
async function exportarPDFSeleccionadas() {

    if (
        guiasSeleccionadasAvanzadas.size === 0
    ) {

        mostrarAlerta(
            "Selecciona al menos una guía",
            "error"
        );

        return;
    }


    const seleccionadas =
        resultadosBusquedaAvanzada.filter(
            guia =>
                guiasSeleccionadasAvanzadas.has(
                    Number(guia.id)
                )
        );


    if (seleccionadas.length === 0) {

        mostrarAlerta(
            "No se encontraron las guías seleccionadas",
            "error"
        );

        return;
    }


    const boton =
        document.getElementById(
            "btn-pdf-seleccionadas"
        );


    const textoOriginal =
        boton?.innerHTML;


    if (boton) {

        boton.disabled = true;

        boton.innerHTML = `
            <i class="fa-solid fa-spinner fa-spin"></i>
            Generando...
        `;
    }


    try {

        const {
            jsPDF
        } = window.jspdf;


        const pdf =
            new jsPDF(
                "p",
                "mm",
                "a4"
            );


        const pageWidth = 210;
        const pageHeight = 297;

        const margen = 12;

        const anchoUtil =
            pageWidth -
            margen * 2;

        const altoUtil =
            pageHeight -
            margen * 2;


        // ====================================================
        // PORTADA / RESUMEN
        // ====================================================
        pdf.setFontSize(18);

        pdf.text(
            "RESULTADO DE BÚSQUEDA DE GUÍAS",
            margen,
            22
        );


        pdf.setFontSize(10);


        let y = 34;


        const agregarDato = (
            titulo,
            valor
        ) => {

            if (!valor) return;


            pdf.setFont(
                "helvetica",
                "bold"
            );


            pdf.text(
                `${titulo}:`,
                margen,
                y
            );


            pdf.setFont(
                "helvetica",
                "normal"
            );


            const texto =
                pdf.splitTextToSize(
                    String(valor),
                    140
                );


            pdf.text(
                texto,
                52,
                y
            );


            y +=
                Math.max(
                    7,
                    texto.length * 5
                );
        };


        agregarDato(
            "Producto",
            filtrosBusquedaAvanzadaActuales.producto
        );


        agregarDato(
            "Partida",
            filtrosBusquedaAvanzadaActuales.partida
        );


        agregarDato(
            "Llegada",
            filtrosBusquedaAvanzadaActuales.llegada
        );


        agregarDato(
            "Desde",
            filtrosBusquedaAvanzadaActuales.desde
                ? formatearFecha(
                    filtrosBusquedaAvanzadaActuales.desde
                )
                : ""
        );


        agregarDato(
            "Hasta",
            filtrosBusquedaAvanzadaActuales.hasta
                ? formatearFecha(
                    filtrosBusquedaAvanzadaActuales.hasta
                )
                : ""
        );


        agregarDato(
            "Guías seleccionadas",
            seleccionadas.length
        );


        // Total de coincidencias
        const totalCoincidencias =
            seleccionadas.reduce(
                (total, guia) =>
                    total +
                    Number(
                        guia.cantidad_coincidencias || 0
                    ),
                0
            );


        agregarDato(
            "Coincidencias",
            totalCoincidencias
        );


        pdf.setFontSize(9);

        pdf.setTextColor(
            90,
            90,
            90
        );


        pdf.text(
            "Las filas resaltadas en amarillo corresponden al producto buscado.",
            margen,
            y + 8
        );


        pdf.setTextColor(
            0,
            0,
            0
        );


        // ====================================================
        // CONTENEDOR TEMPORAL
        // ====================================================
        const contenedor =
            document.createElement(
                "div"
            );


        contenedor.style.position =
            "fixed";

        contenedor.style.left =
            "-10000px";

        contenedor.style.top =
            "0";

        contenedor.style.width =
            "900px";

        contenedor.style.background =
            "#ffffff";

        contenedor.style.zIndex =
            "-99999";


        document.body.appendChild(
            contenedor
        );


        // ====================================================
        // CADA GUÍA
        // ====================================================
        for (
            let index = 0;
            index < seleccionadas.length;
            index++
        ) {

            const guia =
                seleccionadas[index];


            contenedor.innerHTML =
                crearHTMLGuiaSeleccionadaPDF(
                    guia
                );


            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        80
                    )
            );


            const canvas =
                await html2canvas(
                    contenedor.firstElementChild,
                    {
                        scale: 2,
                        useCORS: true,
                        backgroundColor:
                            "#ffffff"
                    }
                );


            const imgData =
                canvas.toDataURL(
                    "image/png"
                );


            const imgWidth =
                anchoUtil;


            const imgHeight =
                canvas.height *
                imgWidth /
                canvas.width;


            pdf.addPage();


            // ----------------------------------------------
            // La guía entra en una página
            // ----------------------------------------------
            if (
                imgHeight <= altoUtil
            ) {

                pdf.addImage(
                    imgData,
                    "PNG",
                    margen,
                    margen,
                    imgWidth,
                    imgHeight
                );

            }

            // ----------------------------------------------
            // La guía ocupa varias páginas
            // ----------------------------------------------
            else {

                let heightLeft =
                    imgHeight;


                let position =
                    margen;


                pdf.addImage(
                    imgData,
                    "PNG",
                    margen,
                    position,
                    imgWidth,
                    imgHeight
                );


                heightLeft -=
                    altoUtil;


                while (
                    heightLeft > 0
                ) {

                    pdf.addPage();


                    position =
                        margen -
                        (
                            imgHeight -
                            heightLeft
                        );


                    pdf.addImage(
                        imgData,
                        "PNG",
                        margen,
                        position,
                        imgWidth,
                        imgHeight
                    );


                    heightLeft -=
                        altoUtil;
                }
            }
        }


        contenedor.remove();


        // ====================================================
        // NOMBRE DEL ARCHIVO
        // ====================================================
        const producto =
            normalizarTexto(
                filtrosBusquedaAvanzadaActuales.producto ||
                "busqueda"
            )
                .replace(/\s+/g, "_")
                .slice(0, 35);


        const nombreArchivo =
            `guias_${producto}_${seleccionadas.length}.pdf`;


        pdf.save(
            nombreArchivo
        );


        mostrarAlerta(
            `✅ PDF generado con ${seleccionadas.length} guía(s)`,
            "success"
        );


    } catch (error) {

        console.error(
            "❌ Error generando PDF seleccionado:",
            error
        );


        mostrarAlerta(
            "No se pudo generar el PDF",
            "error"
        );

    } finally {

        if (boton) {

            boton.disabled =
                guiasSeleccionadasAvanzadas.size === 0;


            boton.innerHTML =
                textoOriginal;

        }
    }
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

    // ========================================================
    // BÚSQUEDA AVANZADA
    // ========================================================

    const btnToggleAvanzada =
        document.getElementById("btn-toggle-avanzada");

    const btnBuscarAvanzado =
        document.getElementById("btn-buscar-avanzado");

    const btnLimpiarAvanzado =
        document.getElementById("btn-limpiar-avanzado");

    const seleccionarTodas =
        document.getElementById("seleccionar-todas-guias");

    const btnPdfSeleccionadas =
        document.getElementById("btn-pdf-seleccionadas");

    if (seleccionarTodas) {

        seleccionarTodas.addEventListener(
            "change",
            event => {

                seleccionarTodasGuiasAvanzadas(
                    event.currentTarget.checked
                );

            }
        );

    }

    if (btnPdfSeleccionadas) {

        btnPdfSeleccionadas.addEventListener(
            "click",
            exportarPDFSeleccionadas
        );

    }


    if (btnToggleAvanzada) {

        btnToggleAvanzada.addEventListener(
            "click",
            toggleBusquedaAvanzada
        );

    }


    if (btnBuscarAvanzado) {

        btnBuscarAvanzado.addEventListener(
            "click",
            buscarGuiasAvanzado
        );

    }


    if (btnLimpiarAvanzado) {

        btnLimpiarAvanzado.addEventListener(
            "click",
            limpiarBusquedaAvanzada
        );

    }


    if (seleccionarTodas) {

        seleccionarTodas.addEventListener(
            "change",
            event => {

                seleccionarTodasGuiasAvanzadas(
                    event.currentTarget.checked
                );

            }
        );

    }


    // Enter también ejecuta la búsqueda avanzada
    [
        "av-producto",
        "av-partida",
        "av-llegada"

    ].forEach(id => {

        const input =
            document.getElementById(id);

        if (!input) return;


        input.addEventListener(
            "keydown",
            event => {

                if (event.key === "Enter") {

                    event.preventDefault();

                    buscarGuiasAvanzado();

                }

            }
        );

    });

    // Cargar historial inicial
    mostrarHistorial();
});