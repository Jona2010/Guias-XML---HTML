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
let totalGuiasHistorial = 0;
let totalPaginasHistorial = 1;
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

        // ========================================================
        // IDENTIFICACIÓN
        // ========================================================

        guia.numero =
            val(
                xml,
                UBL.cbc,
                "ID"
            );


        guia.fecha_emision =
            val(
                xml,
                UBL.cbc,
                "IssueDate"
            );


        guia.hora_emision =
            val(
                xml,
                UBL.cbc,
                "IssueTime"
            );


        // ========================================================
        // REMITENTE
        // ========================================================

        const remitente =
            first(
                xml,
                UBL.cac,
                "DespatchSupplierParty"
            );


        guia.remitente = {

            ruc:
                val(
                    remitente,
                    UBL.cbc,
                    "ID"
                ),

            razon_social:
                val(
                    remitente,
                    UBL.cbc,
                    "RegistrationName"
                )

        };


        // ========================================================
        // DESTINATARIO
        // ========================================================

        const destinatario =
            first(
                xml,
                UBL.cac,
                "DeliveryCustomerParty"
            );


        guia.destinatario = {

            nombre:
                val(
                    destinatario,
                    UBL.cbc,
                    "RegistrationName"
                )

        };


        // ========================================================
        // TRASLADO
        // ========================================================

        const shipment =
            first(
                xml,
                UBL.cac,
                "Shipment"
            );


        const shipmentStage =
            first(
                shipment,
                UBL.cac,
                "ShipmentStage"
            );


        const transitPeriod =
            first(
                shipmentStage,
                UBL.cac,
                "TransitPeriod"
            );


        guia.fecha_inicio_traslado =
            val(
                transitPeriod,
                UBL.cbc,
                "StartDate"
            ) || null;


        guia.traslado = {

            motivo:
                val(
                    shipment,
                    UBL.cbc,
                    "HandlingInstructions"
                ),

            peso_total:
                val(
                    shipment,
                    UBL.cbc,
                    "GrossWeightMeasure"
                )

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

        console.log(
            "📅 Fechas XML:",
            {
                numero:
                    guia.numero,

                fecha_emision:
                    guia.fecha_emision,

                hora_emision:
                    guia.hora_emision,

                fecha_inicio_traslado:
                    guia.fecha_inicio_traslado
            }
        );

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

            <h3>
                📄 ${escapeHtml(g.numero || "Sin número")}

                <small>
                    Emisión:
                    ${formatearFecha(g.fecha_emision)}
                    ${g.hora_emision || ""}
                </small>
            </h3>

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
            <div class="guia-meta-item">
                <label>
                    Inicio de traslado
                </label>

                <span>
                    ${
                        g.fecha_inicio_traslado
                            ? formatearFecha(
                                g.fecha_inicio_traslado
                            )
                            : "No registrado"
                    }
                </span>
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
        document.getElementById(
        "salida"
    ).innerHTML = html;


    ultimaGuiaCargada = g;


    // ========================================================
    // ACTUALIZAR ESTADO DEL VISOR
    // ========================================================
    const estadoVisor =
        document.querySelector(
            ".viewer-header-status"
        );


    if (estadoVisor) {

        estadoVisor.innerHTML = `

            <span
                class="viewer-status-dot"
                style="
                    background:#22c55e;
                "
            ></span>

            <span>
                ${escapeHtml(
                    g.numero ||
                    "Guía cargada"
                )}
            </span>

        `;

    }
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
        numero:
            g.numero || "",

        fecha_emision:
            g.fecha_emision || "",

        hora_emision:
            g.hora_emision || "",

        fecha_inicio_traslado:
            g.fecha_inicio_traslado || "",
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
// PAGINACIÓN NUMERADA DEL HISTORIAL
// BLOQUES: 1-5, 6-10, 11-15...
// ============================================================
function generarPaginacionHistorial() {

    if (
        totalPaginasHistorial <= 1
    ) {
        return "";
    }


    const paginaActual =
        pagina + 1;


    const paginasPorBloque =
        5;


    // Ejemplo:
    // página 1 -> bloque 0 -> 1 al 5
    // página 6 -> bloque 1 -> 6 al 10
    const bloqueActual =
        Math.floor(
            (paginaActual - 1) /
            paginasPorBloque
        );


    const inicioBloque =
        bloqueActual *
        paginasPorBloque +
        1;


    const finBloque =
        Math.min(
            inicioBloque +
            paginasPorBloque -
            1,
            totalPaginasHistorial
        );


    let botonesPaginas = "";


    for (
        let numero = inicioBloque;
        numero <= finBloque;
        numero++
    ) {

        botonesPaginas += `

            <button
                type="button"
                class="
                    pagina-btn
                    ${
                        numero === paginaActual
                            ? "activa"
                            : ""
                    }
                "
                onclick="irPaginaHistorial(${numero})"
                aria-label="Ir a la página ${numero}"
                ${
                    numero === paginaActual
                        ? 'aria-current="page"'
                        : ""
                }
            >
                ${numero}
            </button>

        `;

    }

    const cambiaBloqueSiguiente =
        paginaActual === finBloque &&
        finBloque < totalPaginasHistorial;


    const cambiaBloqueAnterior =
        paginaActual === inicioBloque &&
        inicioBloque > 1;

    return `

        <div class="paginacion paginacion-numerada">

            <span class="paginacion-info">

                Mostrando
                ${
                    pagina * limite + 1
                }–${
                    Math.min(
                        (pagina + 1) * limite,
                        totalGuiasHistorial
                    )
                }
                de
                ${totalGuiasHistorial}

            </span>


            <div class="paginacion-controls">

                <button
                    type="button"
                    class="
                        btn-icon
                        ${
                            cambiaBloqueAnterior
                                ? "cambio-bloque"
                                : ""
                        }
                    "
                    onclick="anteriorPagina()"
                    aria-label="${
                        cambiaBloqueAnterior
                            ? "Ir al bloque anterior"
                            : "Página anterior"
                    }"
                    ${
                        paginaActual === 1
                            ? "disabled"
                            : ""
                    }
                >
                    <i
                        class="fa-solid ${
                            cambiaBloqueAnterior
                                ? "fa-angles-left"
                                : "fa-chevron-left"
                        }"
                    ></i>
                </button>


                ${botonesPaginas}


                <button
                    type="button"
                    class="
                        btn-icon
                        ${
                            cambiaBloqueSiguiente
                                ? "cambio-bloque"
                                : ""
                        }
                    "
                    onclick="siguientePagina()"
                    aria-label="${
                        cambiaBloqueSiguiente
                            ? "Ir al siguiente bloque de páginas"
                            : "Página siguiente"
                    }"
                    ${
                        paginaActual ===
                        totalPaginasHistorial
                            ? "disabled"
                            : ""
                    }
                >
                    <i
                        class="fa-solid ${
                            cambiaBloqueSiguiente
                                ? "fa-angles-right"
                                : "fa-chevron-right"
                        }"
                    ></i>
                </button>

            </div>

        </div>

    `;
}


// ============================================================
// IR DIRECTAMENTE A UNA PÁGINA
// ============================================================
function irPaginaHistorial(numeroPagina) {

    const nuevaPagina =
        Number(numeroPagina) - 1;


    if (
        !Number.isInteger(nuevaPagina) ||
        nuevaPagina < 0 ||
        nuevaPagina >=
            totalPaginasHistorial
    ) {
        return;
    }


    pagina =
        nuevaPagina;


    mostrarHistorial();
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

    const guias =
        data.data;


    totalGuiasHistorial =
        Number(
            data.total || 0
        );


    totalPaginasHistorial =
        Math.max(
            1,
            Number(
                data.totalPaginas || 1
            )
        );


    hayMasPaginas =
        pagina + 1 <
        totalPaginasHistorial;

    if (guias.length === 0) {
        contHistorial.innerHTML = `<div class="empty-state"><i class="fa-regular fa-folder-open"></i><p>No hay guías registradas</p></div>`;
        return;
    }

    // 🔥 CORREGIDO: Ordenar por fecha (más reciente primero) y luego por número de guía
    const guiasOrdenadas =
        guias;

    /*const inicio = (pagina * limite) + 1;
    const fin = inicio + guiasOrdenadas.length - 1;*/

    let html = `
    <table class="historial-tabla">
        <thead>
            <tr>
                <th style="width:35%;">N° Guía</th>
                <th style="width:40%;">Cliente</th>
                <th style="width:25%;">Traslado</th>
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
            <td>
                <span class="guia-fecha">
                    ${
                        formatearFecha(
                            obtenerFechaOperativa(g)
                        )
                    }
                </span>
            </td>
        </tr>`;
    });

    html += `
            </tbody>
        </table>

        ${generarPaginacionHistorial()}
    `;

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
    const resultados =
        data.data
            .map(g => ({
                ...g,

                __score:
                    calcularRelevancia(
                        g,
                        texto
                    )
            }))
            .sort((a, b) => {

                const fechaA =
                    obtenerFechaOperativa(a);

                const fechaB =
                    obtenerFechaOperativa(b);


                if (fechaA !== fechaB) {

                    return fechaB.localeCompare(
                        fechaA
                    );

                }


                return (
                    (b.id || 0) -
                    (a.id || 0)
                );

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
                <span class="fecha">
                    ${
                        formatearFecha(
                            obtenerFechaOperativa(g)
                        )
                    }
                </span>
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
// FECHA OPERATIVA DE LA GUÍA
// Prioridad:
// 1. Inicio de traslado
// 2. Fecha de emisión como fallback
// ============================================================
function obtenerFechaOperativa(guia) {

    if (!guia) {
        return "";
    }

    return (
        guia.fecha_inicio_traslado ||
        guia.fecha_emision ||
        ""
    );
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

    if (
        pagina + 1 >=
        totalPaginasHistorial
    ) {
        return;
    }


    pagina++;

    mostrarHistorial();
}


function anteriorPagina() {

    if (pagina <= 0) {
        return;
    }


    pagina--;

    mostrarHistorial();
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
    const guiasOrdenadas =
        data.data.sort((a, b) => {

            const fechaA =
                obtenerFechaOperativa(a);

            const fechaB =
                obtenerFechaOperativa(b);


            if (fechaA !== fechaB) {

                return fechaB.localeCompare(
                    fechaA
                );

            }


            const numA =
                a.numero || "";

            const numB =
                b.numero || "";


            return numB.localeCompare(
                numA
            );

        });

    // Mostrar resultados en tabla
    let html = `
    <table class="historial-tabla">
        <thead>
            <tr>
                <th style="width:35%;">N° Guía</th>
                <th style="width:40%;">Cliente</th>
                <th style="width:25%;">
                    Traslado
                </th>
            </tr>
        </thead>
        <tbody>
    `;

    guiasOrdenadas.forEach(g => {
        html += `
        <tr data-id="${g.id}" onclick="seleccionarGuia(this, ${g.id})">
            <td><span class="guia-numero">📄 ${g.numero}</span></td>
            <td><span class="guia-cliente">${g.destinatario_nombre || "—"}</span></td>
            <td>
                <span class="guia-fecha">
                    ${
                        formatearFecha(
                            obtenerFechaOperativa(g)
                        )
                    }
                </span>
            </td>
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

    const panel =
        document.getElementById(
            "panel-busqueda-avanzada"
        );

    const boton =
        document.getElementById(
            "btn-toggle-avanzada"
        );

    const busquedaRapida =
        document.querySelector(
            ".search-section-basic"
        );


    if (!panel || !boton) {
        return;
    }


    const estaAbierto =
        panel.style.display !== "none";


    const abrir =
        !estaAbierto;


    // Mostrar / ocultar panel avanzado
    panel.style.display =
        abrir
            ? "block"
            : "none";


    // Estado visual
    boton.classList.toggle(
        "activo",
        abrir
    );


    // Accesibilidad
    boton.setAttribute(
        "aria-expanded",
        String(abrir)
    );


    // ========================================================
    // BÚSQUEDA RÁPIDA
    // Si existen resultados avanzados, permanece oculta
    // aunque cerremos el formulario avanzado.
    // ========================================================

    const panelBusqueda =
        document.querySelector(
            ".search-panel"
        );


    const modoResultados =
        panelBusqueda
            ?.classList
            .contains(
                "modo-resultados-avanzados"
            );


    if (busquedaRapida) {

        busquedaRapida.style.display =
            (
                abrir ||
                modoResultados
            )
                ? "none"
                : "block";

    }


    // Si abrimos, colocar foco en producto
    if (abrir) {

        requestAnimationFrame(() => {

            document
                .getElementById(
                    "av-producto"
                )
                ?.focus();

        });

    }
}

// ============================================================
// MODO RESULTADOS DE BÚSQUEDA AVANZADA
// ============================================================

function activarModoResultadosAvanzados() {

    const searchPanel =
        document.querySelector(
            ".search-panel"
        );


    const panel =
        document.getElementById(
            "panel-busqueda-avanzada"
        );


    const boton =
        document.getElementById(
            "btn-toggle-avanzada"
        );


    const busquedaRapida =
        document.querySelector(
            ".search-section-basic"
        );


    // Activar diseño compacto
    if (searchPanel) {

        searchPanel.classList.add(
            "modo-resultados-avanzados"
        );

    }


    // Cerrar formulario avanzado
    if (panel) {

        panel.style.display =
            "none";

    }


    // Flecha / estado del botón
    if (boton) {

        boton.classList.remove(
            "activo"
        );

        boton.setAttribute(
            "aria-expanded",
            "false"
        );

    }


    // Ocultar búsqueda rápida
    // para entregar espacio al listado
    if (busquedaRapida) {

        busquedaRapida.style.display =
            "none";

    }

}


// ============================================================
// SALIR DEL MODO RESULTADOS AVANZADOS
// ============================================================

function desactivarModoResultadosAvanzados() {

    const searchPanel =
        document.querySelector(
            ".search-panel"
        );


    const busquedaRapida =
        document.querySelector(
            ".search-section-basic"
        );


    if (searchPanel) {

        searchPanel.classList.remove(
            "modo-resultados-avanzados"
        );

    }


    if (busquedaRapida) {

        busquedaRapida.style.display =
            "block";

    }

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

    // ========================================================
    // ENTREGAR ESPACIO AL LISTADO
    // ========================================================

    activarModoResultadosAvanzados();

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

        const coincidenciasMostrar =
            coincidencias.slice(
                0,
                1
            );


        const coincidenciasRestantes =
            Math.max(
                0,
                coincidencias.length - 1
            );


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
                            ${
                                formatearFecha(
                                    obtenerFechaOperativa(g)
                                )
                            }
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

                                ? coincidenciasMostrar
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

                                + (
                                    coincidenciasRestantes > 0

                                        ? `
                                            <div class="coincidencias-mas">
                                                +${coincidenciasRestantes}
                                                ${
                                                    coincidenciasRestantes === 1
                                                        ? "coincidencia más"
                                                        : "coincidencias más"
                                                }
                                            </div>
                                        `

                                        : ""
                                )

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

    const seleccionarTodas =
        document.getElementById(
            "seleccionar-todas-guias"
        );

    if (seleccionarTodas) {

        seleccionarTodas.checked = false;
        seleccionarTodas.indeterminate = false;

    }

    // Restaurar diseño normal
    desactivarModoResultadosAvanzados();


    pagina = 0;

    mostrarHistorial();
}

// ============================================================
// DIVIDIR ITEMS DE UNA GUÍA EN PÁGINAS
// ============================================================
function dividirItemsGuiaPDF(items, porPagina = 12) {

    const paginas = [];

    for (
        let i = 0;
        i < items.length;
        i += porPagina
    ) {

        paginas.push(
            items.slice(
                i,
                i + porPagina
            )
        );

    }

    return paginas.length
        ? paginas
        : [[]];
}

// ============================================================
// CREAR HTML DE UNA GUÍA PARA PDF DE BÚSQUEDA AVANZADA
// ============================================================
function crearHTMLGuiaSeleccionadaPDF(
    g,
    itemsPagina,
    paginaActual,
    totalPaginas
) {

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
        Array.isArray(itemsPagina)
            ? itemsPagina
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
                        padding:9px;
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
                        padding:9px;
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
                        padding:9px;
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
                                        font-size:10px;
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
                        padding:9px;
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
                        padding:9px;
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
                padding:22px;
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
                        font-size:24px;
                        font-weight:700;
                        color:#0a5c8c;
                    "
                >
                    GUÍA DE REMISIÓN
                </div>

                <div
                    style="
                        margin-top:5px;
                        font-size:20px;
                        font-weight:700;
                    "
                >
                    ${escapeHtml(
                        g.numero || "Sin número"
                    )}
                </div>

                <div
                    style="
                        margin-top:7px;

                        color:#4f6575;

                        font-size:15px;
                        line-height:1.6;

                        font-weight:600;
                    "
                >
                    Emisión:
                    ${
                        escapeHtml(
                            formatearFecha(
                                g.fecha_emision
                            )
                        )
                    }

                    ${
                        g.hora_emision
                            ? ` · ${
                                escapeHtml(
                                    String(g.hora_emision)
                                )
                            }`
                            : ""
                    }

                    <br>

                    Inicio de traslado:
                    ${
                        escapeHtml(
                            formatearFecha(
                                obtenerFechaOperativa(g)
                            )
                        )
                    }
                </div>

                <div
                    style="
                        margin-top:6px;

                        color:#0877b9;

                        font-size:13px;

                        font-weight:750;
                    "
                >
                    Página ${paginaActual} de ${totalPaginas}
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
                        padding:11px;
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
                            font-size:12px;
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
                                font-size:12px;
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
                    font-size:12px;
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
                                padding:9px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            #
                        </th>

                        <th
                            style="
                                width:17%;
                                padding:9px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            Código
                        </th>

                        <th
                            style="
                                width:50%;
                                padding:9px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            Descripción
                        </th>

                        <th
                            style="
                                width:13%;
                                padding:9px;
                                border:1px solid #0a5c8c;
                            "
                        >
                            Cantidad
                        </th>

                        <th
                            style="
                                width:13%;
                                padding:9px;
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

        const margen = 8;

        const anchoUtil =
            pageWidth -
            margen * 2;

        const altoUtil =
            pageHeight -
            margen * 2;


        // ====================================================
        // PORTADA / RESUMEN PROFESIONAL
        // ====================================================

        const azulPrincipal = [10, 92, 140];
        const azulSuave = [235, 245, 251];
        const grisTexto = [90, 105, 120];
        const grisBorde = [215, 225, 234];
        const amarilloSuave = [255, 248, 205];


        // ----------------------------------------------------
        // CABECERA
        // ----------------------------------------------------
        pdf.setFillColor(...azulPrincipal);

        pdf.rect(
            0,
            0,
            pageWidth,
            34,
            "F"
        );


        pdf.setTextColor(
            255,
            255,
            255
        );

        pdf.setFont(
            "helvetica",
            "bold"
        );

        pdf.setFontSize(20);

        pdf.text(
            "RESULTADO DE BÚSQUEDA DE GUÍAS",
            margen,
            17
        );


        pdf.setFont(
            "helvetica",
            "normal"
        );

        pdf.setFontSize(10);

        pdf.text(
            "Sistema de Guías de Remisión SUNAT",
            margen,
            25
        );


        // ----------------------------------------------------
        // TARJETA PRINCIPAL DE FILTROS
        // ----------------------------------------------------
        let y = 46;

        pdf.setTextColor(
            30,
            41,
            59
        );

        pdf.setFillColor(
            ...azulSuave
        );

        pdf.setDrawColor(
            ...grisBorde
        );

        pdf.roundedRect(
            margen,
            y,
            anchoUtil,
            56,
            3,
            3,
            "FD"
        );


        pdf.setFont(
            "helvetica",
            "bold"
        );

        pdf.setFontSize(12);

        pdf.setTextColor(
            ...azulPrincipal
        );

        pdf.text(
            "CRITERIOS DE BÚSQUEDA",
            margen + 6,
            y + 10
        );


        pdf.setFontSize(9);

        pdf.setTextColor(
            30,
            41,
            59
        );


        // ----------------------------------------------------
        // COLUMNAS DE DATOS
        // ----------------------------------------------------
        const col1X =
            margen + 6;

        const col2X =
            margen + 94;

        let filaY =
            y + 21;


        function escribirCampo(
            titulo,
            valor,
            x,
            yCampo,
            ancho = 70
        ) {

            pdf.setFont(
                "helvetica",
                "bold"
            );

            pdf.setTextColor(
                ...grisTexto
            );

            pdf.text(
                `${titulo}:`,
                x,
                yCampo
            );


            pdf.setFont(
                "helvetica",
                "normal"
            );

            pdf.setTextColor(
                20,
                30,
                45
            );


            const texto =
                pdf.splitTextToSize(
                    String(valor || "-"),
                    ancho
                );


            pdf.text(
                texto,
                x + 27,
                yCampo
            );
        }


        escribirCampo(
            "Producto",
            filtrosBusquedaAvanzadaActuales.producto || "-",
            col1X,
            filaY
        );


        escribirCampo(
            "Partida",
            filtrosBusquedaAvanzadaActuales.partida || "-",
            col1X,
            filaY + 10
        );


        escribirCampo(
            "Llegada",
            filtrosBusquedaAvanzadaActuales.llegada || "-",
            col1X,
            filaY + 20
        );


        escribirCampo(
            "Desde",
            filtrosBusquedaAvanzadaActuales.desde
                ? formatearFecha(
                    filtrosBusquedaAvanzadaActuales.desde
                )
                : "-",
            col2X,
            filaY
        );


        escribirCampo(
            "Hasta",
            filtrosBusquedaAvanzadaActuales.hasta
                ? formatearFecha(
                    filtrosBusquedaAvanzadaActuales.hasta
                )
                : "-",
            col2X,
            filaY + 10
        );


        // ----------------------------------------------------
        // INDICADORES
        // ----------------------------------------------------
        const totalCoincidencias =
            seleccionadas.reduce(
                (total, guia) =>
                    total +
                    Number(
                        guia.cantidad_coincidencias || 0
                    ),
                0
            );


        const indicadoresY =
            y + 65;


        const anchoIndicador =
            (anchoUtil - 8) / 2;


        function dibujarIndicador(
            x,
            titulo,
            valor
        ) {

            pdf.setFillColor(
                248,
                250,
                252
            );

            pdf.setDrawColor(
                ...grisBorde
            );

            pdf.roundedRect(
                x,
                indicadoresY,
                anchoIndicador,
                22,
                3,
                3,
                "FD"
            );


            pdf.setFont(
                "helvetica",
                "bold"
            );

            pdf.setFontSize(16);

            pdf.setTextColor(
                ...azulPrincipal
            );

            pdf.text(
                String(valor),
                x + 6,
                indicadoresY + 10
            );


            pdf.setFont(
                "helvetica",
                "normal"
            );

            pdf.setFontSize(8);

            pdf.setTextColor(
                ...grisTexto
            );

            pdf.text(
                titulo,
                x + 6,
                indicadoresY + 17
            );
        }


        dibujarIndicador(
            margen,
            "GUÍAS SELECCIONADAS",
            seleccionadas.length
        );


        dibujarIndicador(
            margen +
                anchoIndicador +
                8,
            "COINCIDENCIAS ENCONTRADAS",
            totalCoincidencias
        );


        // ----------------------------------------------------
        // TABLA DE GUÍAS ENCONTRADAS
        // ----------------------------------------------------
        let tablaY =
            indicadoresY + 34;


        pdf.setFont(
            "helvetica",
            "bold"
        );

        pdf.setFontSize(11);

        pdf.setTextColor(
            ...azulPrincipal
        );

        pdf.text(
            `GUÍAS DONDE SE ENCONTRÓ "${
                (
                    filtrosBusquedaAvanzadaActuales.producto ||
                    "PRODUCTO"
                ).toUpperCase()
            }"`,
            margen,
            tablaY
        );


        tablaY += 7;


        // Encabezado tabla
        pdf.setFillColor(
            ...azulPrincipal
        );

        pdf.rect(
            margen,
            tablaY,
            anchoUtil,
            9,
            "F"
        );


        pdf.setTextColor(
            255,
            255,
            255
        );

        pdf.setFontSize(8);

        pdf.text(
            "N°",
            margen + 3,
            tablaY + 6
        );

        pdf.text(
            "GUÍA",
            margen + 14,
            tablaY + 6
        );

        pdf.text(
            "TRASLADO",
            margen + 55,
            tablaY + 6
        );

        pdf.text(
            "PRODUCTO COINCIDENTE",
            margen + 88,
            tablaY + 6
        );

        pdf.text(
            "COINC.",
            margen + 164,
            tablaY + 6
        );


        tablaY += 9;


        // ----------------------------------------------------
        // FILAS
        // ----------------------------------------------------
        seleccionadas.forEach(
            (guia, index) => {

                // Si no entra otra fila, nueva página
                if (
                    tablaY > 270
                ) {

                    pdf.addPage();

                    tablaY = 18;


                    pdf.setFillColor(
                        ...azulPrincipal
                    );

                    pdf.rect(
                        margen,
                        tablaY,
                        anchoUtil,
                        9,
                        "F"
                    );


                    pdf.setTextColor(
                        255,
                        255,
                        255
                    );

                    pdf.setFontSize(8);

                    pdf.text(
                        "N°",
                        margen + 3,
                        tablaY + 6
                    );

                    pdf.text(
                        "GUÍA",
                        margen + 14,
                        tablaY + 6
                    );

                    pdf.text(
                        "TRASLADO",
                        margen + 55,
                        tablaY + 6
                    );

                    pdf.text(
                        "PRODUCTO COINCIDENTE",
                        margen + 88,
                        tablaY + 6
                    );

                    pdf.text(
                        "COINC.",
                        margen + 164,
                        tablaY + 6
                    );


                    tablaY += 9;
                }


                const fondo =
                    index % 2 === 0
                        ? [255, 255, 255]
                        : [248, 250, 252];


                pdf.setFillColor(
                    ...fondo
                );

                pdf.setDrawColor(
                    ...grisBorde
                );


                pdf.rect(
                    margen,
                    tablaY,
                    anchoUtil,
                    13,
                    "FD"
                );


                pdf.setFont(
                    "helvetica",
                    "normal"
                );

                pdf.setFontSize(8);

                pdf.setTextColor(
                    30,
                    41,
                    59
                );


                // Número
                pdf.text(
                    String(index + 1),
                    margen + 3,
                    tablaY + 8
                );


                // Guía
                pdf.setFont(
                    "helvetica",
                    "bold"
                );

                pdf.text(
                    String(
                        guia.numero || "-"
                    ),
                    margen + 14,
                    tablaY + 8
                );


                // Fecha
                pdf.setFont(
                    "helvetica",
                    "normal"
                );

                pdf.text(
                    formatearFecha(
                        obtenerFechaOperativa(guia)
                    ),
                    margen + 55,
                    tablaY + 8
                );


                // Producto coincidente
                const primerItem =
                    Array.isArray(
                        guia.items_coincidentes
                    ) &&
                    guia.items_coincidentes.length > 0
                        ? guia.items_coincidentes[0]
                        : null;


                const descripcion =
                    primerItem?.descripcion ||
                    "-";


                const textoProducto =
                    pdf.splitTextToSize(
                        descripcion,
                        70
                    );


                pdf.setFontSize(7);

                pdf.text(
                    textoProducto.slice(0, 2),
                    margen + 88,
                    tablaY + 5
                );


                // Número de coincidencias
                pdf.setFontSize(8);

                pdf.setFont(
                    "helvetica",
                    "bold"
                );

                pdf.text(
                    String(
                        guia.cantidad_coincidencias || 0
                    ),
                    margen + 167,
                    tablaY + 8
                );


                tablaY += 13;
            }
        );


        // ----------------------------------------------------
        // NOTA
        // ----------------------------------------------------
        tablaY += 8;


        pdf.setFillColor(
            ...amarilloSuave
        );

        pdf.setDrawColor(
            225,
            190,
            60
        );

        pdf.roundedRect(
            margen,
            tablaY,
            anchoUtil,
            18,
            3,
            3,
            "FD"
        );


        pdf.setTextColor(
            105,
            85,
            15
        );

        pdf.setFont(
            "helvetica",
            "bold"
        );

        pdf.setFontSize(8);

        pdf.text(
            "IDENTIFICACIÓN DE COINCIDENCIAS",
            margen + 5,
            tablaY + 7
        );


        pdf.setFont(
            "helvetica",
            "normal"
        );

        pdf.text(
            "En las siguientes páginas, las filas resaltadas en amarillo corresponden al producto buscado.",
            margen + 5,
            tablaY + 13
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
        // CADA GUÍA - PAGINACIÓN REAL
        // ====================================================
        for (
            let indexGuia = 0;
            indexGuia < seleccionadas.length;
            indexGuia++
        ) {

            const guia =
                seleccionadas[indexGuia];


            const itemsGuia =
                Array.isArray(guia.items)
                    ? guia.items
                    : [];


            // Dividimos la guía antes de convertirla en imagen.
            // Así nunca cortamos una tabla enorme con offsets.
            const paginasItems =
                dividirItemsGuiaPDF(
                    itemsGuia
                );


            for (
                let paginaGuia = 0;
                paginaGuia < paginasItems.length;
                paginaGuia++
            ) {

                const itemsPagina =
                    paginasItems[paginaGuia];


                const numeroPagina =
                    paginaGuia + 1;


                const totalPaginasGuia =
                    paginasItems.length;


                // --------------------------------------------------
                // Crear solamente ESTA página de la guía
                // --------------------------------------------------
                contenedor.innerHTML =
                    crearHTMLGuiaSeleccionadaPDF(
                        guia,
                        itemsPagina,
                        numeroPagina,
                        totalPaginasGuia
                    );


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            60
                        )
                );


                const elementoPagina =
                    contenedor.firstElementChild;


                const canvas =
                    await html2canvas(
                        elementoPagina,
                        {
                            scale: 1.8,
                            useCORS: true,
                            backgroundColor: "#ffffff"
                        }
                    );


                const imgData =
                    canvas.toDataURL(
                        "image/jpeg",
                        0.82
                    );


                const imgWidth =
                    anchoUtil;


                const imgHeightNatural =
                    canvas.height *
                    imgWidth /
                    canvas.width;


                // Evitar que una página ligeramente alta
                // se salga del área A4.
                const escala =
                    imgHeightNatural > altoUtil
                        ? altoUtil /
                            imgHeightNatural
                        : 1;


                const imgWidthFinal =
                    imgWidth *
                    escala;


                const imgHeightFinal =
                    imgHeightNatural *
                    escala;


                // Centrar horizontalmente si se redujo
                const xFinal =
                    margen +
                    (
                        anchoUtil -
                        imgWidthFinal
                    ) / 2;


                // Cada bloque generado corresponde
                // exactamente a una nueva página.
                pdf.addPage();


                pdf.addImage(
                    imgData,
                    "JPEG",
                    xFinal,
                    margen,
                    imgWidthFinal,
                    imgHeightFinal,
                    undefined,
                    "FAST"
                );
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
// EXPORTAR EXCEL - GUÍAS SELECCIONADAS
// ============================================================
async function exportarExcelSeleccionadas() {

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
            "btn-excel-seleccionadas"
        );


    const contenidoOriginal =
        boton?.innerHTML;


    if (boton) {

        boton.disabled = true;

        boton.innerHTML = `
            <i class="fa-solid fa-spinner fa-spin"></i>
            Generando...
        `;

    }


    try {

        // ====================================================
        // LIBRO
        // ====================================================
        const workbook =
            XLSX.utils.book_new();


        // ====================================================
        // HOJA 1 - RESUMEN DE BÚSQUEDA
        // ====================================================
        const resumen = [

            [
                "RESULTADO DE BÚSQUEDA DE GUÍAS"
            ],

            [],

            [
                "Producto",
                filtrosBusquedaAvanzadaActuales.producto || "-"
            ],

            [
                "Punto de partida",
                filtrosBusquedaAvanzadaActuales.partida || "-"
            ],

            [
                "Punto de llegada",
                filtrosBusquedaAvanzadaActuales.llegada || "-"
            ],

            [
                "Desde",
                filtrosBusquedaAvanzadaActuales.desde
                    ? formatearFecha(
                        filtrosBusquedaAvanzadaActuales.desde
                    )
                    : "-"
            ],

            [
                "Hasta",
                filtrosBusquedaAvanzadaActuales.hasta
                    ? formatearFecha(
                        filtrosBusquedaAvanzadaActuales.hasta
                    )
                    : "-"
            ],

            [
                "Guías seleccionadas",
                seleccionadas.length
            ],

            [],

            [
                "#",
                "Guía",
                "Fecha traslado",
                "Destinatario",
                "Punto de partida",
                "Punto de llegada",
                "Coincidencias"
            ]

        ];


        seleccionadas.forEach(
            (guia, index) => {

                resumen.push([

                    index + 1,

                    guia.numero || "-",

                    formatearFecha(
                        obtenerFechaOperativa(guia)
                    ),

                    guia.destinatario_nombre || "-",

                    guia.direccion_partida || "-",

                    guia.direccion_llegada || "-",

                    Number(
                        guia.cantidad_coincidencias || 0
                    )

                ]);

            }
        );


        const wsResumen =
            XLSX.utils.aoa_to_sheet(
                resumen
            );


        wsResumen["!cols"] = [

            { wch: 6 },
            { wch: 18 },
            { wch: 14 },
            { wch: 38 },
            { wch: 55 },
            { wch: 55 },
            { wch: 14 }

        ];


        wsResumen["!merges"] = [

            {
                s: { r: 0, c: 0 },
                e: { r: 0, c: 6 }
            }

        ];


        XLSX.utils.book_append_sheet(
            workbook,
            wsResumen,
            "Resumen"
        );


        // ====================================================
        // HOJA 2 - TODOS LOS ITEMS
        // ====================================================
        const detalle = [

            [
                "Guía",
                "Fecha traslado",
                "Cliente",
                "Partida",
                "Llegada",
                "Línea",
                "Código",
                "Descripción",
                "Cantidad",
                "Unidad",
                "Coincidencia"
            ]

        ];


        seleccionadas.forEach(guia => {

            const idsCoincidentes =
                new Set(
                    (
                        guia.items_coincidentes ||
                        []
                    )
                        .map(
                            item =>
                                Number(item.id)
                        )
                        .filter(
                            id =>
                                Number.isFinite(id)
                        )
                );


            const palabrasProducto =
                normalizarTexto(
                    filtrosBusquedaAvanzadaActuales.producto ||
                    ""
                )
                    .split(" ")
                    .filter(Boolean);


            const items =
                Array.isArray(guia.items)
                    ? guia.items
                    : [];


            items.forEach(
                (item, index) => {

                    let coincide = false;


                    // Primero por ID
                    if (
                        item.id != null &&
                        idsCoincidentes.has(
                            Number(item.id)
                        )
                    ) {

                        coincide = true;

                    }


                    // Fallback por texto
                    if (
                        !coincide &&
                        palabrasProducto.length > 0
                    ) {

                        const textoItem =
                            normalizarTexto(
                                `${
                                    item.codigo_bien || ""
                                } ${
                                    item.descripcion || ""
                                }`
                            );


                        coincide =
                            palabrasProducto.every(
                                palabra =>
                                    textoItem.includes(
                                        palabra
                                    )
                            );

                    }


                    detalle.push([

                        guia.numero || "-",

                        formatearFecha(
                            obtenerFechaOperativa(guia)
                        ),

                        guia.destinatario_nombre || "-",

                        guia.direccion_partida || "-",

                        guia.direccion_llegada || "-",

                        item.linea ??
                            index + 1,

                        item.codigo_bien || "-",

                        item.descripcion || "-",

                        item.cantidad ?? "-",

                        item.unidad || "-",

                        coincide
                            ? "SÍ"
                            : ""

                    ]);

                }
            );

        });


        const wsDetalle =
            XLSX.utils.aoa_to_sheet(
                detalle
            );


        wsDetalle["!cols"] = [

            { wch: 18 },
            { wch: 14 },
            { wch: 35 },
            { wch: 50 },
            { wch: 50 },
            { wch: 8 },
            { wch: 22 },
            { wch: 60 },
            { wch: 12 },
            { wch: 10 },
            { wch: 14 }

        ];


        XLSX.utils.book_append_sheet(
            workbook,
            wsDetalle,
            "Detalle"
        );


        // ====================================================
        // HOJA 3 - SOLO COINCIDENCIAS
        // ====================================================
        const coincidencias = [

            [
                "Guía",
                "Fecha traslado",
                "Producto encontrado",
                "Cantidad",
                "Unidad",
                "Punto de partida",
                "Punto de llegada"
            ]

        ];


        seleccionadas.forEach(
            guia => {

                const items =
                    Array.isArray(
                        guia.items_coincidentes
                    )
                        ? guia.items_coincidentes
                        : [];


                items.forEach(
                    item => {

                        coincidencias.push([

                            guia.numero || "-",

                            formatearFecha(
                                obtenerFechaOperativa(guia)
                            ),

                            item.descripcion || "-",

                            item.cantidad ?? "-",

                            item.unidad || "-",

                            guia.direccion_partida || "-",

                            guia.direccion_llegada || "-"

                        ]);

                    }
                );

            }
        );


        const wsCoincidencias =
            XLSX.utils.aoa_to_sheet(
                coincidencias
            );


        wsCoincidencias["!cols"] = [

            { wch: 18 },
            { wch: 14 },
            { wch: 65 },
            { wch: 12 },
            { wch: 10 },
            { wch: 55 },
            { wch: 55 }

        ];


        XLSX.utils.book_append_sheet(
            workbook,
            wsCoincidencias,
            "Coincidencias"
        );


        // ====================================================
        // NOMBRE
        // ====================================================
        const producto =
            normalizarTexto(
                filtrosBusquedaAvanzadaActuales.producto ||
                "busqueda"
            )
                .replace(/\s+/g, "_")
                .slice(0, 30);


        const nombre =
            `guias_${producto}_${seleccionadas.length}.xlsx`;


        XLSX.writeFile(
            workbook,
            nombre
        );


        mostrarAlerta(
            `✅ Excel generado con ${seleccionadas.length} guía(s)`,
            "success"
        );


    } catch (error) {

        console.error(
            "❌ Error generando Excel seleccionado:",
            error
        );


        mostrarAlerta(
            "No se pudo generar el Excel",
            "error"
        );


    } finally {

        if (boton) {

            boton.disabled =
                guiasSeleccionadasAvanzadas.size === 0;


            boton.innerHTML =
                contenidoOriginal;

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
        [
            "Fecha de emisión:",
            formatearFecha(
                g.fecha_emision
            )
        ],

        [
            "Inicio de traslado:",
            formatearFecha(
                g.fecha_inicio_traslado ||
                g.fecha_emision
            )
        ],
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
// HTML PARA PDF UNITARIO
// ============================================================
function crearHTMLGuiaUnitariaPDF(
    g,
    itemsPagina,
    paginaActual,
    totalPaginas
) {

    const items =
        Array.isArray(itemsPagina)
            ? itemsPagina
            : [];


    const filas =
        items.map(
            (item, index) => `

                <tr>

                    <td
                        style="
                            width:7%;
                            padding:10px 8px;
                            text-align:center;
                            border:1px solid #cbd9e2;
                        "
                    >
                        ${
                            escapeHtml(
                                String(
                                    item.linea ??
                                    index + 1
                                )
                            )
                        }
                    </td>


                    <td
                        style="
                            width:18%;
                            padding:10px 8px;
                            border:1px solid #cbd9e2;
                        "
                    >
                        ${
                            escapeHtml(
                                String(
                                    item.codigo_bien ||
                                    "-"
                                )
                            )
                        }
                    </td>


                    <td
                        style="
                            width:49%;
                            padding:10px;
                            border:1px solid #cbd9e2;
                            line-height:1.45;
                        "
                    >
                        ${
                            escapeHtml(
                                String(
                                    item.descripcion ||
                                    "-"
                                )
                            )
                        }
                    </td>


                    <td
                        style="
                            width:13%;
                            padding:10px 8px;
                            text-align:center;
                            border:1px solid #cbd9e2;
                        "
                    >
                        ${
                            escapeHtml(
                                String(
                                    item.cantidad ??
                                    "-"
                                )
                            )
                        }
                    </td>


                    <td
                        style="
                            width:13%;
                            padding:10px 8px;
                            text-align:center;
                            border:1px solid #cbd9e2;
                        "
                    >
                        ${
                            escapeHtml(
                                String(
                                    item.unidad ||
                                    "-"
                                )
                            )
                        }
                    </td>

                </tr>

            `
        )
        .join("");


    return `

        <div
            style="
                width:820px;
                background:#ffffff;
                color:#172433;
                font-family:Arial, sans-serif;
                padding:25px;
                box-sizing:border-box;
            "
        >


            <!-- =================================================
                 CABECERA
            ================================================== -->

            <div
                style="
                    display:flex;
                    justify-content:space-between;
                    align-items:flex-start;

                    margin-bottom:18px;
                    padding-bottom:14px;

                    border-bottom:
                        4px solid #0877b9;
                "
            >


                <div>

                    <div
                        style="
                            color:#0877b9;
                            font-size:26px;
                            font-weight:800;
                        "
                    >
                        GUÍA DE REMISIÓN
                    </div>


                    <div
                        style="
                            margin-top:5px;
                            color:#172433;
                            font-size:22px;
                            font-weight:800;
                        "
                    >
                        ${
                            escapeHtml(
                                g.numero ||
                                "Sin número"
                            )
                        }
                    </div>


                    <div
                        style="
                            margin-top:7px;

                            color:#4f6575;

                            font-size:15px;
                            line-height:1.6;

                            font-weight:600;
                        "
                    >
                        Emisión:
                        ${
                            escapeHtml(
                                formatearFecha(
                                    g.fecha_emision
                                )
                            )
                        }

                        ${
                            g.hora_emision
                                ? ` · ${
                                    escapeHtml(
                                        String(
                                            g.hora_emision
                                        )
                                    )
                                }`
                                : ""
                        }

                        <br>

                        Inicio de traslado:
                        ${
                            escapeHtml(
                                formatearFecha(
                                    obtenerFechaOperativa(g)
                                )
                            )
                        }
                    </div>

                </div>


                <div
                    style="
                        padding:7px 12px;

                        border-radius:20px;

                        background:#e8f4fa;
                        color:#0877b9;

                        font-size:13px;
                        font-weight:750;
                    "
                >
                    Página
                    ${paginaActual}
                    de
                    ${totalPaginas}
                </div>

            </div>



            <!-- =================================================
                 DATOS
            ================================================== -->

            <div
                style="
                    display:grid;
                    grid-template-columns:1fr 1fr;

                    gap:10px;

                    margin-bottom:12px;
                "
            >


                <div
                    style="
                        padding:12px;

                        border:1px solid #d5e1e8;
                        border-radius:7px;

                        background:#f4f8fa;
                    "
                >

                    <div
                        style="
                            margin-bottom:3px;

                            color:#597286;

                            font-size:10px;
                            font-weight:700;

                            text-transform:uppercase;
                        "
                    >
                        Remitente
                    </div>


                    <div
                        style="
                            font-size:13px;
                            font-weight:700;
                        "
                    >
                        ${
                            escapeHtml(
                                g.remitente?.razon_social ||
                                "-"
                            )
                        }
                    </div>


                    <div
                        style="
                            margin-top:3px;

                            color:#64788a;

                            font-size:11px;
                        "
                    >
                        RUC:
                        ${
                            escapeHtml(
                                g.remitente?.ruc ||
                                "-"
                            )
                        }
                    </div>

                </div>



                <div
                    style="
                        padding:12px;

                        border:1px solid #d5e1e8;
                        border-radius:7px;

                        background:#f4f8fa;
                    "
                >

                    <div
                        style="
                            margin-bottom:3px;

                            color:#597286;

                            font-size:10px;
                            font-weight:700;

                            text-transform:uppercase;
                        "
                    >
                        Destinatario
                    </div>


                    <div
                        style="
                            font-size:13px;
                            font-weight:700;
                        "
                    >
                        ${
                            escapeHtml(
                                g.destinatario?.nombre ||
                                "-"
                            )
                        }
                    </div>

                </div>

            </div>



            <!-- =================================================
                 INFORMACIÓN ADICIONAL
            ================================================== -->

            <div
                style="
                    display:grid;
                    grid-template-columns:1fr 1fr;

                    gap:10px;

                    margin-bottom:12px;
                "
            >


                <div
                    style="
                        padding:10px 12px;

                        border:1px solid #d5e1e8;
                        border-radius:7px;

                        background:#ffffff;
                    "
                >

                    <strong>
                        Motivo de traslado:
                    </strong>

                    ${
                        escapeHtml(
                            g.traslado?.motivo ||
                            "-"
                        )
                    }

                </div>


                <div
                    style="
                        padding:10px 12px;

                        border:1px solid #d5e1e8;
                        border-radius:7px;

                        background:#ffffff;
                    "
                >

                    <strong>
                        Peso total:
                    </strong>

                    ${
                        escapeHtml(
                            String(
                                g.traslado?.peso_total ||
                                "0"
                            )
                        )
                    }
                    kg

                </div>

            </div>



            <!-- =================================================
                 RUTA
            ================================================== -->

            <div
                style="
                    margin-bottom:15px;
                    padding:12px;

                    border:1px solid #d5e1e8;
                    border-radius:7px;

                    background:#f8fafb;

                    font-size:12px;
                "
            >


                <div
                    style="
                        margin-bottom:8px;
                    "
                >

                    <strong
                        style="
                            color:#0877b9;
                        "
                    >
                        Punto de partida
                    </strong>

                    <br>

                    ${
                        escapeHtml(
                            g.partida?.direccion ||
                            "-"
                        )
                    }

                </div>


                <div>

                    <strong
                        style="
                            color:#0877b9;
                        "
                    >
                        Punto de llegada
                    </strong>

                    <br>

                    ${
                        escapeHtml(
                            g.llegada?.direccion ||
                            "-"
                        )
                    }

                </div>

            </div>



            <!-- =================================================
                 ITEMS
            ================================================== -->

            <div
                style="
                    margin-bottom:7px;

                    color:#173d55;

                    font-size:14px;
                    font-weight:800;
                "
            >
                ITEMS
            </div>


            <table
                style="
                    width:100%;

                    border-collapse:collapse;

                    font-size:12px;
                "
            >


                <thead>

                    <tr
                        style="
                            background:#0877b9;
                            color:#ffffff;
                        "
                    >

                        <th
                            style="
                                padding:10px 8px;
                                border:1px solid #0877b9;
                            "
                        >
                            #
                        </th>

                        <th
                            style="
                                padding:10px 8px;
                                border:1px solid #0877b9;
                            "
                        >
                            Código
                        </th>

                        <th
                            style="
                                padding:10px;
                                border:1px solid #0877b9;
                            "
                        >
                            Descripción
                        </th>

                        <th
                            style="
                                padding:10px 8px;
                                border:1px solid #0877b9;
                            "
                        >
                            Cantidad
                        </th>

                        <th
                            style="
                                padding:10px 8px;
                                border:1px solid #0877b9;
                            "
                        >
                            Unidad
                        </th>

                    </tr>

                </thead>


                <tbody>

                    ${filas}

                </tbody>

            </table>


        </div>
    `;
}

// ============================================================
// EXPORTAR PDF
// ============================================================
async function exportarPDF() {

    const g =
        ultimaGuiaCargada;


    if (!g) {

        mostrarAlerta(
            "Primero selecciona o carga una guía",
            "error"
        );

        return;
    }


    try {

        mostrarAlerta(
            "Generando PDF...",
            "info"
        );


        const {
            jsPDF
        } =
            window.jspdf;


        const pdf =
            new jsPDF(
                "p",
                "mm",
                "a4"
            );


        const pageWidth = 210;
        const pageHeight = 297;

        const margen = 7;

        const anchoUtil =
            pageWidth -
            margen * 2;

        const altoUtil =
            pageHeight -
            margen * 2;


        // ====================================================
        // DIVIDIR ITEMS
        // ====================================================
        const paginas =
            dividirItemsGuiaPDF(
                Array.isArray(g.items)
                    ? g.items
                    : [],
                12
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
            "820px";

        contenedor.style.background =
            "#ffffff";


        document.body.appendChild(
            contenedor
        );


        // ====================================================
        // CADA PÁGINA
        // ====================================================
        for (
            let i = 0;
            i < paginas.length;
            i++
        ) {

            contenedor.innerHTML =
                crearHTMLGuiaUnitariaPDF(
                    g,
                    paginas[i],
                    i + 1,
                    paginas.length
                );


            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        60
                    )
            );


            const elemento =
                contenedor.firstElementChild;


            const canvas =
                await html2canvas(
                    elemento,
                    {
                        scale: 2,
                        useCORS: true,
                        backgroundColor:
                            "#ffffff"
                    }
                );


            const imgData =
                canvas.toDataURL(
                    "image/jpeg",
                    .88
                );


            const imgWidth =
                anchoUtil;


            const alturaNatural =
                canvas.height *
                imgWidth /
                canvas.width;


            const escala =
                alturaNatural >
                altoUtil

                    ? altoUtil /
                        alturaNatural

                    : 1;


            const widthFinal =
                imgWidth *
                escala;


            const heightFinal =
                alturaNatural *
                escala;


            const x =
                margen +
                (
                    anchoUtil -
                    widthFinal
                ) / 2;


            if (i > 0) {

                pdf.addPage();

            }


            pdf.addImage(
                imgData,
                "JPEG",
                x,
                margen,
                widthFinal,
                heightFinal,
                undefined,
                "FAST"
            );

        }


        contenedor.remove();


        const nombre =
            g.numero ||
            "sin_numero";


        pdf.save(
            `guia_${nombre}.pdf`
        );


        mostrarAlerta(
            `✅ PDF exportado: guia_${nombre}.pdf`,
            "success"
        );


    } catch (error) {

        console.error(
            "Error generando PDF:",
            error
        );


        mostrarAlerta(
            "No se pudo generar el PDF",
            "error"
        );

    }

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

    const btnExcelSeleccionadas =
        document.getElementById(
            "btn-excel-seleccionadas"
        );

    
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

    if (btnExcelSeleccionadas) {

        btnExcelSeleccionadas.addEventListener(
            "click",
            exportarExcelSeleccionadas
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