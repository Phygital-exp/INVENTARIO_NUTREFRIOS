(() => {
    "use strict";

    const CFG = window.APP_CONFIG;
    const $ = id => document.getElementById(id);
    const CLAVE_SESION = "inventario_nutrefrios_sesion";
    const MAX_FALTANTES_MODAL = 4;
    // Cantidad: hasta 999 con máximo 2 decimales y punto como separador (ej. 0.25)
    const MAX_ENTEROS = 3;
    const MAX_DECIMALES = 2;

    // ========== ESTADO ==========
    const estado = {
        usuario: null,          // usuario encontrado en el paso 1 (antes de confirmar)
        registro: null,         // registro de inventario (fuente de verdad de lo guardado)
        marcas: null,           // [{ MARCA, TOTAL_PRODUCTOS }] del canal del punto
        marcaActual: null,
        productos: [],
        filtro: "",
        editando: new Set(),    // productos desbloqueados con el lápiz
        borradores: new Map(),  // valores escritos aún sin enviar
        guardando: new Set(),   // productos con envío en curso
    };

    // ========== API ==========
    class ErrorApi extends Error {
        constructor(mensaje, { status = 0, datos = null, red = false } = {}) {
            super(mensaje);
            this.status = status;
            this.datos = datos;
            this.red = red;
        }
    }

    async function api(ruta, { method = "GET", body } = {}) {
        const control = new AbortController();
        const temporizador = setTimeout(() => control.abort(), CFG.TIMEOUT_MS);
        let respuesta;
        try {
            respuesta = await fetch(CFG.API_BASE_URL + ruta, {
                method,
                headers: body ? { "Content-Type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                signal: control.signal,
            });
        } catch (e) {
            throw new ErrorApi(
                e.name === "AbortError"
                    ? "El servidor está tardando mucho en responder. Revisa tu conexión e intenta de nuevo."
                    : "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.",
                { red: true }
            );
        } finally {
            clearTimeout(temporizador);
        }

        let datos = null;
        try { datos = await respuesta.json(); } catch (e) { /* respuesta sin JSON */ }

        if (!respuesta.ok) {
            throw new ErrorApi((datos && datos.error) || "Ocurrió un problema. Intenta de nuevo.", {
                status: respuesta.status, datos,
            });
        }
        return datos;
    }

    // ========== SESIÓN LOCAL (solo para retomar si se recarga la página) ==========
    const hoy = () => new Date().toLocaleDateString("en-CA");

    function guardarSesion() {
        try {
            localStorage.setItem(CLAVE_SESION, JSON.stringify({ id: estado.registro._id, dia: hoy() }));
        } catch (e) { /* almacenamiento no disponible */ }
    }

    function leerSesion() {
        try {
            const s = JSON.parse(localStorage.getItem(CLAVE_SESION) || "null");
            return s && s.id && s.dia === hoy() ? s : null;
        } catch (e) {
            return null;
        }
    }

    function borrarSesion() {
        try { localStorage.removeItem(CLAVE_SESION); } catch (e) { /* nada */ }
    }

    // ========== UTILIDADES ==========
    const normalizarMarca = m => String(m || "").trim().replace(/\s+/g, " ").toUpperCase();
    const sinTildes = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

    function crear(etiqueta, props = {}, hijos = []) {
        const el = document.createElement(etiqueta);
        for (const [k, v] of Object.entries(props)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "for") el.setAttribute(k, v);
            else el[k] = v;
        }
        for (const h of [].concat(hijos)) if (h) el.append(h);
        return el;
    }

    function marcaEnRegistro(nombre) {
        const objetivo = normalizarMarca(nombre);
        return ((estado.registro && estado.registro.MARCAS) || []).find(m => normalizarMarca(m.MARCA) === objetivo) || null;
    }

    const marcaFinalizada = nombre => (marcaEnRegistro(nombre) || {}).ESTADO === "FINALIZADA";

    // productoId -> cantidad guardada en el registro
    function cantidadesGuardadas(nombre) {
        const mapa = new Map();
        const marca = marcaEnRegistro(nombre);
        for (const p of (marca && marca.PRODUCTOS) || []) {
            if (Number.isFinite(p.CANTIDAD) && p.CANTIDAD >= 0) mapa.set(String(p.PRODUCTO_ID), p.CANTIDAD);
        }
        return mapa;
    }

    function vistaCargando(contenedor, texto) {
        contenedor.replaceChildren(crear("div", { class: "cargando", role: "status" }, [
            crear("div", { class: "spinner", "aria-hidden": "true" }),
            crear("p", { text: texto }),
        ]));
    }

    function vistaError(contenedor, mensaje, reintentar) {
        contenedor.replaceChildren(crear("div", { class: "estado-error", role: "alert" }, [
            crear("span", { class: "estado-error__icono", text: "⚠️", "aria-hidden": "true" }),
            crear("p", { class: "estado-error__texto", text: mensaje }),
            crear("button", { class: "btn btn--primario", type: "button", text: "Reintentar", onclick: reintentar }),
        ]));
    }

    function aviso(contenedor, tipo, texto, boton) {
        contenedor.replaceChildren(crear("div", { class: `aviso aviso--${tipo}`, role: tipo === "error" ? "alert" : "status" }, [
            crear("p", { text: texto }),
            boton ? crear("button", { class: "btn btn--secundario", type: "button", text: boton.texto, onclick: boton.accion }) : null,
        ]));
    }

    function botonCargando(boton, cargando, textoCargando) {
        if (cargando) {
            boton.dataset.textoOriginal = boton.textContent;
            boton.disabled = true;
            boton.replaceChildren(crear("span", { class: "spinner spinner--sm", "aria-hidden": "true" }), textoCargando);
        } else {
            boton.disabled = false;
            boton.textContent = boton.dataset.textoOriginal || boton.textContent;
        }
    }

    // ========== TOASTS ==========
    function toast(texto, tipo = "exito", duracion = 2800) {
        const el = crear("div", { class: `toast toast--${tipo}`, role: tipo === "error" ? "alert" : "status", text: texto });
        $("toasts").append(el);
        setTimeout(() => {
            el.classList.add("saliendo");
            setTimeout(() => el.remove(), 300);
        }, duracion);
    }

    // ========== MODAL ==========
    let focoPrevio = null;

    function abrirModal({ titulo, cuerpo, botones }) {
        focoPrevio = document.activeElement;
        $("modal-titulo").textContent = titulo;
        $("modal-cuerpo").replaceChildren(...[].concat(cuerpo));
        $("modal-botones").replaceChildren(...botones.map(b =>
            crear("button", { class: `btn ${b.clase || "btn--secundario"}`, type: "button", text: b.texto, onclick: b.accion })
        ));
        $("modal").classList.remove("oculto");
        $("modal-botones").querySelector("button").focus();
    }

    function cerrarModal() {
        $("modal").classList.add("oculto");
        if (focoPrevio && document.contains(focoPrevio)) focoPrevio.focus();
    }

    $("modal").addEventListener("click", e => { if (e.target === $("modal")) cerrarModal(); });
    document.addEventListener("keydown", e => {
        if ($("modal").classList.contains("oculto")) return;
        if (e.key === "Escape") return cerrarModal();
        if (e.key === "Tab") {
            const enfocables = $("modal").querySelectorAll("button:not(:disabled)");
            const primero = enfocables[0], ultimo = enfocables[enfocables.length - 1];
            if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
            else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
        }
    });

    // ========== NAVEGACIÓN ENTRE PASOS ==========
    function mostrarPaso(n) {
        [1, 2, 3].forEach(i => $(`paso-${i}`).classList.toggle("oculto", i !== n));
        document.querySelectorAll(".pasos__item").forEach(li => {
            const paso = Number(li.dataset.paso);
            li.classList.toggle("activo", paso === n);
            li.classList.toggle("hecho", paso < n);
            if (paso === n) li.setAttribute("aria-current", "step");
            else li.removeAttribute("aria-current");
        });
        window.scrollTo({ top: 0 });
    }

    function actualizarEncabezado() {
        const r = estado.registro;
        $("sesion").classList.toggle("oculto", !r);
        if (!r) return;
        const u = r.USUARIO || {};
        const pdv = r.PUNTO_VENTA;
        $("sesion-nombre").textContent = u.NOMBRE || `Cédula ${u.CEDULA || ""}`;
        $("sesion-pdv").textContent = pdv
            ? `📍 ${[pdv.NOMBRE, pdv.CIUDAD].filter(Boolean).join(" · ")}`
            : "📍 Punto de venta no disponible";
    }

    // ========== PASO 1: IDENTIFICACIÓN ==========
    const inputCedula = $("cedula");

    inputCedula.addEventListener("input", () => {
        const limpio = inputCedula.value.replace(/\D/g, "");
        if (limpio !== inputCedula.value) inputCedula.value = limpio;
        inputCedula.classList.remove("invalido");
    });
    inputCedula.addEventListener("keydown", bloquearNoDigitos);

    function reiniciarPaso1() {
        estado.usuario = null;
        $("confirmacion").classList.add("oculto");
        $("form-cedula").classList.remove("oculto");
        $("mensaje-paso-1").replaceChildren();
        inputCedula.value = "";
        inputCedula.disabled = false;
        $("btn-buscar").disabled = false;
        mostrarPaso(1);
        inputCedula.focus();
    }

    $("form-cedula").addEventListener("submit", async e => {
        e.preventDefault();
        const cedula = inputCedula.value.trim();
        const mensaje = $("mensaje-paso-1");

        if (!/^\d+$/.test(cedula)) {
            inputCedula.classList.add("invalido");
            aviso(mensaje, "error", "Escribe tu número de cédula (solo números).");
            inputCedula.focus();
            return;
        }

        const boton = $("btn-buscar");
        botonCargando(boton, true, "Buscando…");
        inputCedula.disabled = true;
        mensaje.replaceChildren();

        try {
            const datos = await api(CFG.RUTAS.usuario(cedula));
            if (!datos || !datos.existe || !datos.usuario) {
                aviso(mensaje, "error", "No encontramos tu cédula, verifícala e intenta de nuevo");
                inputCedula.disabled = false;
                inputCedula.select();
                return;
            }
            estado.usuario = { ...datos.usuario, CEDULA: cedula };
            const ciudad = datos.usuario.CIUDAD;
            $("conf-nombre").textContent = datos.usuario.NOMBRE || `cédula ${cedula}`;
            $("conf-ciudad").textContent = ciudad || "";
            $("conf-ciudad-texto").classList.toggle("oculto", !ciudad);
            $("form-cedula").classList.add("oculto");
            $("confirmacion").classList.remove("oculto");
            $("btn-si").focus();
        } catch (err) {
            inputCedula.disabled = false;
            aviso(mensaje, "error", err.message, err.red ? { texto: "Reintentar", accion: () => $("form-cedula").requestSubmit() } : null);
        } finally {
            botonCargando(boton, false);
        }
    });

    $("btn-no").addEventListener("click", reiniciarPaso1);

    $("btn-si").addEventListener("click", async () => {
        const boton = $("btn-si");
        botonCargando(boton, true, "Preparando…");
        $("btn-no").disabled = true;

        try {
            const datos = await api(CFG.RUTAS.crearRegistro(), { method: "POST", body: { cedula: estado.usuario.CEDULA } });
            estado.registro = datos.registro;
            estado.marcas = null; // las marcas dependen del canal del punto
            guardarSesion();
            actualizarEncabezado();
            irAMarcas();
        } catch (err) {
            const mensaje = $("mensaje-paso-1");
            if (err.red) {
                aviso(mensaje, "error", err.message, { texto: "Reintentar", accion: () => $("btn-si").click() });
            } else {
                // p. ej. no seleccionó el punto en el chatbot o el punto ya está cerrado
                $("confirmacion").classList.add("oculto");
                $("form-cedula").classList.remove("oculto");
                inputCedula.disabled = false;
                aviso(mensaje, "error", err.message);
            }
        } finally {
            botonCargando(boton, false);
            $("btn-no").disabled = false;
        }
    });

    // ========== PASO 2: MARCA ==========
    async function irAMarcas() {
        mostrarPaso(2);
        const contenedor = $("contenido-paso-2");
        if (!estado.marcas) {
            vistaCargando(contenedor, "Cargando marcas…");
            try {
                const datos = await api(CFG.RUTAS.marcas(estado.registro._id));
                estado.marcas = (datos.marcas || []).slice().sort((a, b) => a.MARCA.localeCompare(b.MARCA, "es"));
            } catch (err) {
                return vistaError(contenedor, err.message, irAMarcas);
            }
        }
        renderMarcas();
    }

    function renderMarcas() {
        const contenedor = $("contenido-paso-2");
        const total = estado.marcas.length;
        const finalizadas = estado.marcas.filter(m => marcaFinalizada(m.MARCA)).length;

        const relleno = crear("div", { class: "barra__relleno" });
        relleno.style.width = total ? `${(finalizadas / total) * 100}%` : "0";

        const select = crear("select", { id: "select-marca", class: "campo" }, [
            crear("option", { value: "", text: "Selecciona una marca…" }),
        ]);
        for (const m of estado.marcas) {
            const fin = marcaFinalizada(m.MARCA);
            const guardados = cantidadesGuardadas(m.MARCA).size;
            const texto = fin
                ? `${m.MARCA}  ✓ Finalizada`
                : guardados > 0
                    ? `${m.MARCA}  (${guardados} de ${m.TOTAL_PRODUCTOS} registrados)`
                    : `${m.MARCA}  (${m.TOTAL_PRODUCTOS} productos)`;
            select.append(crear("option", { value: m.MARCA, text: texto, disabled: fin }));
        }
        if (estado.marcaActual && !marcaFinalizada(estado.marcaActual)) select.value = estado.marcaActual;

        const continuar = crear("button", {
            class: "btn btn--primario btn--bloque", type: "button", text: "Ver productos",
            disabled: !select.value,
            onclick: () => select.value && abrirMarca(select.value),
        });
        select.addEventListener("change", () => { continuar.disabled = !select.value; });

        // Al terminar todas las marcas el proxy cierra el ingreso (pasa a "fuera de punto"):
        // se borra la sesión local para que la próxima visita empiece desde la cédula
        const terminado = (finalizadas === total && total > 0) || Boolean(estado.registro && estado.registro.INVENTARIO_FINALIZADO);
        if (terminado) borrarSesion();

        contenedor.replaceChildren(
            crear("div", { class: "progreso" }, [
                crear("p", { class: "progreso__texto", text: `Marcas finalizadas: ${finalizadas} de ${total}` }),
                crear("div", { class: "barra", "aria-hidden": "true" }, relleno),
            ]),
            terminado
                ? crear("div", { class: "aviso aviso--exito", role: "status" }, [
                    crear("p", { text: "🎉 ¡Excelente! Finalizaste todas las marcas. El inventario de este punto quedó cerrado." }),
                    crear("button", { class: "btn btn--secundario", type: "button", text: "Salir", onclick: () => $("btn-salir").click() }),
                ])
                : total === 0
                    ? crear("div", { class: "aviso aviso--info", role: "status" }, [
                        crear("p", { text: "No hay marcas para inventariar en este punto de venta." }),
                    ])
                    : crear("div", { class: "selector-marca" }, [
                        crear("label", { for: "select-marca", class: "etiqueta", text: "Marca" }),
                        select,
                        continuar,
                    ]),
            crear("div", { class: "leyenda" }, [
                crear("span", { text: "✓ Finalizada = ya no se puede editar" }),
            ]),
        );
    }

    // ========== PASO 3: CANTIDADES ==========
    async function abrirMarca(marca) {
        estado.marcaActual = marca;
        estado.productos = [];
        estado.filtro = "";
        estado.editando.clear();
        estado.borradores.clear();
        $("buscador").value = "";
        $("titulo-marca").textContent = marca;
        mostrarPaso(3);
        await cargarProductos();
    }

    async function cargarProductos() {
        const lista = $("lista-productos");
        $("barra-finalizar").classList.add("oculto");
        vistaCargando(lista, "Cargando productos…");
        try {
            const datos = await api(CFG.RUTAS.productos(estado.marcaActual, estado.registro._id));
            estado.productos = datos.productos || [];
        } catch (err) {
            return vistaError(lista, err.message, cargarProductos);
        }
        renderMarca();
    }

    function renderMarca() {
        const finalizada = marcaFinalizada(estado.marcaActual);
        $("aviso-finalizada").classList.toggle("oculto", !finalizada);
        $("barra-finalizar").classList.toggle("oculto", finalizada || estado.productos.length === 0);
        renderLista();
        actualizarContador();
    }

    function actualizarContador() {
        const guardadas = cantidadesGuardadas(estado.marcaActual);
        const total = estado.productos.length;
        const registrados = estado.productos.filter(p => guardadas.has(p.PRODUCTO_ID)).length;
        $("contador-texto").textContent = `Registrados ${registrados} de ${total} productos`;
        $("contador-barra").style.width = total ? `${(registrados / total) * 100}%` : "0";
    }

    function productosFiltrados() {
        const f = sinTildes(estado.filtro.trim());
        if (!f) return estado.productos;
        return estado.productos.filter(p => sinTildes(p.DESC).includes(f) || String(p.EAN).includes(f));
    }

    function renderLista() {
        const lista = $("lista-productos");
        const visibles = productosFiltrados();
        if (estado.productos.length === 0) {
            lista.replaceChildren(crear("p", { class: "sin-resultados", text: "Esta marca no tiene productos." }));
            return;
        }
        if (visibles.length === 0) {
            lista.replaceChildren(crear("p", { class: "sin-resultados", text: `No hay productos que coincidan con «${estado.filtro.trim()}».` }));
            return;
        }
        const guardadas = cantidadesGuardadas(estado.marcaActual);
        const finalizada = marcaFinalizada(estado.marcaActual);
        lista.replaceChildren(...visibles.map(p => crearFila(p, guardadas, finalizada)));
    }

    function crearFila(p, guardadas, finalizada) {
        const id = p.PRODUCTO_ID;
        const tieneValor = guardadas.has(id);
        const editando = estado.editando.has(id);
        const guardando = estado.guardando.has(id);

        const tipo = finalizada ? "bloqueada" : editando ? "editando" : tieneValor ? "guardado" : "pendiente";
        const etiquetas = { bloqueada: "Finalizada", editando: "Editando", guardado: "✓ Guardado", pendiente: "Pendiente" };

        const valor = (editando || tipo === "pendiente") && estado.borradores.has(id)
            ? estado.borradores.get(id)
            : tieneValor ? String(guardadas.get(id)) : "";

        const input = crear("input", {
            // inputmode "decimal": teclado de números con separador, sin letras
            id: `cant-${id}`, class: "campo cantidad", type: "text", inputMode: "decimal",
            autocomplete: "off", maxLength: MAX_ENTEROS + 1 + MAX_DECIMALES, placeholder: "Cantidad", value: valor,
            disabled: tipo === "bloqueada" || tipo === "guardado" || guardando,
            "data-id": id,
        });

        let acciones = [];
        if (tipo === "pendiente" || tipo === "editando") {
            const enviar = crear("button", {
                class: "btn btn--exito btn-fila", type: "button", "data-accion": "enviar", "data-id": id,
                "aria-label": `Enviar cantidad de ${p.DESC}`, disabled: guardando,
            });
            if (guardando) enviar.append(crear("span", { class: "spinner spinner--sm", "aria-hidden": "true" }), "Guardando…");
            else enviar.textContent = "✔ Enviar";
            acciones.push(enviar);
            if (tipo === "editando" && !guardando) {
                acciones.push(crear("button", {
                    class: "btn btn--secundario btn-cancelar", type: "button", text: "✕",
                    "data-accion": "cancelar", "data-id": id, "aria-label": `Cancelar edición de ${p.DESC}`, title: "Cancelar",
                }));
            }
        } else if (tipo === "guardado") {
            acciones.push(crear("button", {
                class: "btn btn--secundario btn-fila", type: "button", text: "✏️ Editar",
                "data-accion": "editar", "data-id": id, "aria-label": `Editar cantidad de ${p.DESC}`,
            }));
        } else {
            acciones.push(crear("span", { class: "fila__ean", text: "🔒 Bloqueada" }));
        }

        return crear("div", { class: `fila fila--${tipo}`, role: "listitem", "data-id": id }, [
            crear("div", { class: "fila__info" }, [
                crear("p", { class: "fila__desc", text: p.DESC }),
                crear("p", { class: "fila__ean", text: `EAN ${p.EAN}` }),
                crear("span", { class: "etiqueta-estado", text: etiquetas[tipo] }),
            ]),
            crear("div", { class: "fila__cantidad" }, [
                crear("label", { for: `cant-${id}`, class: "sr-only", text: `Cantidad de ${p.DESC}` }),
                input,
            ]),
            crear("div", { class: "fila__accion" }, acciones),
        ]);
    }

    function refrescarFila(id) {
        const actual = $("lista-productos").querySelector(`.fila[data-id="${id}"]`);
        const p = estado.productos.find(x => x.PRODUCTO_ID === id);
        if (!actual || !p) return null;
        const nueva = crearFila(p, cantidadesGuardadas(estado.marcaActual), marcaFinalizada(estado.marcaActual));
        actual.replaceWith(nueva);
        return nueva;
    }

    // Cédula: bloquea cualquier carácter que no sea dígito (e, -, +, ., , etc.)
    function bloquearNoDigitos(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key && e.key.length === 1 && !/\d/.test(e.key)) e.preventDefault();
    }

    // Deja solo dígitos y un punto: máximo MAX_ENTEROS enteros y MAX_DECIMALES decimales.
    // Conserva el punto final ("5.") para que se pueda seguir escribiendo; ".5" pasa a "0.5".
    function limpiarCantidad(texto) {
        const [enteros, ...resto] = String(texto).replace(/[^\d.]/g, "").split(".");
        const parteEntera = enteros.replace(/^0+(?=\d)/, "").slice(0, MAX_ENTEROS);
        if (resto.length === 0) return parteEntera;
        return `${parteEntera || "0"}.${resto.join("").slice(0, MAX_DECIMALES)}`;
    }

    // Valor final para enviar: "5." -> "5", "" se queda vacío
    const cantidadParaEnviar = texto => limpiarCantidad(texto).replace(/\.$/, "");

    // Avisa que el separador es punto (sin repetir el aviso en cada tecla)
    let ultimoAvisoComa = 0;
    function avisarComa() {
        if (Date.now() - ultimoAvisoComa < 3000) return;
        ultimoAvisoComa = Date.now();
        toast("Usa punto (.) para los decimales, no coma. Ej: 0.5", "aviso", 3500);
    }

    const lista = $("lista-productos");

    lista.addEventListener("keydown", e => {
        if (!e.target.classList.contains("cantidad")) return;
        if (e.key === "Enter") {
            e.preventDefault();
            enviarCantidad(e.target.dataset.id);
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey || !e.key || e.key.length !== 1) return;
        if (e.key === ",") {
            e.preventDefault();
            avisarComa();
        } else if (!/[\d.]/.test(e.key) || (e.key === "." && e.target.value.includes("."))) {
            e.preventDefault();
        }
    });

    // Cubre escritura, pegado y autocompletado del teclado del celular (en Android el keydown no
    // siempre trae la tecla, así que aquí también se quitan comas y letras)
    lista.addEventListener("input", e => {
        if (!e.target.classList.contains("cantidad")) return;
        if (e.target.value.includes(",")) avisarComa();
        const limpio = limpiarCantidad(e.target.value.replace(/,/g, ""));
        if (limpio !== e.target.value) e.target.value = limpio;
        e.target.classList.remove("invalido");
        estado.borradores.set(e.target.dataset.id, limpio);
    });

    lista.addEventListener("click", e => {
        const boton = e.target.closest("button[data-accion]");
        if (!boton) return;
        const id = boton.dataset.id;
        if (boton.dataset.accion === "enviar") enviarCantidad(id);
        else if (boton.dataset.accion === "editar") editarCantidad(id);
        else if (boton.dataset.accion === "cancelar") cancelarEdicion(id);
    });

    function editarCantidad(id) {
        if (marcaFinalizada(estado.marcaActual)) return;
        const guardadas = cantidadesGuardadas(estado.marcaActual);
        estado.editando.add(id);
        estado.borradores.set(id, guardadas.has(id) ? String(guardadas.get(id)) : "");
        const fila = refrescarFila(id);
        const input = fila && fila.querySelector(".cantidad");
        if (input) { input.focus(); input.select(); }
    }

    function cancelarEdicion(id) {
        estado.editando.delete(id);
        estado.borradores.delete(id);
        refrescarFila(id);
    }

    async function enviarCantidad(id) {
        if (estado.guardando.has(id) || marcaFinalizada(estado.marcaActual)) return;
        const producto = estado.productos.find(p => p.PRODUCTO_ID === id);
        const valor = cantidadParaEnviar(estado.borradores.get(id) || "");

        if (valor === "") {
            const input = $(`cant-${id}`);
            if (input) { input.classList.add("invalido"); input.focus(); }
            toast("Escribe la cantidad antes de enviar (usa 0 si no hay unidades).", "aviso");
            return;
        }

        estado.guardando.add(id);
        refrescarFila(id);

        try {
            const datos = await api(CFG.RUTAS.guardarProducto(estado.registro._id), {
                method: "PUT",
                body: { productoId: id, cantidad: Number(valor) },
            });
            estado.registro = datos.registro;
            estado.editando.delete(id);
            estado.borradores.delete(id);
            estado.guardando.delete(id);
            refrescarFila(id);
            actualizarContador();
            toast(`Guardado: ${producto ? producto.DESC : "producto"} = ${valor}`, "exito");
            enfocarSiguientePendiente(id);
        } catch (err) {
            estado.guardando.delete(id);
            if (err.status === 409) {
                // La marca fue finalizada (p. ej. desde otro dispositivo): se recarga el registro
                await recargarRegistro();
                renderMarca();
            } else {
                refrescarFila(id);
            }
            toast(err.message, "error", 4500);
        }
    }

    function enfocarSiguientePendiente(idActual) {
        const filas = [...lista.querySelectorAll(".fila")];
        const desde = filas.findIndex(f => f.dataset.id === idActual);
        const siguiente = filas.slice(desde + 1).find(f => f.classList.contains("fila--pendiente"));
        const input = siguiente && siguiente.querySelector(".cantidad");
        if (input) input.focus({ preventScroll: false });
    }

    async function recargarRegistro() {
        try {
            const datos = await api(CFG.RUTAS.registro(estado.registro._id));
            estado.registro = datos.registro;
        } catch (e) { /* se mantiene el registro local */ }
    }

    $("buscador").addEventListener("input", e => {
        estado.filtro = e.target.value;
        renderLista();
    });

    $("btn-cambiar-marca").addEventListener("click", () => {
        if (estado.editando.size > 0 && !confirm("Tienes cantidades en edición sin enviar. ¿Salir de todas formas?")) return;
        irAMarcas();
    });

    // ========== FINALIZAR MARCA ==========
    // Cantidades escritas en pantalla que aún no se han enviado (o que cambian lo guardado).
    // Una fila en edición con el campo vacío conserva su valor guardado.
    function cantidadesSinEnviar() {
        const guardadas = cantidadesGuardadas(estado.marcaActual);
        const sinEnviar = [];
        for (const p of estado.productos) {
            const borrador = cantidadParaEnviar(estado.borradores.get(p.PRODUCTO_ID) || "");
            if (borrador === "") continue;
            if (guardadas.get(p.PRODUCTO_ID) === Number(borrador)) continue;
            sinEnviar.push({ productoId: p.PRODUCTO_ID, cantidad: Number(borrador) });
        }
        return sinEnviar;
    }

    $("btn-finalizar").addEventListener("click", () => {
        const marca = estado.marcaActual;
        if (marcaFinalizada(marca)) return;

        if (estado.guardando.size > 0) {
            toast("Espera un momento a que terminen de guardarse las cantidades enviadas.", "aviso", 3500);
            return;
        }

        const guardadas = cantidadesGuardadas(marca);
        const sinEnviar = cantidadesSinEnviar();
        const conValor = new Set([...guardadas.keys(), ...sinEnviar.map(c => c.productoId)]);
        const faltantes = estado.productos.filter(p => !conValor.has(p.PRODUCTO_ID));
        if (faltantes.length > 0) return modalFaltantes(faltantes);

        const n = sinEnviar.length;
        const texto = n > 0
            ? `Se ${n === 1 ? "guardará 1 cantidad que aún no habías enviado" : `guardarán ${n} cantidades que aún no habías enviado`} y se finalizará la marca. Una vez finalizada no podrás editarla. ¿Confirmas?`
            : "Una vez finalizada no podrás editar esta marca. ¿Confirmas?";

        abrirModal({
            titulo: `¿Finalizar ${marca}?`,
            cuerpo: crear("p", { text: texto }),
            botones: [
                { texto: n > 0 ? "Sí, guardar y finalizar" : "Sí, finalizar", clase: "btn--primario", accion: e => confirmarFinalizar(e.currentTarget, sinEnviar) },
                { texto: "Cancelar", accion: cerrarModal },
            ],
        });
    });

    function modalFaltantes(faltantes) {
        const n = faltantes.length;
        const items = faltantes.slice(0, MAX_FALTANTES_MODAL).map(p => crear("li", { text: p.DESC }));
        const cuerpo = [crear("ul", {}, items)];
        if (n > MAX_FALTANTES_MODAL) cuerpo.push(crear("p", { class: "modal__mas", text: `…y ${n - MAX_FALTANTES_MODAL} más` }));

        abrirModal({
            titulo: `Te faltan ${n} ${n === 1 ? "producto" : "productos"} por registrar`,
            cuerpo,
            botones: [
                { texto: "Volver y completar", clase: "btn--primario", accion: () => { cerrarModal(); irAProducto(faltantes[0].PRODUCTO_ID); } },
                { texto: "Cancelar", accion: cerrarModal },
            ],
        });
    }

    // Lleva y resalta un producto (quitando el filtro si lo oculta)
    function irAProducto(id) {
        if (estado.filtro) {
            estado.filtro = "";
            $("buscador").value = "";
            renderLista();
        }
        const fila = lista.querySelector(`.fila[data-id="${id}"]`);
        if (!fila) return;
        fila.scrollIntoView({ behavior: "smooth", block: "center" });
        fila.classList.remove("fila--resaltada");
        void fila.offsetWidth; // reinicia la animación
        fila.classList.add("fila--resaltada");
        const input = fila.querySelector(".cantidad:not(:disabled)");
        if (input) setTimeout(() => input.focus({ preventScroll: true }), 350);
    }

    // Envía en un solo paso las cantidades pendientes de envío y finaliza la marca
    async function confirmarFinalizar(boton, cantidades) {
        const marca = estado.marcaActual;
        botonCargando(boton, true, cantidades.length > 0 ? "Guardando y finalizando…" : "Finalizando…");
        $("modal-botones").querySelectorAll("button").forEach(b => { b.disabled = true; });

        try {
            const datos = await api(CFG.RUTAS.finalizarMarca(estado.registro._id, marca), {
                method: "POST",
                body: { cantidades },
            });
            estado.registro = datos.registro;
            estado.editando.clear();
            estado.borradores.clear();
            cerrarModal();
            toast(datos.inventarioFinalizado
                ? "✓ ¡Inventario completo! Terminaste todas las marcas de este punto."
                : `✓ Marca ${marca} finalizada`, "exito", 4000);
            estado.marcaActual = null;
            irAMarcas();
        } catch (err) {
            cerrarModal();
            if (err.status === 409 && err.datos && Array.isArray(err.datos.faltantes)) {
                await recargarRegistro();
                renderMarca();
                modalFaltantes(err.datos.faltantes);
            } else {
                if (err.status === 409) { await recargarRegistro(); renderMarca(); }
                toast(err.message, "error", 4500);
            }
        }
    }

    // ========== SALIR ==========
    $("btn-salir").addEventListener("click", () => {
        if (estado.editando.size > 0 && !confirm("Tienes cantidades en edición sin enviar. ¿Salir de todas formas?")) return;
        borrarSesion();
        estado.registro = null;
        estado.marcas = null;
        estado.marcaActual = null;
        estado.editando.clear();
        estado.borradores.clear();
        actualizarEncabezado();
        reiniciarPaso1();
    });

    // ========== INICIO: retomar sesión del día si existe ==========
    async function iniciar() {
        mostrarPaso(1);
        const sesion = leerSesion();
        if (!sesion) {
            inputCedula.focus();
            return;
        }

        const mensaje = $("mensaje-paso-1");
        $("form-cedula").classList.add("oculto");
        vistaCargando(mensaje, "Recuperando tu progreso…");
        try {
            const datos = await api(CFG.RUTAS.registro(sesion.id));
            estado.registro = datos.registro;
            mensaje.replaceChildren();
            $("form-cedula").classList.remove("oculto");
            actualizarEncabezado();
            irAMarcas();
        } catch (err) {
            $("form-cedula").classList.remove("oculto");
            if (err.red) {
                aviso(mensaje, "error", "No pudimos recuperar tu progreso. " + err.message, { texto: "Reintentar", accion: iniciar });
            } else {
                borrarSesion();
                mensaje.replaceChildren();
                inputCedula.focus();
            }
        }
    }

    iniciar();
})();
