/*************************************************
 * 0) Estado global
 *************************************************/
let STATE = {
  asesorActual: "", // ya no se usa para filtrar en Bitrix
  asesorId: "",
  filtros: {
    campanas: new Set(),
    asesores: new Set(),
    inicio: "",
    fin: "",
  },
  search: "",
  rows: [], // filas para la tabla (negocios)
  campanasDisponibles: [],
  asesoresDisponibles: [],
};
STATE.cardVisualStatus = loadCardStatusMap();
const LS_CARD_STATUS_KEY = "vyv_card_status_v1";

// === TEMP: desactivar login inicial (mostrar HOME directo) ===
const DISABLE_LOGIN = true;

function loadCardStatusMap() {
  try {
    return JSON.parse(localStorage.getItem(LS_CARD_STATUS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveCardStatusMap(map) {
  localStorage.setItem(LS_CARD_STATUS_KEY, JSON.stringify(map || {}));
}
function setVisualCompleted(dealId) {
  const map = loadCardStatusMap();
  map[String(dealId)] = "Completado";
  STATE.cardVisualStatus = map;
  saveCardStatusMap(map);
}

/*************************************************
 * helpers DOM
 *************************************************/
const qs = (s, ctx = document) => ctx.querySelector(s);
const qsa = (s, ctx = document) => [...ctx.querySelectorAll(s)];
const showById = (id) => qs(id).classList.remove("hidden");
const hideById = (id) => qs(id).classList.add("hidden");

const chipEstado = (texto) => {
  const base =
    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold";

  if (!texto) {
    return `<span class="${base} bg-gray-100 text-gray-700">Sin estado</span>`;
  }

  const raw = String(texto).trim();
  const t = raw.toLowerCase();

  // OK Estados de CAMPANA
  if (t.includes("activa")) {
    return `<span class="${base} bg-emerald-100 text-emerald-700">${raw}</span>`;
  }
  if (t.includes("finalizada") || t.includes("finalizado")) {
    return `<span class="${base} bg-indigo-100 text-indigo-700">${raw}</span>`;
  }
  if (t.includes("cancelada") || t.includes("cancelado")) {
    return `<span class="${base} bg-rose-100 text-rose-700">${raw}</span>`;
  }

  // OK Estados del CLIENTE (se mantienen)
  if (t.includes("interesado") && !t.includes("no")) {
    return `<span class="${base} bg-[#e6f7ef] text-[#1a7f4b]">${raw}</span>`;
  }
  if (t.includes("no interesado") || t.includes("no_interesado")) {
    return `<span class="${base} bg-[#ffecef] text-[#b91937]">${raw}</span>`;
  }
  if (t.includes("inseguro") || t.includes("seguimiento")) {
    return `<span class="${base} bg-[#fff8e6] text-[#a56a00]">${raw}</span>`;
  }

  return `<span class="${base} bg-gray-100 text-gray-700">${raw}</span>`;
};

// === Helper Bitrix: paginacion completa (trae TODOS los registros) ===
function bxList(method, params = {}) {
  return new Promise((resolve, reject) => {
    let all = [];

    BX24.callMethod(method, params, function (result) {
      if (result.error()) {
        console.error(`Error en ${method}:`, result.error());
        reject(result.error());
        return;
      }

      const data = result.data() || [];
      all = all.concat(data);

      // Si hay mas paginas, continuar
      if (result.more()) {
        result.next();
      } else {
        resolve(all);
      }
    });
  });
}

// === Diccionario de municipio (UF lista) ===
let MUNICIPIO_ENUM = {}; // ID -> Texto
let MUNICIPIO_ENUM_BY_TEXT = {}; // texto normalizado -> ID
let CAMPANA_ENUM = {}; // ID -> Texto (UF_CRM_1768059328177)
let CAMPANA_ENUM_BY_TEXT = {}; // texto normalizado -> ID
let PRODUCT_CAMPANA_BY_NAME = null; // cache: nombre lower -> { id, name }

function statusColorClass(estado) {
  const s = String(estado || "").toLowerCase();

  // Ajusta textos a los tuyos reales:
  if (s.includes("completado")) return "text-green-600";
  if (s.includes("por completar") || s.includes("pendiente"))
    return "text-orange-500";
  if (s.includes("cancelado")) return "text-red-500";

  return "text-slate-500"; // default
}

function loadMunicipioEnum() {
  return new Promise((resolve, reject) => {
    BX24.callMethod("crm.contact.fields", {}, function (result) {
      if (result.error()) {
        reject(result.error());
        return;
      }
      const fields = result.data();
      const f = fields["UF_CRM_1722975246"];
      if (!f || !f.items) {
        resolve();
        return;
      }

      MUNICIPIO_ENUM = {};
      MUNICIPIO_ENUM_BY_TEXT = {};

      f.items.forEach((it) => {
        const id = String(it.ID);
        const text = String(it.VALUE || "").trim();
        MUNICIPIO_ENUM[id] = text;
        MUNICIPIO_ENUM_BY_TEXT[text.toLowerCase()] = id;
      });

      resolve();
    });
  });
}

function loadCampanaEnum() {
  return new Promise((resolve, reject) => {
    if (Object.keys(CAMPANA_ENUM).length) {
      resolve();
      return;
    }

    BX24.callMethod("crm.contact.fields", {}, function (result) {
      if (result.error()) {
        reject(result.error());
        return;
      }
      const fields = result.data();
      const f = fields["UF_CRM_1768059328177"];
      if (!f || !f.items) {
        resolve();
        return;
      }

      CAMPANA_ENUM = {};
      CAMPANA_ENUM_BY_TEXT = {};

      f.items.forEach((it) => {
        const id = String(it.ID);
        const text = String(it.VALUE || "").trim();
        CAMPANA_ENUM[id] = text;
        CAMPANA_ENUM_BY_TEXT[text.toLowerCase()] = id;
      });

      resolve();
    });
  });
}

async function loadDealsFromBitrix() {
  const filter = {
    CATEGORY_ID: 10,
    STAGE_ID: "C10:NEW",
  };

  const params = {
    filter,
    select: [
      "ID",
      "TITLE",
      "ASSIGNED_BY_ID",
      "CONTACT_ID",
      "STAGE_ID",
      "DATE_CREATE",
      // nombre de campana
      "UF_CRM_1759207518343",
      // estado de cliente
      "UF_CRM_1764401898591",
      "UF_CRM_1764444016968",
    ],
  };

  // 1) Traemos los deals (solo primera pagina)
  const deals = await bxList("crm.deal.list", params);

  // 2) Sacamos los CONTACT_ID unicos
  const contactIds = [
    ...new Set(
      deals
        .map((d) => d.CONTACT_ID)
        .filter((id) => id && String(id).trim() !== "")
        .map((id) => String(id)),
    ),
  ];

  // 3) Mapa de contactos: ID -> datos completos
  const contactMap = {};

  if (contactIds.length) {
    const contacts = await bxList("crm.contact.list", {
      filter: { ID: contactIds },
      select: [
        "ID",
        "NAME",
        "LAST_NAME",
        "SECOND_NAME",
        "UF_CRM_1722975246", // MUNICIPIO
        "PHONE", // TELEFONOS
        "EMAIL", // EMAILS
      ],
    });

    contacts.forEach((c) => {
      const id = String(c.ID);

      // Campos basicos
      const name = c.NAME || "";
      const last = c.LAST_NAME || "";

      // PHONE y EMAIL -> vienen como array [{VALUE:""}]
      const phoneArr = Array.isArray(c.PHONE) ? c.PHONE : [];
      const emailArr = Array.isArray(c.EMAIL) ? c.EMAIL : [];

      const phone = phoneArr[0]?.VALUE || "";
      const email = emailArr[0]?.VALUE || "";

      // MUNICIPIO
      const municipio = c.UF_CRM_1722975246 || "";

      // Guardar todo en mapa
      contactMap[id] = {
        NAME: name,
        LAST_NAME: last,
        SECOND_NAME: c.SECOND_NAME || "",
        phone,
        email,
        municipio,
      };
    });
  }
  // 3.5) Precargar estado de campana por producto (PROPERTY_358)
  const productIds = [
    ...new Set(
      deals
        .map((d) => d.UF_CRM_1764444016968)
        .filter(Boolean)
        .map((x) => String(x)),
    ),
  ];

  const productEstadoById = {};
  await Promise.all(
    productIds.map(async (pid) => {
      try {
        const info = await fetchProductInfo(pid); // usa PROPERTY_358.value
        productEstadoById[pid] = info?.estado || "-";
      } catch {
        productEstadoById[pid] = "-";
      }
    }),
  );

  // 4) Mapeamos a la estructura de la tabla

  STATE.rows = deals.map((d) => {
    const contactId = d.CONTACT_ID ? String(d.CONTACT_ID) : "";
    let nombreCliente = d.TITLE || `Negocio #${d.ID}`;
    let email = "";
    let phone = "";
    let municipioId = "";

    if (contactId && contactMap[contactId]) {
      const c = contactMap[contactId];
      nombreCliente = [c.NAME, c.LAST_NAME].filter(Boolean).join(" ");
      email = c.email || "";
      phone = c.phone || "";
      municipioId = c.municipio || "";
    }

    const campanaNombre = d.UF_CRM_1759207518343 || "";
    const estadoValor = d.UF_CRM_1764401898591 || "";

    const asesor = d.ASSIGNED_BY_ID || "";

    //  AQUI: guardamos el UF tal cual (o null si viene vacio)
    const productId = d.UF_CRM_1764444016968
      ? String(d.UF_CRM_1764444016968)
      : null;

    const municipioTxt = MUNICIPIO_ENUM[String(municipioId)] || "";
    const estadoCampanaFila = productId
      ? productEstadoById[productId] || "-"
      : "-";
    return {
      id: d.ID,
      contactId,
      nombre: nombreCliente,
      asesor,
      campanaFila: campanaNombre || "",
      estadoFila: estadoCampanaFila,
      email,
      phone,
      place: municipioTxt,
      municipioId,
      productId,
      estadoCliente: estadoValor || "",
    };
  });

  STATE.campanasDisponibles = [
    ...new Set(STATE.rows.map((r) => r.campanaFila).filter(Boolean)),
  ];
  STATE.asesoresDisponibles = [
    ...new Set(STATE.rows.map((r) => r.asesor).filter(Boolean)),
  ];
}

async function fetchActiveDealsByContact(contactId) {
  if (!contactId) return [];
  return await bxList("crm.deal.list", {
    filter: {
      CATEGORY_ID: 10,
      STAGE_ID: "C10:NEW",
      CONTACT_ID: String(contactId),
    },
    select: [
      "ID",
      "TITLE",
      "CONTACT_ID",
      "ASSIGNED_BY_ID",
      "UF_CRM_1759207518343",
      "UF_CRM_1764401898591",
      "UF_CRM_68911F4662EF3",
      "UF_CRM_1764444016968",
    ],
  });
}

function fetchContactById(contactId) {
  return new Promise((resolve, reject) => {
    if (!contactId) {
      resolve(null);
      return;
    }
    BX24.callMethod("crm.contact.get", { id: String(contactId) }, (result) => {
      if (result.error()) {
        reject(result.error());
        return;
      }
      resolve(result.data() || null);
    });
  });
}

function formatDateOnly(value) {
  if (!value) return "";
  return String(value).split(" ")[0].split("T")[0];
}

// === Helper: obtener info del producto desde crm.product.get ===
function fetchProductInfo(productId) {
  return new Promise((resolve, reject) => {
    if (!productId) {
      resolve(null);
      return;
    }

    BX24.callMethod("crm.product.get", { id: productId }, function (result) {
      if (result.error()) {
        console.error("Error en crm.product.get:", result.error());
        reject(result.error());
        return;
      }

      const p = result.data();

      if (!p) {
        resolve(null);
        return;
      }

      //  CAMPOS CORREGIDOS
      const nombreProd = p.NAME || "Sin nombre";

      //  PROPERTIES CORRECTAS
      const propInicio = p.property360 || p.PROPERTY_360 || {};
      const propEstado = p.property358 || p.PROPERTY_358 || {};
      const propFin = p.property356 || p.PROPERTY_356 || {};

      const fechaInicio = formatDateOnly(propInicio.value);
      const estado = propEstado.value || "-";
      const fechaFin = formatDateOnly(propFin.value);

      resolve({
        nombreProd,
        fechaInicio,
        estado,
        fechaFin,
      });
    });
  });
}

async function fetchProductsForCampanas() {
  if (PRODUCT_CAMPANA_BY_NAME) return PRODUCT_CAMPANA_BY_NAME;

  const products = await bxList("crm.product.list", {
    filter: { CATALOG_ID: 24, SECTION_ID: 114 },
    select: ["ID", "NAME"],
  });

  const map = {};
  products.forEach((p) => {
    const name = String(p.NAME || "").trim();
    if (!name) return;
    map[name.toLowerCase()] = { id: String(p.ID || ""), name };
  });

  PRODUCT_CAMPANA_BY_NAME = map;
  return map;
}
function showGlobalLoader(text = "Cargando informacion...") {
  const loader = document.getElementById("global-loader");
  if (!loader) return;

  const p = loader.querySelector("p");
  if (p) p.textContent = text;

  loader.classList.remove("hidden");
  loader.classList.add("flex");
}

function hideGlobalLoader() {
  const loader = document.getElementById("global-loader");
  if (!loader) return;

  loader.classList.add("hidden");
  loader.classList.remove("flex");
}

function setLoginError(msg) {
  const el = qs("#in-asesor-error");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("hidden");
}

function clearLoginError() {
  const el = qs("#in-asesor-error");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

async function validateAsesorSecondName(value) {
  const term = String(value || "").trim();
  if (!term) return false;

  try {
    const users = await bxList("user.get", {
      filter: { SECOND_NAME: term },
      select: ["ID", "SECOND_NAME"],
    });
    const match = users.find(
      (u) =>
        String(u.SECOND_NAME || "")
          .trim()
          .toLowerCase() === term.toLowerCase(),
    );
    if (!match) return null;
    return { id: String(match.ID || ""), secondName: match.SECOND_NAME || "" };
  } catch (e) {
    console.error("Error validando asesor en Bitrix24:", e);
    return null;
  }
}

/*************************************************
 * UI: MultiSelect estilo "Selecciona opciones"
 *************************************************/
function initMultiSelect(root, cfg = {}) {
  const options = Array.isArray(cfg.options) ? cfg.options : [];
  const selected = cfg.selected instanceof Set ? cfg.selected : new Set();
  const placeholder = cfg.placeholder || "Selecciona opciones";
  const onChange = typeof cfg.onChange === "function" ? cfg.onChange : () => {};

  const trigger = root.querySelector("[data-ms-trigger]");
  const labelEl = root.querySelector("[data-ms-label]");
  const chevron = root.querySelector("[data-ms-chevron]");
  const panel = root.querySelector("[data-ms-panel]");
  const search = root.querySelector("[data-ms-search]");
  const optWrap = root.querySelector("[data-ms-options]");
  const btnAll = root.querySelector("[data-ms-all]");
  const btnClear = root.querySelector("[data-ms-clear]");
  const btnClose = root.querySelector("[data-ms-close]");

  if (!trigger || !panel || !optWrap || !labelEl) {
    console.warn("MultiSelect incompleto:", root);
    return null;
  }

  // --- Render opciones ---
  optWrap.innerHTML = "";
  const rowEls = [];

  options.forEach((opt) => {
    const value = String(opt.value ?? opt.id ?? opt);
    const text = String(opt.label ?? opt.text ?? opt).trim();

    const row = document.createElement("label");
    row.className =
      "flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-slate-50 cursor-pointer";
    row.dataset.value = value;
    row.dataset.text = text.toLowerCase();

    row.innerHTML = `
      <input type="checkbox"
        class="h-4 w-4 rounded border-slate-300 text-[#1d73ea] focus:ring-[#1d73ea]/30" />
      <span class="text-sm text-slate-700">${text}</span>
    `;

    const cb = row.querySelector("input");
    cb.checked = selected.has(value);

    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(value);
      else selected.delete(value);
      updateLabel();
      onChange(new Set(selected));
    });

    rowEls.push(row);
    optWrap.appendChild(row);
  });

  function updateLabel() {
    const count = selected.size;
    if (!count) {
      labelEl.textContent = placeholder;
      labelEl.classList.add("text-slate-500");
      labelEl.classList.remove("text-slate-700");
      return;
    }

    // Si es 1, mostramos el texto seleccionado; si son varios, mostramos el conteo
    if (count === 1) {
      const only = [...selected][0];
      const found = rowEls.find((r) => r.dataset.value === String(only));
      const txt = found ? found.querySelector("span")?.textContent : null;
      labelEl.textContent = txt || "1 seleccionado";
    } else {
      labelEl.textContent = `${count} seleccionados`;
    }
    labelEl.classList.remove("text-slate-500");
    labelEl.classList.add("text-slate-700");
  }

  function open() {
    panel.classList.remove("hidden");
    if (chevron) chevron.classList.add("rotate-180");
    if (search) {
      search.value = "";
      filter("");
      search.focus();
    }
  }
  function close() {
    panel.classList.add("hidden");
    if (chevron) chevron.classList.remove("rotate-180");
  }
  function toggle() {
    panel.classList.contains("hidden") ? open() : close();
  }

  function filter(termRaw) {
    const term = String(termRaw || "")
      .trim()
      .toLowerCase();
    rowEls.forEach((row) => {
      const ok = !term || (row.dataset.text || "").includes(term);
      row.classList.toggle("hidden", !ok);
    });
  }

  // --- Eventos ---
  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  panel.addEventListener("click", (e) => e.stopPropagation());

  if (search) {
    search.addEventListener("input", (e) => filter(e.target.value));
  }

  if (btnClose) btnClose.addEventListener("click", close);

  if (btnClear) {
    btnClear.addEventListener("click", () => {
      selected.clear();
      rowEls.forEach((r) => {
        const cb = r.querySelector("input");
        if (cb) cb.checked = false;
      });
      updateLabel();
      onChange(new Set(selected));
    });
  }

  if (btnAll) {
    btnAll.addEventListener("click", () => {
      // Marca solo lo visible (si hay busqueda) para que sea mas util
      const visibles = rowEls.filter((r) => !r.classList.contains("hidden"));
      const target = visibles.length ? visibles : rowEls;

      target.forEach((r) => {
        const cb = r.querySelector("input");
        if (cb && !cb.checked) {
          cb.checked = true;
          selected.add(String(r.dataset.value));
        }
      });
      updateLabel();
      onChange(new Set(selected));
    });
  }

  // Cerrar al hacer click fuera
  document.addEventListener("click", () => close());

  // Cerrar con ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // Estado inicial
  updateLabel();

  return {
    open,
    close,
    getSelected: () => new Set(selected),
    setOptions: (newOptions = []) => {
      // si lo necesitas luego, lo podemos implementar
      console.warn("setOptions aun no esta implementado", newOptions);
    },
  };
}

/*************************************************
 * 3) Inicio (login + Bitrix init)
 *************************************************/
document.addEventListener("DOMContentLoaded", () => {
  // === Login desactivado temporalmente: entrar directo a HOME ===
  if (DISABLE_LOGIN) {
    (async () => {
      try {
        // Cambiamos de vista
        hideById("#view-login");
        showById("#view-home");

        showGlobalLoader("Cargando informacion...");

        if (window.BX24) {
          await new Promise((resolve) => BX24.init(resolve));

          showGlobalLoader("Cargando municipios...");
          await loadMunicipioEnum();

          showGlobalLoader("Cargando campanas...");
          await loadDealsFromBitrix();
        } else {
          console.warn("BX24 no esta definido. Front sin datos reales.");
        }

        showGlobalLoader("Preparando vista...");
        initHome();
      } catch (e) {
        console.error("Error iniciando en HOME (login desactivado):", e);
        initHome();
      } finally {
        hideGlobalLoader();
      }
    })();
    return;
  }

  const btnLogin = qs("#btn-login");
  const asesorInput = qs("#in-asesor");

  if (!btnLogin) {
    console.error("No se encontro el boton #btn-login");
    return;
  }

  if (asesorInput) {
    asesorInput.addEventListener("input", () => clearLoginError());
  }

  btnLogin.addEventListener("click", async () => {
    const n = asesorInput?.value.trim() || "";
    clearLoginError();
    if (!n) {
      setLoginError("Ingresa tu numero de asesor para continuar.");
      return;
    }

    if (!window.BX24) {
      console.warn("BX24 no esta definido. Front sin datos reales.");
      alert(
        "No se encontro BX24. Estas viendo solo el front sin datos reales.",
      );

      STATE.asesorActual = n;
      STATE.asesorId = "";
      showGlobalLoader("Cargando informacion...");

      // Cambiamos de vista
      hideById("#view-login");
      showById("#view-home");

      initHome();

      hideGlobalLoader(); // Ojo. importante
      return;
    }

    showGlobalLoader("Validando asesor...");

    try {
      await new Promise((resolve) => BX24.init(resolve));
      const user = await validateAsesorSecondName(n);
      if (!user || !user.id) {
        setLoginError(
          "No encontramos ese asesor en Bitrix24 (campo SECOND_NAME).",
        );
        hideGlobalLoader();
        return;
      }

      STATE.asesorActual = n;
      STATE.asesorId = user.id;

      showGlobalLoader("Cargando informacion...");

      // Cambiamos de vista
      hideById("#view-login");
      showById("#view-home");

      showGlobalLoader("Cargando municipios...");
      await loadMunicipioEnum();

      showGlobalLoader("Cargando campanas...");
      await loadDealsFromBitrix();

      showGlobalLoader("Preparando vista...");
      initHome();
    } catch (e) {
      console.error("Error al cargar crm.deal.list:", e);
      alert("Error cargando negocios desde Bitrix24. Revisa la consola.");
      initHome();
    } finally {
      hideGlobalLoader(); // Ojo. siempre lo apaga
    }
  });
});
/*************************************************
 * 4) Home: busqueda, filtros y tabla
 *************************************************/
function initHome() {
  // Buscar
  qs("#buscar").addEventListener("input", (e) => {
    STATE.search = e.target.value.trim().toLowerCase();
    renderTabla();
  });
  // === Filtro de campanas (multiselect) ===
  const msCamp = qs("#ms-campanias");

  if (msCamp) {
    const lbl = msCamp.querySelector("[data-ms-label]");
    const trigger = msCamp.querySelector("[data-ms-trigger]");

    if (STATE.campanasDisponibles.length === 0) {
      if (trigger) trigger.disabled = true;
      if (lbl) {
        lbl.textContent = "No hay campanas registradas";
        lbl.classList.add("text-slate-400");
      }
    } else {
      if (trigger) trigger.disabled = false;

      initMultiSelect(msCamp, {
        options: STATE.campanasDisponibles
          .map((c) => String(c || "").trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
          .map((c) => ({ value: c, label: c })),
        selected: STATE.filtros.campanas,
        placeholder: "Selecciona opciones",
        onChange: (set) => {
          // Guardamos seleccion en STATE (se aplica al presionar "Aplicar")
          STATE.filtros.campanas =
            set instanceof Set ? set : new Set(set || []);
        },
      });
    }
  }

  // === Filtro de asesores (multiselect) ===
  const msAses = qs("#ms-asesores");

  if (msAses) {
    const lbl = msAses.querySelector("[data-ms-label]");
    const trigger = msAses.querySelector("[data-ms-trigger]");

    if (STATE.asesoresDisponibles.length === 0) {
      if (trigger) trigger.disabled = true;
      if (lbl) {
        lbl.textContent = "No hay asesores";
        lbl.classList.add("text-slate-400");
      }
    } else {
      if (trigger) trigger.disabled = false;

      initMultiSelect(msAses, {
        options: STATE.asesoresDisponibles
          .map((a) => String(a || "").trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
          .map((a) => ({ value: a, label: `Asesor ${a}` })),
        selected: STATE.filtros.asesores,
        placeholder: "Selecciona asesores",
        onChange: (set) => {
          // Guardamos seleccion en STATE (se aplica al presionar "Aplicar")
          STATE.filtros.asesores =
            set instanceof Set ? set : new Set(set || []);
        },
      });
    }
  }

  // Fechas (guardamos valores por si luego filtramos por DATE_CREATE)
  const fxInicio = qs("#fx-inicio");
  const fxFin = qs("#fx-fin");

  if (fxInicio) {
    fxInicio.addEventListener(
      "change",
      (e) => (STATE.filtros.inicio = e.target.value),
    );
  }
  if (fxFin) {
    fxFin.addEventListener(
      "change",
      (e) => (STATE.filtros.fin = e.target.value),
    );
  }

  // Drawer
  const btnFiltros = qs("#btn-filtros");
  const btnCloseDrawer = qs("#btn-close-drawer");
  const btnCancelarFiltros = qs("#btn-cancelar-filtros");
  const btnAplicarFiltros = qs("#btn-aplicar-filtros");

  if (btnFiltros) btnFiltros.addEventListener("click", openDrawer);
  if (btnCloseDrawer) btnCloseDrawer.addEventListener("click", closeDrawer);
  if (btnCancelarFiltros)
    btnCancelarFiltros.addEventListener("click", closeDrawer);
  if (btnAplicarFiltros)
    btnAplicarFiltros.addEventListener("click", () => {
      closeDrawer();
      renderTabla();
    });

  renderTabla();
}

function openDrawer() {
  const d = qs("#drawer");
  if (!d) return;
  d.classList.remove("hidden");
  requestAnimationFrame(() =>
    d.classList.replace("translate-x-full", "translate-x-0"),
  );
}
function closeDrawer() {
  const d = qs("#drawer");
  if (!d) return;
  d.classList.replace("translate-x-0", "translate-x-full");
  setTimeout(() => d.classList.add("hidden"), 250);
}

function applyFilters(rows) {
  const norm = (v) => String(v || "").trim();

  // campanas (0 = no filtra, 1 o varias = filtra por cualquiera seleccionada)
  if (STATE.filtros.campanas && STATE.filtros.campanas.size) {
    const set = new Set([...STATE.filtros.campanas].map(norm));
    rows = rows.filter((r) => set.has(norm(r.campanaFila)));
  }

  // Asesores (0 = no filtra, 1 o varias = filtra por cualquiera seleccionada)
  if (STATE.filtros.asesores && STATE.filtros.asesores.size) {
    const set = new Set([...STATE.filtros.asesores].map(norm));
    rows = rows.filter((r) => set.has(norm(r.asesor)));
  }

  // Fechas: si quieres filtrar por DATE_CREATE, habria que guardar esa fecha en STATE.rows.

  if (STATE.search) {
    const term = String(STATE.search).toLowerCase();
    rows = rows.filter((r) => (r.nombre || "").toLowerCase().includes(term));
  }

  return rows;
}

function renderTabla() {
  const tbody = qs("#tbody-clientes");
  if (!tbody) return;

  let rows = applyFilters([...STATE.rows]);
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="px-5 py-6 text-center text-gray-500" colspan="4">Sin resultados</td></tr>`;
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.className = "border-b last:border-b-0 hover:bg-gray-50";
    tr.innerHTML = `
        <td class="px-5 py-3">${r.nombre}</td>
        <td class="px-5 py-3">${r.campanaFila || "-"}</td>
        <td class="px-5 py-3">${chipEstado(r.estadoFila)}</td>
        <td class="px-5 py-3">
          <div class="flex justify-end">
            <button class="text-[#1d73ea] hover:underline">Ver mas</button>
          </div>
        </td>`;
    tr.querySelector("button").addEventListener("click", () =>
      openDetalle(r.id),
    );
    tbody.appendChild(tr);
  });
}

/*************************************************
 * 5) Detalle + Modal (demo visual, sin escribir aun en Bitrix)
 *************************************************/
let CURRENT_CTX = { row: null, estadoSel: "" };

function openDetalle(id) {
  const row = STATE.rows.find((x) => String(x.id) === String(id));

  if (!row) return;

  CURRENT_CTX.row = row;

  hideById("#view-home");
  showById("#view-detalle");

  // Rellenar encabezado e inputs
  qs("#dtl-nombre").textContent = row.nombre || "Cliente";
  qs("#dtl-person").value = row.nombre || "";
  qs("#dtl-email").value = row.email || "";
  qs("#dtl-phone").value = row.phone || "";
  qs("#dtl-place").value = row.place || "";

  // Boton volver
  qs("#btn-back").onclick = () => {
    hideById("#view-detalle");
    showById("#view-home");
  };

  // Boton guardar datos del cliente
  const btnGuardar = qs("#btn-guardar-contacto");
  if (btnGuardar) {
    btnGuardar.onclick = saveContactFromDetalle;
  }

  //  llamar a la funcion global que pinta la card
  renderCampaignCardsByContact(row.contactId);
}

async function renderCampaignCardsByContact(contactId) {
  const wrap = qs("#dtl-cards");
  if (!wrap) return;

  wrap.innerHTML = `<div class="text-sm text-slate-500">Cargando campanas activas...</div>`;

  let contact = null;
  let deals = [];
  try {
    contact = await fetchContactById(contactId);
    await loadCampanaEnum();
    deals = await fetchActiveDealsByContact(contactId);
  } catch (e) {
    console.error("Error consultando contacto/deals:", e);
    wrap.innerHTML = `<div class="text-sm text-red-500">No se pudieron cargar las campanas activas.</div>`;
    return;
  }

  if (!contact) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">No se encontro el contacto.</div>`;
    return;
  }

  if (
    STATE.asesorId &&
    String(contact.ASSIGNED_BY_ID || "") !== STATE.asesorId
  ) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">Este cliente no esta asignado a tu usuario.</div>`;
    return;
  }

  const campo = contact.UF_CRM_1768059328177;
  const valores = Array.isArray(campo)
    ? campo.filter(Boolean)
    : campo
      ? [campo]
      : [];

  if (!valores.length) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">Este cliente no tiene campanas activas.</div>`;
    return;
  }

  wrap.innerHTML = "";

  const dealByProductId = {};
  deals.forEach((d) => {
    const pid = d.UF_CRM_1764444016968 ? String(d.UF_CRM_1764444016968) : "";
    if (pid) dealByProductId[pid] = d;
  });

  let productsByName = {};
  try {
    productsByName = await fetchProductsForCampanas();
  } catch (e) {
    console.error("Error cargando productos de campanas:", e);
  }

  for (const val of valores) {
    const key = String(val);
    const campanaTxt = CAMPANA_ENUM[key] || key;
    const prod = productsByName[campanaTxt.toLowerCase()] || null;

    let estadoCampana = "-";
    let nombreProducto = campanaTxt;
    let productId = null;
    let dealId = "";
    let estadoCliente = "";
    let notas = "";

    if (prod && prod.id) {
      productId = prod.id;
      nombreProducto = prod.name || campanaTxt;
      try {
        const info = await fetchProductInfo(productId);
        estadoCampana = info?.estado || "-";
      } catch (e) {
        console.error("Error cargando estado campana (producto):", e);
      }
    }

    const deal = productId ? dealByProductId[String(productId)] : null;
    if (deal) {
      dealId = String(deal.ID || "");
      estadoCliente = deal.UF_CRM_1764401898591 || "";
      notas = deal.UF_CRM_68911F4662EF3 || "";
      nombreProducto = deal.TITLE || nombreProducto;
    }

    const estadoVisual =
      dealId && STATE.cardVisualStatus && STATE.cardVisualStatus[String(dealId)]
        ? STATE.cardVisualStatus[String(dealId)]
        : "Por completar";

    const card = document.createElement("div");
    card.className =
      "bg-blue-50 border border-blue-100 shadow-sm rounded-2xl p-5";

    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-lg font-semibold text-slate-900 truncate">
            ${nombreProducto}
          </div>

          <div class="text-sm text-slate-600 mt-2">
            <span class="font-semibold text-slate-700">Estado campana:</span>
            <span class="${statusColorClass(
              estadoCampana,
            )}">${estadoCampana}</span>
          </div>
        </div>

        <div class="flex flex-col items-end gap-2 shrink-0">
          <button class="text-[#1d73ea] font-semibold text-sm" type="button">
            Detalle
          </button>

          <div class="text-xs">
            <span class="${statusColorClass(estadoVisual)} font-semibold">${estadoVisual}</span>
          </div>
        </div>
      </div>
    `;

    wrap.appendChild(card);

    const btn = card.querySelector("button");
    if (btn) {
      btn.addEventListener("click", () =>
        openModal({
          id: dealId,
          contactId: String(contactId || ""),
          productId,
          estadoCliente,
          notas,
          campanaFila: campanaTxt,
          nombre: nombreProducto,
        }),
      );
    }
  }
}

function saveContactFromDetalle() {
  const row = CURRENT_CTX.row;
  if (!row || !row.contactId) {
    alert("No se encontro el contacto para este registro.");
    return;
  }

  const fullName = qs("#dtl-person").value.trim();
  const email = qs("#dtl-email").value.trim();
  const phone = qs("#dtl-phone").value.trim();
  const placeTxt = qs("#dtl-place").value.trim();

  // Separar nombre y apellido
  let NAME = fullName;
  let LAST_NAME = "";
  if (fullName.includes(" ")) {
    const parts = fullName.split(" ");
    NAME = parts.shift();
    LAST_NAME = parts.join(" ");
  }

  // Buscar ID de municipio por texto (usamos un mapa texto -> ID)
  let municipioId = row.municipioId || "";
  if (placeTxt) {
    const key = placeTxt.trim().toLowerCase();
    if (MUNICIPIO_ENUM_BY_TEXT && MUNICIPIO_ENUM_BY_TEXT[key]) {
      municipioId = MUNICIPIO_ENUM_BY_TEXT[key];
    }
  }

  const fields = {
    NAME,
    LAST_NAME,
    UF_CRM_1722975246: municipioId || null,
    PHONE: email ? undefined : undefined, // lo definimos abajo para no enviar vacio
    EMAIL: undefined,
  };

  // PHONE / EMAIL como multi-fields
  if (phone) {
    fields.PHONE = [{ VALUE: phone, VALUE_TYPE: "WORK" }];
  }
  if (email) {
    fields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
  }

  console.log("Actualizando contacto", row.contactId, fields);

  BX24.callMethod(
    "crm.contact.update",
    { id: row.contactId, fields },
    function (result) {
      if (result.error()) {
        console.error("Error al actualizar contacto:", result.error());
        alert("Error actualizando el cliente. Revisa consola.");
        return;
      }

      // Actualizar tambien el STATE para que quede consistente
      row.nombre = fullName || row.nombre;
      row.email = email;
      row.phone = phone;
      row.municipioId = municipioId;
      row.place = placeTxt || row.place;

      alert("Datos del cliente actualizados correctamente.");
    },
  );
}

async function openModal(row) {
  CURRENT_CTX = { row, estadoSel: row.estadoCliente || "" };

  // Titulo
  qs("#md-titulo").textContent = row.campanaFila || row.nombre || "campana";

  // Inputs fechas (solo lectura)
  qs("#md-inicio").disabled = true;
  qs("#md-fin").disabled = true;

  qs("#md-inicio").value = "";
  qs("#md-fin").value = "";

  if (row.productId) {
    try {
      const info = await fetchProductInfo(row.productId);
      qs("#md-inicio").value = info?.fechaInicio || "";
      qs("#md-fin").value = info?.fechaFin || "";
    } catch (e) {
      console.error("Error cargando fechas del producto:", e);
    }
  }

  // Notas (si ya existen)
  qs("#md-notas").value = row.notas || "";

  // Estados (botones)
  qsa("[data-estado]").forEach((btn) => {
    btn.classList.remove("ring-2", "ring-[#1d73ea]");

    if (btn.dataset.estado === CURRENT_CTX.estadoSel) {
      btn.classList.add("ring-2", "ring-[#1d73ea]");
    }

    btn.onclick = () => {
      CURRENT_CTX.estadoSel = btn.dataset.estado;
      qsa("[data-estado]").forEach((b) =>
        b.classList.remove("ring-2", "ring-[#1d73ea]"),
      );
      btn.classList.add("ring-2", "ring-[#1d73ea]");
    };
  });

  // Mostrar modal
  const m = qs("#modal");
  m.classList.remove("hidden");
  m.classList.add("flex");

  qs("#md-cancelar").onclick = closeModal;
  qs("#md-close").onclick = closeModal;
  qs("#md-guardar").onclick = saveModal;

  //  Cargar fechas desde el PRODUCTO
  if (row.productId) {
    try {
      const info = await fetchProductInfo(row.productId);
      qs("#md-inicio").value = info?.fechaInicio || "";
      qs("#md-fin").value = info?.fechaFin || "";
    } catch (e) {
      console.error("Error cargando fechas del producto:", e);
    }
  }
}
function closeModal() {
  const m = qs("#modal");
  if (!m) return;
  m.classList.add("hidden");
  m.classList.remove("flex");
}

function saveModal() {
  const dealId = CURRENT_CTX.row.id;
  const estadoCliente = CURRENT_CTX.estadoSel || "";
  const notas = qs("#md-notas").value.trim();

  if (!dealId) {
    alert("No hay un negocio asociado para guardar este detalle.");
    return;
  }

  // Guardar en Bitrix: estado cliente + notas
  const fields = {
    UF_CRM_1764401898591: estadoCliente,
    UF_CRM_68911F4662EF3: notas,
  };

  BX24.callMethod("crm.deal.update", { id: dealId, fields }, (res) => {
    if (res.error()) {
      console.error("Error crm.deal.update:", res.error());
      alert("No se pudo guardar. Revisa consola.");
      return;
    }

    // OK visual final persistente
    setVisualCompleted(dealId);

    closeModal();

    // OK refrescar cards del mismo contacto
    renderCampaignCardsByContact(CURRENT_CTX.row.contactId);
  });
}
