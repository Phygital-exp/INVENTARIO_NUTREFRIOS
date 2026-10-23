// ========== CONFIGURACIÓN DEL FRONT ==========
// Único lugar donde se definen las URLs del backend (proxy en Railway).
window.APP_CONFIG = {
    API_BASE_URL: "https://inventarionutrefrios-production.up.railway.app",

    RUTAS: {
        usuario: cedula => `/api/usuarios/${encodeURIComponent(cedula)}`,
        crearRegistro: () => "/api/registros",
        registro: id => `/api/registros/${encodeURIComponent(id)}`,
        // Con el registro, el proxy filtra marcas y productos por el canal del punto de venta
        marcas: id => `/api/marcas?registro=${encodeURIComponent(id)}`,
        productos: (marca, id) =>
            `/api/productos?marca=${encodeURIComponent(marca)}&registro=${encodeURIComponent(id)}`,
        guardarProducto: id => `/api/registros/${encodeURIComponent(id)}/producto`,
        finalizarMarca: (id, marca) =>
            `/api/registros/${encodeURIComponent(id)}/marcas/${encodeURIComponent(marca)}/finalizar`,
    },

    // Tiempo máximo de espera por petición (ms)
    TIMEOUT_MS: 25000,
};
