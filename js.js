/*************************************************
 * 0) Estado global
 *************************************************/
let STATE = {
  asesorActual: "",
  asesorId: "",
  isAdmin: false,
  filtros: {
    campanas: new Set(),
    asesores: new Set(),
    inicio: "",
    fin: "",
  },
  search: "",
  rows: [],
  campanasDisponibles: [],
  asesoresDisponibles: [],
};
const LS_CARD_STATUS_KEY = "vyv_card_status_v1";
// Campo del contacto en Bitrix donde se guarda el estado de las cards
// como JSON { "<nombre campaña>": "Completado" | "Seguimiento" }.
// Las campañas sin entrada se renderizan como "Por completar".
// Visible para asesores y admin.
const CARD_STATUS_FIELD_CODE = "UF_CRM_1781225990";
// Campo del contacto que vincula productos del catálogo comercial (CATALOG_ID 24).
// Guarda IDs de producto directamente, no textos ni opciones de enum.
const CAMPANA_COMERCIAL_FIELD_CODE = "UF_CRM_1786598094";
// Por defecto ocultamos campañas completadas. El toggle en la UI las muestra.
let SHOW_ALL_CAMPAIGNS = false;
// === TEMP: desactivar login inicial (mostrar HOME directo) ===

let USER_MAP = {}; // ID -> Nombre completo
let VALID_CAMPAIGNS = new Set();
let VALID_CAMPAIGN_IDS = [];
// Cache de productos comerciales activos indexados por ID de producto.
// { "2420": { ID, NAME, PROPERTY_356, PROPERTY_358, PROPERTY_360 }, ... }
let VALID_CAMPAIGN_PRODUCTS = {};
let HOME_READY = false;

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await new Promise((resolve, reject) => {
      try {
        BX24.init(resolve);
      } catch (e) {
        reject(e);
      }
    });

    showGlobalLoader("Iniciando módulo...");

    const currentUser = await new Promise((resolve, reject) => {
      BX24.callMethod("user.current", {}, (res) => {
        if (res.error && res.error()) {
          reject(res.error());
          return;
        }
        resolve(res.data());
      });
    });

    if (!currentUser || !currentUser.ID) {
      alert("No se pudo obtener el usuario de Bitrix");
      hideGlobalLoader();
      return;
    }

    STATE.isAdmin = !!BX24.isAdmin();
    STATE.asesorId = String(currentUser.ID || "");
    STATE.asesorActual = currentUser.EMAIL || "";

    showById("#view-home");

    showGlobalLoader("Cargando campañas...");
    await loadCampanaEnum();
    await loadValidCampaigns();

    showGlobalLoader("Preparando asesores...");

    if (STATE.isAdmin) {
      await loadUsersMap();
    } else {
      USER_MAP[STATE.asesorId] = {
        nombre:
          [currentUser.NAME, currentUser.LAST_NAME]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          currentUser.EMAIL ||
          `Asesor ${STATE.asesorId}`,
        email: currentUser.EMAIL || "",
      };
    }

    // Pintamos la UI primero para no dejar la app congelada.
    showGlobalLoader("Preparando vista...");
    initHome();

    showGlobalLoader("Cargando contactos...");

    loadContactosFromBitrix()
      .then(() => {
        // Refrescamos controles una vez ya existan campañas/asesores calculados.
        initHome();
        renderTabla();
      })
      .catch((e) => {
        console.error("Error cargando contactos:", e);
        showToast("No se pudieron cargar los contactos.", "error");
      })
      .finally(() => {
        hideGlobalLoader();
      });
  } catch (e) {
    console.error("Error iniciando app:", e);
    alert("Error cargando la app");
    hideGlobalLoader();
  }
});

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

// Lee el campo CARD_STATUS_FIELD_CODE del contacto y devuelve
// un objeto { "<campaña original>": "Completado" | "Seguimiento" }.
// Conserva el casing original del nombre de la campaña.
function parseContactCardStatus(contact) {
  try {
    const raw = String(contact?.[CARD_STATUS_FIELD_CODE] || "").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Nombres de producto pueden tener sufijo " (fecha)", ej "Cáucaso (11-08-2026)".
// Estados guardados antes del refactor usaban solo el nombre base ("Cáucaso"),
// así que al buscar comparamos primero exacto y luego contra el nombre base.
function stripCampaignSuffix(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function getCardStatusFromMap(map, campanaTxt) {
  if (!map || !campanaTxt) return undefined;
  if (map[campanaTxt] !== undefined) return map[campanaTxt];
  const base = stripCampaignSuffix(campanaTxt);
  if (base && base !== campanaTxt && map[base] !== undefined) return map[base];
  return undefined;
}

// Mergea en localStorage los estados que vienen del campo de Bitrix
// para el contacto dado. Convierte cada campaña a la clave lowercased
// que usa el resto de la app (getCardStatusKey). Además guarda una clave
// con el nombre base (sin sufijo " (fecha)") para tolerar renombres del
// producto sin perder el estado histórico.
function hydrateCardStatusMapFromContact(contact) {
  const contactId = contact?.ID;
  if (!contactId) return;

  const perCampana = parseContactCardStatus(contact);
  const globalMap = loadCardStatusMap();

  Object.entries(perCampana).forEach(([campana, estado]) => {
    const key = getCardStatusKey(contactId, campana);
    globalMap[key] = estado;

    const base = stripCampaignSuffix(campana);
    if (base && base !== campana) {
      const baseKey = getCardStatusKey(contactId, base);
      globalMap[baseKey] = estado;
    }
  });

  saveCardStatusMap(globalMap);
}

function getCardStatusKey(contactId, campana) {
  return `${String(contactId)}::${String(campana || "")
    .trim()
    .toLowerCase()}`;
}

function showToast(message = "", type = "success") {
  let toast = document.getElementById("vyv-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "vyv-toast";
    toast.className =
      "fixed top-5 right-5 z-[9999] hidden min-w-[280px] max-w-[420px] rounded-2xl px-4 py-3 shadow-2xl border text-sm font-medium transition-all";
    document.body.appendChild(toast);
  }

  const palette =
    type === "error"
      ? "bg-rose-50 border-rose-200 text-rose-700"
      : "bg-emerald-50 border-emerald-200 text-emerald-700";

  toast.className = `fixed top-5 right-5 z-[9999] min-w-[280px] max-w-[420px] rounded-2xl px-4 py-3 shadow-2xl border text-sm font-medium transition-all ${palette}`;
  toast.textContent = message;

  clearTimeout(window.__vyvToastTimer);
  toast.classList.remove("hidden");

  window.__vyvToastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2600);
}
function setModalGuardarState(state = "idle") {
  const btn = document.getElementById("md-guardar");
  const btnCancel = document.getElementById("md-cancelar");
  const btnClose = document.getElementById("md-close");

  if (!btn) return;

  if (!btn.dataset.originalText) {
    btn.dataset.originalText = btn.textContent.trim() || "Guardar";
  }

  if (state === "loading") {
    btn.disabled = true;
    btn.classList.add("opacity-80", "cursor-not-allowed");
    btn.innerHTML = `
      <span class="inline-flex items-center gap-2">
        <i class="fa-solid fa-spinner fa-spin"></i>
        Guardando...
      </span>
    `;
    if (btnCancel) btnCancel.disabled = true;
    if (btnClose) btnClose.disabled = true;
    return;
  }

  if (state === "success") {
    btn.disabled = true;
    btn.classList.remove("opacity-80", "cursor-not-allowed");
    btn.innerHTML = `
      <span class="inline-flex items-center gap-2">
        <i class="fa-solid fa-check"></i>
        Guardado
      </span>
    `;
    return;
  }

  btn.disabled = false;
  btn.classList.remove("opacity-80", "cursor-not-allowed");
  btn.textContent = btn.dataset.originalText || "Guardar";

  if (btnCancel) btnCancel.disabled = false;
  if (btnClose) btnClose.disabled = false;
}
function showModalLoader() {
  const el = document.getElementById("modal-loader");
  if (!el) return;
  el.classList.remove("hidden");
  el.classList.add("flex");
}

function hideModalLoader() {
  const el = document.getElementById("modal-loader");
  if (!el) return;
  el.classList.add("hidden");
  el.classList.remove("flex");
}
function resetState() {
  STATE = {
    asesorActual: "",
    asesorId: "",
    isAdmin: false,
    filtros: {
      campanas: new Set(),
      asesores: new Set(),
      inicio: "",
      fin: "",
    },
    search: "",
    rows: [],
    campanasDisponibles: [],
    asesoresDisponibles: [],
  };
}
/*************************************************
 * helpers DOM
 *************************************************/
const qs = (s, ctx = document) => ctx.querySelector(s);
const qsa = (s, ctx = document) => [...ctx.querySelectorAll(s)];
const showById = (id) => qs(id)?.classList.remove("hidden");
const hideById = (id) => qs(id)?.classList.add("hidden");

const chipEstado = (texto) => {
  const base =
    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold";

  if (!texto) {
    return `<span class="${base} bg-gray-100 text-gray-700">Sin estado</span>`;
  }

  const raw = String(texto).trim();
  const t = raw.toLowerCase();

  if (t.includes("activo") || t.includes("activa")) {
    return `<span class="${base} bg-emerald-100 text-emerald-700">${raw}</span>`;
  }
  if (t.includes("finalizada") || t.includes("finalizado")) {
    return `<span class="${base} bg-indigo-100 text-indigo-700">${raw}</span>`;
  }
  if (t.includes("cancelada") || t.includes("cancelado")) {
    return `<span class="${base} bg-rose-100 text-rose-700">${raw}</span>`;
  }

  return `<span class="${base} bg-gray-100 text-gray-700">${raw}</span>`;
};

// === Helper Bitrix PRO: paginación completa, sin límite, con pausa y progreso ===
// Trae TODOS los registros, pero con delay entre páginas para reducir 502/503.
// options.onProgress recibe: { method, pages, total, lastPageCount, elapsedMs }
function bxList(method, params = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let all = [];
    let pages = 0;
    const startedAt = Date.now();

    const delayMs =
      Number.isFinite(options.delayMs) && options.delayMs >= 0
        ? options.delayMs
        : 130;

    const onProgress =
      typeof options.onProgress === "function" ? options.onProgress : () => {};

    BX24.callMethod(method, params, function handler(result) {
      if (result.error()) {
        console.error(`Error en ${method}:`, result.error());
        reject(result.error());
        return;
      }

      const data = result.data() || [];
      all = all.concat(data);
      pages++;

      onProgress({
        method,
        pages,
        total: all.length,
        lastPageCount: data.length,
        elapsedMs: Date.now() - startedAt,
        chunk: data,
      });

      if (result.more()) {
        setTimeout(() => result.next(), delayMs);
      } else {
        resolve(all);
      }
    });
  });
}

// === Diccionarios de listas UF ===
let MUNICIPIO_ENUM = {}; // ID -> Texto
let MUNICIPIO_ENUM_BY_TEXT = {}; // texto normalizado -> ID
let CAMPANA_ENUM = {}; // ID -> Texto (UF_CRM_1768059328177)
let CAMPANA_ENUM_BY_TEXT = {}; // texto normalizado -> ID

const CONTACT_DETAIL_OTHER_VALUE = "__OTHER__";
const CONTACT_DETAIL_FIELDS = {
  viajesFuturos: {
    code: "UF_CRM_1723205267",
    selector: "#dtl-viajes-futuros",
    otherSelector: "#dtl-viajes-futuros-otro",
    placeholder: "Viajes futuros",
  },
  tipoContacto: {
    code: "TYPE_ID",
    selector: "#dtl-tipo-contacto",
    otherSelector: "",
    placeholder: "Tipo de cliente",
  },
  viajesRealizados: {
    code: "UF_CRM_1671644220",
    selector: "#dtl-viajes-realizados",
    otherSelector: "#dtl-viajes-realizados-otro",
    placeholder: "Viajes realizados",
  },
};
let CONTACT_DETAIL_ENUMS = {}; // FIELD_CODE -> { ID: Texto }
let CONTACT_DETAIL_META = {}; // FIELD_CODE -> metadata de Bitrix, ej. { isMultiple: true/false }

function loadMunicipioEnum() {
  return new Promise((resolve, reject) => {
    BX24.callMethod("crm.contact.fields", {}, function (result) {
      if (result.error()) {
        reject(result.error());
        return;
      }
      const fields = result.data() || {};
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

async function loadContactDetailEnums() {
  try {
    const fields = await bxCall("crm.contact.fields", {});
    CONTACT_DETAIL_ENUMS = {};
    CONTACT_DETAIL_META = {};

    Object.values(CONTACT_DETAIL_FIELDS).forEach(({ code }) => {
      CONTACT_DETAIL_ENUMS[code] = {};

      // TYPE_ID es un campo estándar crm_status. Sus opciones NO siempre llegan
      // en crm.contact.fields; se cargan más abajo con crm.status.list CONTACT_TYPE.
      if (code === "TYPE_ID") {
        CONTACT_DETAIL_META[code] = { isMultiple: false, source: "crm.status.list" };
        return;
      }

      const f = fields?.[code];
      const items = Array.isArray(f?.items) ? f.items : [];

      CONTACT_DETAIL_META[code] = {
        // Bitrix puede devolver isMultiple como true, "Y" o 1 según el método/portal.
        isMultiple:
          f?.isMultiple === true ||
          f?.isMultiple === "Y" ||
          f?.MULTIPLE === "Y" ||
          f?.multiple === true,
        source: "crm.contact.fields",
      };

      items.forEach((it) => {
        const id = String(it.ID);
        const text = String(it.VALUE || "").trim();
        if (id && text) CONTACT_DETAIL_ENUMS[code][id] = text;
      });
    });

    // Opciones oficiales del campo estándar Tipo de contacto / Tipo de cliente.
    const contactTypes = await bxCall("crm.status.list", {
      order: { SORT: "ASC" },
      filter: { ENTITY_ID: "CONTACT_TYPE" },
    });

    CONTACT_DETAIL_ENUMS.TYPE_ID = {};
    (Array.isArray(contactTypes) ? contactTypes : []).forEach((it) => {
      // Para campos crm_status Bitrix guarda el STATUS_ID, no el ID numérico interno.
      const id = String(it.STATUS_ID || "").trim();
      const text = String(it.NAME || it.NAME_INIT || it.STATUS_ID || "").trim();
      if (id && text) CONTACT_DETAIL_ENUMS.TYPE_ID[id] = text;
    });

    CONTACT_DETAIL_META.TYPE_ID = { isMultiple: false, source: "crm.status.list" };
  } catch (e) {
    console.error("No se pudieron cargar las listas de detalle:", e);
    throw e;
  }
}

function normalizeMultiUfValues(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}

function getSelectedOptionsValues(selector) {
  const sel = qs(selector);
  if (!sel) return [];

  // Lee directamente del <select> oculto. Es más seguro que selectedOptions
  // cuando usamos una UI custom con checkboxes.
  const valuesFromSelect = [...sel.options]
    .filter((o) => o.selected)
    .map((o) => String(o.value))
    .filter(Boolean);

  if (valuesFromSelect.length) return valuesFromSelect;

  // Fallback: si por alguna razón el navegador no sincronizó el select,
  // lee los checks de la UI generada.
  const wrapper = document.getElementById(`${sel.id}-ms-ui`);
  if (!wrapper) return [];

  return [...wrapper.querySelectorAll("[data-ms-value]:checked")]
    .map((cb) => String(cb.dataset.msValue || ""))
    .filter(Boolean);
}

function toggleContactDetailOtherInput(selector, otherSelector) {
  const input = qs(otherSelector);
  if (!input) return;

  const selectedValues = getSelectedOptionsValues(selector);
  const isOther = selectedValues.includes(CONTACT_DETAIL_OTHER_VALUE);
  input.classList.toggle("hidden", !isOther);

  if (isOther) {
    input.focus();
  } else {
    input.value = "";
  }
}

function fillContactDetailSelect(
  selector,
  enumMap = {},
  selectedIds = [],
  placeholder = "Selecciona opción",
  otherSelector = "",
) {
  const sel = qs(selector);
  if (!sel) return;

  const selectedSet = new Set(normalizeMultiUfValues(selectedIds));
  const isSingleType = selector === "#dtl-tipo-contacto";
  sel.innerHTML = "";
  sel.multiple = !isSingleType;

  Object.entries(enumMap || {})
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .forEach(([id, text]) => {
      const opt = document.createElement("option");
      opt.value = String(id);
      opt.textContent = text;
      if (selectedSet.has(String(id))) opt.selected = true;
      sel.appendChild(opt);
    });

  if (!isSingleType && otherSelector) {
    const otherOpt = document.createElement("option");
    otherOpt.value = CONTACT_DETAIL_OTHER_VALUE;
    otherOpt.textContent = "➕ Otra opción...";
    sel.appendChild(otherOpt);
  }

  sel.classList.add("hidden");

  if (otherSelector) {
    sel.onchange = () => toggleContactDetailOtherInput(selector, otherSelector);
    toggleContactDetailOtherInput(selector, otherSelector);
  }

  renderContactDetailMultiSelect(selector, placeholder, otherSelector);
}

function renderContactDetailMultiSelect(
  selector,
  placeholder = "Selecciona opciones",
  otherSelector = "",
) {
  const sel = qs(selector);
  if (!sel) return;

  const isMultiple = sel.multiple;
  const wrapperId = `${sel.id || selector.replace(/[^a-z0-9]/gi, "_")}-ms-ui`;
  let wrapper = document.getElementById(wrapperId);

  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.id = wrapperId;
    wrapper.className = "relative contact-detail-ms";
    sel.insertAdjacentElement("afterend", wrapper);
  }

  const selectedOptions = [...sel.options].filter(
    (opt) => opt.selected && opt.value !== CONTACT_DETAIL_OTHER_VALUE,
  );
  const otherSelected = [...sel.options].some(
    (opt) => opt.selected && opt.value === CONTACT_DETAIL_OTHER_VALUE,
  );
  const label = selectedOptions.length
    ? isMultiple
      ? `${selectedOptions.length} seleccionado${selectedOptions.length === 1 ? "" : "s"}`
      : selectedOptions[0]?.textContent || "Seleccionado"
    : placeholder;

  // Ordena: opciones seleccionadas primero (alfabético), luego no seleccionadas
  // (alfabético). "Otra opción..." queda siempre al final.
  const sortedOptions = [...sel.options].sort((a, b) => {
    const aOther = a.value === CONTACT_DETAIL_OTHER_VALUE;
    const bOther = b.value === CONTACT_DETAIL_OTHER_VALUE;
    if (aOther !== bOther) return aOther ? 1 : -1;
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return String(a.textContent || "").localeCompare(String(b.textContent || ""));
  });

  const optionsHtml = sortedOptions
    .map((opt, idx, arr) => {
      const isOther = opt.value === CONTACT_DETAIL_OTHER_VALUE;
      const checked = opt.selected ? "checked" : "";
      const labelClass = isOther
        ? "font-semibold text-[#1d73ea]"
        : "text-slate-700";

      // Divider entre seleccionadas y no seleccionadas (solo si hay ambos grupos)
      const prev = arr[idx - 1];
      const showDivider =
        prev &&
        prev.selected &&
        !opt.selected &&
        opt.value !== CONTACT_DETAIL_OTHER_VALUE;
      const dividerHtml = showDivider
        ? `<div class="my-1 border-t border-slate-100"></div>`
        : "";

      return `
        ${dividerHtml}
        <label class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 cursor-pointer transition ${opt.selected ? "bg-[#1d73ea]/5" : ""}">
          <input
            type="${isMultiple ? "checkbox" : "radio"}"
            name="${escapeHtml(sel.id || "contact-detail-single")}"
            data-ms-value="${escapeHtml(opt.value)}"
            ${checked}
            class="h-4 w-4 rounded border-slate-300 text-[#1d73ea] focus:ring-[#1d73ea]/30"
          />
          <span class="text-sm ${labelClass}">${escapeHtml(opt.textContent || "")}</span>
        </label>
      `;
    })
    .join("");

  // Tooltip nativo con la lista de seleccionados al hacer hover.
  const selectedNamesForTitle = selectedOptions
    .map((o) => o.textContent || o.value)
    .filter(Boolean)
    .join(" · ");

  wrapper.innerHTML = `
    <button type="button"
      class="w-full h-9 px-2.5 rounded-md border border-transparent bg-slate-50 text-sm text-slate-800 hover:bg-slate-100 focus:bg-white focus:border-[#1d73ea] focus:ring-1 focus:ring-[#1d73ea]/25 outline-none transition flex items-center justify-between gap-2"
      data-cdms-trigger
      title="${escapeHtml(selectedNamesForTitle)}">
      <span class="truncate ${selectedOptions.length ? "text-slate-800" : "text-slate-400"}">${escapeHtml(label)}</span>
      <span class="inline-flex shrink-0 items-center justify-center text-slate-500 transition" data-cdms-chevron>
        <i class="fa-solid fa-chevron-down text-xs"></i>
      </span>
    </button>

    <div data-cdms-panel class="hidden absolute left-0 right-0 top-full z-40 mt-2 rounded-2xl border border-slate-100 bg-white p-3 shadow-2xl max-h-72 overflow-auto">
      ${optionsHtml || `<div class="px-3 py-2 text-sm text-slate-400">Sin opciones disponibles</div>`}
    </div>
  `;

  const trigger = wrapper.querySelector("[data-cdms-trigger]");
  const panel = wrapper.querySelector("[data-cdms-panel]");
  const chevron = wrapper.querySelector("[data-cdms-chevron]");

  const close = () => {
    panel?.classList.add("hidden");
    chevron?.classList.remove("rotate-180");
  };

  trigger?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    document.querySelectorAll("[data-cdms-panel]").forEach((p) => {
      if (p !== panel) p.classList.add("hidden");
    });

    panel?.classList.toggle("hidden");
    chevron?.classList.toggle(
      "rotate-180",
      !panel?.classList.contains("hidden"),
    );
  });

  panel?.addEventListener("click", (e) => e.stopPropagation());

  wrapper.querySelectorAll("[data-ms-value]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = String(cb.dataset.msValue || "");
      const opt = [...sel.options].find((item) => String(item.value) === value);

      if (!isMultiple) {
        [...sel.options].forEach((item) => {
          item.selected = false;
        });
        if (opt) opt.selected = true;
      } else if (opt) {
        opt.selected = cb.checked;
      }

      sel.dispatchEvent(new Event("change", { bubbles: true }));
      renderContactDetailMultiSelect(selector, placeholder, otherSelector);
    });
  });

  if (!window.__contactDetailMultiSelectCloseBound) {
    document.addEventListener("click", () => {
      document
        .querySelectorAll("[data-cdms-panel]")
        .forEach((p) => p.classList.add("hidden"));
      document
        .querySelectorAll("[data-cdms-chevron]")
        .forEach((c) => c.classList.remove("rotate-180"));
    });
    window.__contactDetailMultiSelectCloseBound = true;
  }

  if (otherSelector) toggleContactDetailOtherInput(selector, otherSelector);
}

function fillAllContactDetailSelects(contact = {}) {
  Object.values(CONTACT_DETAIL_FIELDS).forEach(
    ({ code, selector, placeholder, otherSelector }) => {
      fillContactDetailSelect(
        selector,
        CONTACT_DETAIL_ENUMS[code] || {},
        contact?.[code] || "",
        placeholder,
        otherSelector,
      );
    },
  );
}

function loadCampanaEnum() {
  return new Promise((resolve, reject) => {
    BX24.callMethod("crm.contact.fields", {}, function (result) {
      if (result.error()) {
        reject(result.error());
        return;
      }
      const fields = result.data() || {};
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



async function loadValidCampaigns() {
  try {

    const products = await bxCall(
      "crm.product.list",
      {
        filter: {
          CATALOG_ID: 24,
          SECTION_ID: 114,
          "PROPERTY_358": "Activa"
        },
        select: [
          "ID",
          "NAME",
          "CATALOG_ID",
          "SECTION_ID",
          "PROPERTY_356",
          "PROPERTY_358",
          "PROPERTY_360"
        ]
      }
    );

    // Filtro defensivo en JS. Bitrix a veces ignora filtros por SECTION_ID
    // y por propiedades custom en crm.product.list, así que confirmamos aquí
    // que solo entren productos de la sección 114 (comercial) con estado
    // "Activa" en PROPERTY_358.
    const productsRaw = products || [];
    const filtered = productsRaw.filter((p) => {
      const sectionId = String(p.SECTION_ID || "").trim();
      const estado = getBitrixPropValue(p.PROPERTY_358);
      const isCommercial = sectionId === "114";
      const isActiva = String(estado).trim().toLowerCase() === "activa";
      return isCommercial && isActiva;
    });

    console.log(
      "Productos crudos:", productsRaw.length,
      "→ tras filtro comercial+activa:", filtered.length
    );

    VALID_CAMPAIGN_PRODUCTS = {};
    filtered.forEach(p => {
      const id = String(p.ID || "").trim();
      if (!id) return;
      VALID_CAMPAIGN_PRODUCTS[id] = p;
    });

    VALID_CAMPAIGNS = new Set(
      Object.values(VALID_CAMPAIGN_PRODUCTS)
        .map(p => String(p.NAME || "").trim())
        .filter(Boolean)
    );

    VALID_CAMPAIGN_IDS = Object.keys(VALID_CAMPAIGN_PRODUCTS);

    console.log("Productos comerciales activos:", VALID_CAMPAIGN_IDS.length);


  } catch (e) {
    console.error("Error cargando campañas activas:", e);
  }
}


async function loadUsersMap() {
  try {
    const users = await bxList("user.get", {
      select: ["ID", "NAME", "LAST_NAME", "SECOND_NAME", "EMAIL"],
    });

    USER_MAP = {};

    users.forEach((u) => {
      const id = String(u.ID || "");
      const nombre = [u.NAME, u.LAST_NAME].filter(Boolean).join(" ").trim();

      USER_MAP[id] = {
        nombre: nombre || `Asesor ${id}`,
        email: u.EMAIL || "",
      };
    });
  } catch (e) {
    console.warn("No se pudo cargar user.get. Se usarán IDs.", e);
    USER_MAP = {};
  }
}

function normalizeMultiValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((v) => String(v));
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}

function campanaIdsToTexts(values) {
  return normalizeMultiValue(values)
    .map((id) => CAMPANA_ENUM[String(id)] || "")
    .filter(Boolean);
}

// Convierte IDs de producto del catálogo comercial a nombres, usando el cache
// VALID_CAMPAIGN_PRODUCTS. IDs no vigentes (producto inactivo o inexistente)
// se descartan.
function campanaProductIdsToTexts(values) {
  return normalizeMultiValue(values)
    .map((id) => VALID_CAMPAIGN_PRODUCTS[String(id)]?.NAME || "")
    .map((name) => String(name).trim())
    .filter(Boolean);
}

function mapContactFromBitrix(c) {
  const id = String(c.ID || "");
  const asesorId = String(c.ASSIGNED_BY_ID || "");
  const nombre =
    [c.NAME, c.LAST_NAME].filter(Boolean).join(" ") || `Contacto #${id}`;

  const municipioId = c.UF_CRM_1722975246 || "";

  // Nueva fuente: campo del contacto que vincula productos del catálogo
  // comercial. Guarda IDs de producto directamente.
  const campanaProductIds = normalizeMultiValue(c[CAMPANA_COMERCIAL_FIELD_CODE]);
  const campanaTexts = campanaProductIdsToTexts(campanaProductIds);

  // Marca true cuando el contacto tiene al menos una campaña y TODAS están
  // "Completado". Se usa para ocultar de la lista principal a los contactos
  // que ya no requieren gestión.
  const cardStatus = parseContactCardStatus(c);
  const todasCompletadas =
    campanaTexts.length > 0 &&
    campanaTexts.every(
      (txt) => getCardStatusFromMap(cardStatus, txt) === "Completado",
    );


  return {
    id,
    contactId: id,
    nombre,
    asesor: asesorId,
    asesorNombre: USER_MAP[asesorId]?.nombre || `Asesor ${asesorId}`,
    email: "",
    phone: "",
    place: MUNICIPIO_ENUM[String(municipioId)] || "",
    municipioId,
    campanaIds: campanaProductIds,
    campanaTexts,
    campanaFila: campanaTexts[0] || "-",
    estadoFila: campanaTexts.length ? "Activo" : "Sin campañas",
    todasCompletadas,
    cardStatus,
  };
}

function rebuildDisponiblesFromRows() {
  STATE.campanasDisponibles = [
    ...new Set(STATE.rows.flatMap((r) => r.campanaTexts).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  STATE.asesoresDisponibles = [
    ...new Map(
      STATE.rows
        .filter((r) => r.asesor)
        .map((r) => [
          r.asesor,
          {
            id: r.asesor,
            nombre: r.asesorNombre,
          },
        ]),
    ).values(),
  ].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}

async function loadContactosFromBitrix() {
  resetGlobalLoaderProgress();

  let partialContacts = [];

  const contacts = await bxList(
    "crm.contact.list",
    {
      filter: {
        [CAMPANA_COMERCIAL_FIELD_CODE]: VALID_CAMPAIGN_IDS,
        ...(!STATE.isAdmin && STATE.asesorId
          ? { ASSIGNED_BY_ID: STATE.asesorId }
          : {}),
      },
      select: [
        "ID",
        "NAME",
        "LAST_NAME",
        "ASSIGNED_BY_ID",
        CAMPANA_COMERCIAL_FIELD_CODE,
        CARD_STATUS_FIELD_CODE,
      ],
    },
    {
      delayMs: 130,
      onProgress: ({ pages, total, elapsedMs, chunk = [] }) => {
        setGlobalLoaderProgress({ pages, total, elapsedMs, done: false });

        // Acumulamos por bloques y renderizamos cada 3 páginas.
        partialContacts = partialContacts.concat(chunk);

        if (pages % 3 === 0) {
          STATE.rows = partialContacts
            .map(mapContactFromBitrix)
            .filter((c) => !c.todasCompletadas);
          rebuildDisponiblesFromRows();
          renderTabla();
        }
      },
    },
  );
  STATE.rows = contacts
    .map(mapContactFromBitrix)
    .filter((c) => c.campanaTexts && c.campanaTexts.length > 0)
    .filter((c) => !c.todasCompletadas);

    // ===== DEBUG campañas =====
const campaignStats = {};

STATE.rows.forEach((r) => {
  (r.campanaTexts || []).forEach((camp) => {
    if (!campaignStats[camp]) {
      campaignStats[camp] = 0;
    }

    campaignStats[camp]++;
  });
});

console.group(" REGISTROS POR CAMPAÑA");

Object.entries(campaignStats)
  .sort((a, b) => b[1] - a[1])
  .forEach(([camp, total]) => {
    console.log(`${camp}: ${total}`);
  });

console.groupEnd();

  rebuildDisponiblesFromRows();
  renderTabla();

  setGlobalLoaderProgress({
    pages: Math.ceil((contacts.length || 0) / 50),
    total: contacts.length,
    elapsedMs: 0,
    done: true,
  });
}

function fetchProductoCampanaByNombre(nombreCampana) {
  return new Promise((resolve, reject) => {
    if (!nombreCampana) {
      resolve(null);
      return;
    }

    BX24.callMethod(
      "crm.product.list",
      {
        filter: {
          CATALOG_ID: 24,
          SECTION_ID: 114,
          NAME: nombreCampana,
        },
        select: [
          "ID",
          "NAME",
          "CATALOG_ID",
          "SECTION_ID",
          "PROPERTY_356",
          "PROPERTY_358",
          "PROPERTY_360",
        ],
      },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }

        const items = result.data() || [];
        resolve(items[0] || null);
      },
    );
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

function showGlobalLoader(text = "Cargando información...") {
  const loader = document.getElementById("global-loader");
  if (!loader) return;

  setGlobalLoaderStep(
    text,
    "Por favor no cierres esta ventana mientras termina la carga.",
  );

  loader.classList.remove("hidden");
  loader.classList.add("flex");
}

function hideGlobalLoader() {
  const loader = document.getElementById("global-loader");
  if (!loader) return;

  loader.classList.add("hidden");
  loader.classList.remove("flex");
}

function setGlobalLoaderStep(title = "Cargando módulo", detail = "") {
  const titleEl = document.getElementById("global-loader-title");
  const detailEl = document.getElementById("global-loader-detail");
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
}

function setGlobalLoaderProgress({
  pages = 0,
  total = 0,
  elapsedMs = 0,
  done = false,
} = {}) {
  const bar = document.getElementById("global-loader-bar");
  const txt = document.getElementById("global-loader-progress");
  const badge = document.getElementById("global-loader-badge");

  // No conocemos el total real de Bitrix antes de terminar.
  // Por eso la barra es estimada: avanza hasta 92% y al finalizar sube a 100%.
  const estimated = done ? 100 : Math.min(97, Math.round(15 + pages * 0.75));
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));

  if (bar) bar.style.width = `${estimated}%`;

  if (txt) {
    txt.textContent = done
      ? `Carga completa: ${total} contactos.`
      : `Cargando contactos: ${total} registros encontrados en ${pages} páginas.`;
  }

  if (badge) {
    badge.textContent = done ? "100%" : `${estimated}%`;
  }

  const detail = done
    ? `Listo. Se cargaron ${total} contactos.`
    : `Tiempo transcurrido: ${seconds}s.`;

  setGlobalLoaderStep("Cargando contactos de Bitrix", detail);
}

function resetGlobalLoaderProgress() {
  const bar = document.getElementById("global-loader-bar");
  const txt = document.getElementById("global-loader-progress");
  const badge = document.getElementById("global-loader-badge");

  if (bar) bar.style.width = "0%";
  if (txt) txt.textContent = "Preparando consulta...";
  if (badge) badge.textContent = "0%";
}
function showDetalleLoader() {
  const loader = document.getElementById("detalle-loader");
  if (!loader) return;

  loader.classList.remove("hidden");
  loader.classList.add("flex");
}

function hideDetalleLoader() {
  const loader = document.getElementById("detalle-loader");
  if (!loader) return;

  loader.classList.add("hidden");
  loader.classList.remove("flex");
}

function getBitrixPropValue(prop) {
  if (!prop) return "";
  if (Array.isArray(prop)) {
    return prop[0]?.value || prop[0]?.VALUE || "";
  }
  if (typeof prop === "object") {
    return prop.value || prop.VALUE || "";
  }
  return String(prop || "");
}

function formatFechaBitrix(value) {
  if (!value) return "-";

  const raw = String(value).trim();

  // Evita desfase de 1 día por zona horaria cuando Bitrix envía YYYY-MM-DD.
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, year, month, day] = match;
    const d = new Date(Number(year), Number(month) - 1, Number(day));

    return d.toLocaleDateString("es-CO", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;

  return d.toLocaleDateString("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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

    // Lista de nombres seleccionados para el tooltip al hacer hover.
    const selectedTexts = rowEls
      .filter((r) => selected.has(r.dataset.value))
      .map((r) => r.querySelector("span")?.textContent || r.dataset.value)
      .filter(Boolean);
    if (trigger) {
      trigger.title = selectedTexts.length
        ? selectedTexts.join(" · ")
        : "";
    }

    if (!count) {
      labelEl.textContent = placeholder;
      labelEl.classList.add("text-slate-500");
      labelEl.classList.remove("text-slate-700");
      return;
    }

    if (count === 1) {
      labelEl.textContent = selectedTexts[0] || "1 seleccionado";
    } else {
      labelEl.textContent = `${count} seleccionados`;
    }
    labelEl.classList.remove("text-slate-500");
    labelEl.classList.add("text-slate-700");
  }

  // Reordena el DOM para que las opciones seleccionadas aparezcan primero,
  // manteniendo el orden alfabético dentro de cada grupo.
  function sortSelectedFirst() {
    const compareText = (a, b) =>
      (a.dataset.text || "").localeCompare(b.dataset.text || "");
    const sel = rowEls
      .filter((r) => selected.has(r.dataset.value))
      .sort(compareText);
    const unsel = rowEls
      .filter((r) => !selected.has(r.dataset.value))
      .sort(compareText);
    [...sel, ...unsel].forEach((row) => optWrap.appendChild(row));
  }

  function open() {
    sortSelectedFirst();
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

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  panel.addEventListener("click", (e) => e.stopPropagation());

  if (search) search.addEventListener("input", (e) => filter(e.target.value));
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

  document.addEventListener("click", () => close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  updateLabel();

  return {
    open,
    close,
    getSelected: () => new Set(selected),
  };
}

/*************************************************
 * 3) Inicio (login + Bitrix init)
 *************************************************/

qs("#md-close")?.addEventListener("click", closeCampanaModal);
qs("#md-cancelar")?.addEventListener("click", closeCampanaModal);
/*************************************************
 * 4) Home: busqueda, filtros y tabla
 *************************************************/
function initHome() {
  const buscar = qs("#buscar");
  if (buscar) {
    buscar.addEventListener("input", (e) => {
      STATE.search = e.target.value.trim().toLowerCase();
      renderTabla();
    });
  }

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
        options: STATE.campanasDisponibles.map((c) => ({ value: c, label: c })),
        selected: STATE.filtros.campanas,
        placeholder: "Selecciona opciones",
        onChange: (set) => {
          STATE.filtros.campanas =
            set instanceof Set ? set : new Set(set || []);
          updateFilterSummary();
        },
      });
    }
  }

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
        options: STATE.asesoresDisponibles.map((a) => ({
          value: a.id,
          label: a.nombre,
        })),
        selected: STATE.filtros.asesores,
        placeholder: "Selecciona asesores",
        onChange: (set) => {
          STATE.filtros.asesores =
            set instanceof Set ? set : new Set(set || []);
          updateFilterSummary();
        },
      });
    }
  }

  const btnFiltros = qs("#btn-filtros");
  const btnCloseDrawer = qs("#btn-close-drawer");
  const btnCancelarFiltros = qs("#btn-cancelar-filtros");
  const btnAplicarFiltros = qs("#btn-aplicar-filtros");

  if (btnFiltros) btnFiltros.addEventListener("click", openDrawer);
  if (btnCloseDrawer) btnCloseDrawer.addEventListener("click", closeDrawer);
  if (btnCancelarFiltros)
    btnCancelarFiltros.addEventListener("click", closeDrawer);
  if (btnAplicarFiltros) {
    btnAplicarFiltros.addEventListener("click", () => {
      updateFilterSummary();
      closeDrawer();
      renderTabla();
    });
  }

  const btnStats = qs("#btn-stats");
  const btnStatsClose = qs("#btn-stats-close");
  const btnStatsClose2 = qs("#btn-stats-close-2");
  const statsModal = qs("#stats-modal");
  if (btnStats) btnStats.addEventListener("click", openStatsModal);
  if (btnStatsClose) btnStatsClose.addEventListener("click", closeStatsModal);
  if (btnStatsClose2) btnStatsClose2.addEventListener("click", closeStatsModal);
  if (statsModal) {
    statsModal.addEventListener("click", (e) => {
      if (e.target === statsModal) closeStatsModal();
    });
  }

  updateFilterSummary();
  renderTabla();
}

function computeCampaignPendings() {
  // { campana: { pendientes, total } }
  const stats = {};
  (STATE.rows || []).forEach((r) => {
    const status = r.cardStatus || {};
    (r.campanaTexts || []).forEach((camp) => {
      if (!stats[camp]) stats[camp] = { pendientes: 0, total: 0 };
      stats[camp].total++;
      const estado = getCardStatusFromMap(status, camp);
      if (estado !== "Completado") stats[camp].pendientes++;
    });
  });
  return stats;
}

function openStatsModal() {
  const modal = qs("#stats-modal");
  const rows = qs("#stats-modal-rows");
  const footer = qs("#stats-modal-footer");
  const subtitle = qs("#stats-modal-subtitle");
  if (!modal || !rows) return;

  const stats = computeCampaignPendings();
  const entries = Object.entries(stats).sort(
    (a, b) => b[1].pendientes - a[1].pendientes || b[1].total - a[1].total,
  );

  const totalPend = entries.reduce((acc, [, s]) => acc + s.pendientes, 0);
  const totalCamp = entries.length;

  rows.innerHTML = entries.length
    ? entries
        .map(([camp, s]) => {
          const badge =
            s.pendientes === 0
              ? `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-[11px] font-semibold">✓ 0</span>`
              : `<span class="inline-flex items-center gap-1 rounded-full bg-amber-50 text-amber-700 px-2 py-0.5 text-[11px] font-semibold">${s.pendientes}</span>`;
          return `
            <tr class="hover:bg-slate-50/60">
              <td class="py-2.5 pr-3 text-slate-800">${escapeHtml(camp)}</td>
              <td class="py-2.5 pl-3 text-right">${badge}</td>
              <td class="py-2.5 pl-3 text-right text-slate-500 tabular-nums">${s.total}</td>
            </tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="py-6 text-center text-slate-400">No hay campañas visibles con los filtros actuales.</td></tr>`;

  if (footer) {
    footer.textContent = entries.length
      ? `${totalCamp} campañas · ${totalPend} pendientes en total`
      : "Sin datos";
  }
  if (subtitle) {
    subtitle.textContent =
      "Se basa en los contactos visibles con los filtros actuales.";
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeStatsModal() {
  const modal = qs("#stats-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("flex");
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

function updateFilterSummary() {
  const el = qs("#filter-summary-text");
  if (!el) return;

  const parts = [];
  const campCount = STATE.filtros.campanas?.size || 0;
  const asesorCount = STATE.filtros.asesores?.size || 0;

  if (campCount)
    parts.push(`${campCount} campaña${campCount === 1 ? "" : "s"}`);
  if (asesorCount)
    parts.push(`${asesorCount} asesor${asesorCount === 1 ? "" : "es"}`);

  el.textContent = parts.length ? parts.join(" · ") : "Ninguno";
}

function applyFilters(rows) {
  const norm = (v) => String(v || "").trim();

  if (STATE.filtros.campanas && STATE.filtros.campanas.size) {
    const set = new Set([...STATE.filtros.campanas].map(norm));
    rows = rows.filter((r) =>
      (r.campanaTexts || []).some((c) => set.has(norm(c))),
    );
  }

  if (STATE.filtros.asesores && STATE.filtros.asesores.size) {
    const set = new Set([...STATE.filtros.asesores].map(norm));
    rows = rows.filter((r) => set.has(norm(r.asesor)));
  }

  if (STATE.search) {
    const term = String(STATE.search).toLowerCase();
    rows = rows.filter((r) => {
      const campanas = (r.campanaTexts || []).join(" ").toLowerCase();
      return (
        (r.nombre || "").toLowerCase().includes(term) ||
        (r.email || "").toLowerCase().includes(term) ||
        (r.phone || "").toLowerCase().includes(term) ||
        (r.place || "").toLowerCase().includes(term) ||
        (r.asesorNombre || "").toLowerCase().includes(term) || // 👈 ESTE ES EL NUEVO
        campanas.includes(term)
      );
    });
  }

  return rows;
}
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderCampanasCell(campanas = []) {
  if (!campanas.length) return "-";

  const max = 3;
  const visibles = campanas.slice(0, max);
  const restantes = campanas.length - max;
  const id = "camp_" + Math.random().toString(36).slice(2, 9);

  const chipsHtml = visibles
    .map(
      (c) => `
        <span class="inline-flex items-center rounded-full bg-[#e9f0ff] text-[#1d73ea] text-xs font-medium px-2.5 py-1">
          ${escapeHtml(c)}
        </span>
      `,
    )
    .join("");

  const tooltipHtml = campanas
    .map(
      (c) =>
        `<div class="text-xs text-slate-700 leading-5">${escapeHtml(c)}</div>`,
    )
    .join("");

  if (restantes <= 0) {
    return `<div class="flex flex-wrap gap-1.5">${chipsHtml}</div>`;
  }

  const campanasJson = JSON.stringify(campanas).replace(/"/g, "&quot;");

  return `
    <div id="${id}" class="flex flex-wrap items-center gap-1.5">
      ${chipsHtml}

      <div class="relative inline-block group">
        <button
          type="button"
          class="inline-flex items-center rounded-full bg-slate-100 text-slate-700 text-xs font-semibold px-2.5 py-1 hover:bg-slate-200 transition"
          onclick='expandCampanas("${id}", ${campanasJson})'
        >
          +${restantes} más
        </button>

        <div class="pointer-events-none absolute left-0 top-full mt-2 hidden min-w-[220px] max-w-[320px] rounded-xl border border-slate-200 bg-white shadow-xl p-3 group-hover:block z-50">
          <div class="text-[11px] font-semibold text-slate-500 mb-2">Campañas completas</div>
          <div class="space-y-1">
            ${tooltipHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

function expandCampanas(id, campanas) {
  const el = document.getElementById(id);
  if (!el) return;

  const chipsHtml = campanas
    .map(
      (c) => `
        <span class="inline-flex items-center rounded-full bg-[#e9f0ff] text-[#1d73ea] text-xs font-medium px-2.5 py-1">
          ${escapeHtml(c)}
        </span>
      `,
    )
    .join("");

  el.innerHTML = `
    <div class="flex flex-wrap gap-1.5">
      ${chipsHtml}
    </div>
  `;
}

function renderTabla() {
  const tbody = qs("#tbody-clientes");
  if (!tbody) return;

  let rows = applyFilters([...STATE.rows]);
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="px-5 py-6 text-center text-gray-500" colspan="3">Sin resultados</td></tr>`;
    return;
  }

  rows.forEach((r) => {
    const campanaTexto = renderCampanasCell(r.campanaTexts || []);
    const tr = document.createElement("tr");
    tr.className = "border-b last:border-b-0 hover:bg-gray-50";

    tr.innerHTML = `
    <td data-label="Nombre Cliente" class="px-5 py-3 text-safe">${escapeHtml(r.nombre)}</td>
    <td data-label="Campaña" class="px-5 py-3 align-top overflow-hidden text-safe">${campanaTexto}</td>
    <td data-label="Acciones" class="px-5 py-3 relative z-10">
      <div class="flex justify-end">
        <button class="btn-ver-mas flex items-center gap-1 text-sm font-semibold text-slate-600 hover:text-[#1d73ea] transition">
          Ver más
          <i class="fa-solid fa-arrow-right text-xs"></i>
        </button>
      </div>
    </td>
  `;

    tr.querySelector(".btn-ver-mas")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDetalle(r.id);
    });

    tbody.appendChild(tr);
  });
}

/*************************************************
 * 5) Detalle de contacto
 *************************************************/
let CURRENT_CTX = { row: null, contactFull: null };


function bxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    try {
      BX24.callMethod(method, params, (result) => {
        if (result.error && result.error()) {
          reject(result.error());
          return;
        }
        resolve(result.data ? result.data() : null);
      });
    } catch (e) {
      reject(e);
    }
  });
}



/*************************************************
 * Telefonía Bitrix: llamar sin bloquear cards
 *************************************************/
function cleanPhoneForBitrix(phone = "") {
  return String(phone || "")
    .trim()
    .replace(/(?!^\+)\D/g, "");
}

function getCurrentDetailPhone() {
  const inputPhone = qs("#dtl-phone")?.value || "";
  const ctxPhone = CURRENT_CTX?.row?.phone || "";
  return cleanPhoneForBitrix(inputPhone || ctxPhone);
}

function setCallButtonsState(disabled = false) {
  ["btn-call-phone-inline"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !!disabled;
  });
}

function showCallPanel({ name = "Cliente", phone = "", status = "Preparando llamada..." } = {}) {
  const panel = document.getElementById("call-panel");
  if (!panel) return;

  panel.classList.remove("hidden");

  const body = document.getElementById("call-panel-body");
  if (body) body.classList.remove("hidden");

  const nameEl = document.getElementById("call-panel-name");
  const phoneEl = document.getElementById("call-panel-phone");
  const statusEl = document.getElementById("call-panel-status");

  if (nameEl) nameEl.textContent = name || "Cliente";
  if (phoneEl) phoneEl.textContent = phone || "Sin teléfono";
  if (statusEl) statusEl.textContent = status;
}

function updateCallPanelStatus(status = "") {
  const statusEl = document.getElementById("call-panel-status");
  if (statusEl) statusEl.textContent = status;
}

function initCallPanelControls() {
  const closeBtn = document.getElementById("call-panel-close");
  const minBtn = document.getElementById("call-panel-min");
  const panel = document.getElementById("call-panel");
  const body = document.getElementById("call-panel-body");

  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = "1";
    closeBtn.addEventListener("click", () => panel?.classList.add("hidden"));
  }

  if (minBtn && !minBtn.dataset.bound) {
    minBtn.dataset.bound = "1";
    minBtn.addEventListener("click", () => body?.classList.toggle("hidden"));
  }
}

async function callClienteBitrix() {
  const row = CURRENT_CTX?.row;
  const phone = getCurrentDetailPhone();
  const name = row?.nombre || qs("#dtl-nombre")?.textContent || "Cliente";

  if (!phone) {
    showToast("Este cliente no tiene teléfono para llamar.", "error");
    return;
  }

  setCallButtonsState(true);

  try {
    /**
     * IMPORTANTE:
     * Usamos BX24.im.phoneTo para abrir el widget flotante nativo de Bitrix
     * abajo a la derecha. Evitamos Messenger.startPhoneCall porque en este portal
     * abre el dialer grande centrado y bloquea las cards.
     */
    if (window.BX24?.im && typeof window.BX24.im.phoneTo === "function") {
      window.BX24.im.phoneTo(phone);
    } else if (window.top?.BX24?.im && typeof window.top.BX24.im.phoneTo === "function") {
      window.top.BX24.im.phoneTo(phone);
    } else {
      throw new Error("BX24.im.phoneTo no está disponible en este portal/contexto.");
    }

    showToast(`Llamada enviada a Bitrix para ${name}.`);
  } catch (e) {
    console.error("Error iniciando llamada Bitrix:", e);
    showToast("No se pudo iniciar la llamada. Revisa telefonía/permisos de Bitrix.", "error");
  } finally {
    setCallButtonsState(false);
  }
}

function bindDetalleCallButtons() {
  initCallPanelControls();

  ["btn-call-phone-inline"].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn || btn.dataset.boundCall === "1") return;

    btn.dataset.boundCall = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      callClienteBitrix();
    });
  });
}


async function openDetalle(id) {
  const row = STATE.rows.find((x) => String(x.id) === String(id));
  if (!row) return;

  CURRENT_CTX.row = row;
  bindDetalleCallButtons();

  hideById("#view-home");
  showById("#view-detalle");

  if (!Object.keys(MUNICIPIO_ENUM).length) {
    await loadMunicipioEnum();
  }
  if (!Object.keys(CONTACT_DETAIL_ENUMS).length) {
    await loadContactDetailEnums();
  }

  qs("#dtl-nombre").textContent = row.nombre || "Contacto";
  qs("#dtl-person").value = row.nombre || "";
  qs("#dtl-email").value = row.email || "";
  qs("#dtl-phone").value = row.phone || "";
  if (qs("#dtl-comments")) qs("#dtl-comments").value = "";
  fillMunicipioSelect(row.municipioId || "");

  fetchContactById(row.contactId)
    .then((contactFull) => {
      const emails = Array.isArray(contactFull?.EMAIL) ? contactFull.EMAIL : [];
      const phones = Array.isArray(contactFull?.PHONE) ? contactFull.PHONE : [];

      row.email = emails[0]?.VALUE || "";
      row.phone = phones[0]?.VALUE || "";

      qs("#dtl-email").value = row.email;
      qs("#dtl-phone").value = row.phone;
      if (qs("#dtl-comments")) qs("#dtl-comments").value = "";
      CURRENT_CTX.contactFull = contactFull;
      fillAllContactDetailSelects(contactFull);
    })
    .catch((e) => console.warn("No se pudo completar email/teléfono:", e));

  const btnToggle = document.getElementById("btn-toggle-campanas");
  if (btnToggle) {
    const btnToggleText = document.getElementById("btn-toggle-text");
    const toggleTrack = document.getElementById("toggle-track");
    const toggleDot = document.getElementById("toggle-dot");

    // Estado semántico: "hideCompleted" ON cuando estamos ocultando completadas.
    // SHOW_ALL_CAMPAIGNS = false ↔ hideCompleted = true.
    const refreshToggleLabel = () => {
      const hideCompleted = !SHOW_ALL_CAMPAIGNS;
      if (btnToggleText) {
        btnToggleText.textContent = hideCompleted
          ? "Ocultar completadas"
          : "Mostrar completadas";
      }
      if (toggleTrack) {
        toggleTrack.className = hideCompleted
          ? "relative inline-flex h-5 w-9 items-center rounded-full bg-[#1d73ea] transition-colors"
          : "relative inline-flex h-5 w-9 items-center rounded-full bg-slate-300 transition-colors";
      }
      if (toggleDot) {
        toggleDot.className = hideCompleted
          ? "inline-block h-4 w-4 rounded-full bg-white shadow transform translate-x-[18px] transition-transform"
          : "inline-block h-4 w-4 rounded-full bg-white shadow transform translate-x-[2px] transition-transform";
      }
      btnToggle.setAttribute("aria-checked", hideCompleted ? "true" : "false");
    };
    refreshToggleLabel();
    btnToggle.onclick = () => {
      SHOW_ALL_CAMPAIGNS = !SHOW_ALL_CAMPAIGNS;
      refreshToggleLabel();
      renderCampaignCardsByContact(row.contactId);
    };
  }

  const btnActualizar = document.getElementById("btn-actualizar-contacto");
  if (btnActualizar) {
    btnActualizar.onclick = () => saveContactFromDetalle();
  }

  const btnBack = qs("#btn-back");
  if (btnBack) {
    btnBack.onclick = () => {
hideById("#view-detalle");
      showById("#view-home");
    };
  }

  renderCampaignCardsByContact(row.contactId);
}

function fillMunicipioSelect(selectedId = "") {
  const sel = qs("#dtl-place");
  if (!sel) return;

  sel.innerHTML = `<option value="">Selecciona ciudad</option>`;

  Object.entries(MUNICIPIO_ENUM)
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .forEach(([id, text]) => {
      const opt = document.createElement("option");
      opt.value = String(id);
      opt.textContent = text;

      if (String(id) === String(selectedId)) {
        opt.selected = true;
      }

      sel.appendChild(opt);
    });
}

async function renderCampaignCardsByContact(contactId) {
  const wrap = qs("#dtl-cards");
  if (!wrap) return;

  wrap.innerHTML = `<div class="text-sm text-slate-500">Cargando campañas activas...</div>`;

  let contact = null;

  try {
    contact = await fetchContactById(contactId);
    await loadCampanaEnum();
    hydrateCardStatusMapFromContact(contact);
  } catch (e) {
    console.error("Error consultando contacto:", e);
    wrap.innerHTML = `<div class="text-sm text-red-500">No se pudieron cargar las campañas activas.</div>`;
    return;
  }

  if (!contact) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">No se encontró el contacto.</div>`;
    return;
  }

  if (
    !STATE.isAdmin &&
    STATE.asesorId &&
    String(contact.ASSIGNED_BY_ID || "") !== STATE.asesorId
  ) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">Este contacto no está asignado a tu usuario.</div>`;
    return;
  }

  // Nueva fuente: IDs de producto del campo comercial. Los productos ya
  // vienen precargados en VALID_CAMPAIGN_PRODUCTS (solo activos), así que
  // no hace falta un fetch por card.
  const productIds = normalizeMultiValue(contact[CAMPANA_COMERCIAL_FIELD_CODE]);
  const statusMap = loadCardStatusMap();

  const productosCards = productIds
    .map((pid) => VALID_CAMPAIGN_PRODUCTS[String(pid)])
    .filter(Boolean)
    .map((producto) => ({
      campanaTxt: String(producto.NAME || "").trim(),
      producto,
    }))
    .filter(({ campanaTxt }) => {
      const key = getCardStatusKey(contactId, campanaTxt);
      const baseKey = getCardStatusKey(contactId, stripCampaignSuffix(campanaTxt));
      const estado = statusMap[key] || statusMap[baseKey];
      if (!SHOW_ALL_CAMPAIGNS && estado === "Completado") return false;
      return true;
    });

  if (!productosCards.length) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">Este contacto no tiene campañas activas.</div>`;
    return;
  }

  wrap.innerHTML = "";

  productosCards.forEach(({ campanaTxt, producto }) => {
    const fechaInicioRaw = getBitrixPropValue(producto?.PROPERTY_360);
    const fechaFinRaw = getBitrixPropValue(producto?.PROPERTY_356);
    const estadoRaw = getBitrixPropValue(producto?.PROPERTY_358);

    const estadoCampana = estadoRaw || "Sin estado";
    const cardKey = getCardStatusKey(contactId, campanaTxt);
    const baseCardKey = getCardStatusKey(contactId, stripCampaignSuffix(campanaTxt));
    const estadoSeguimiento =
      statusMap[cardKey] || statusMap[baseCardKey] || "Por completar";

    const card = document.createElement("div");
    card.className =
      "bg-white border border-slate-200 shadow-sm rounded-2xl p-4 sm:p-6 min-w-0";

    card.innerHTML = `
  <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
    <div>
      <div class="text-xl font-semibold text-slate-900 text-safe">
        ${escapeHtml(campanaTxt)}
      </div>
    </div>

    <div class="text-sm font-semibold text-green-600">
      ${escapeHtml(estadoCampana)}
    </div>
  </div>

  <div class="mt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
    <div class="text-sm font-medium ${
      estadoSeguimiento === "Completado"
        ? "text-green-600"
        : estadoSeguimiento === "Seguimiento"
          ? "text-blue-600"
          : "text-orange-500"
    }">
      ${escapeHtml(estadoSeguimiento)}
    </div>

    <button 
      class="btn-detalle w-full sm:w-auto px-4 py-2 rounded-full border border-blue-500 text-blue-500 text-sm font-medium hover:bg-blue-50 transition"
    >
      Detalle
    </button>
  </div>
`;

    card.querySelector(".btn-detalle")?.addEventListener("click", () => {
      openCampanaModal({
        nombre: campanaTxt,
        producto,
      });
    });

    wrap.appendChild(card);
  });
}
// ===== MODAL CAMPAÑA =====

let CURRENT_MODAL_CTX = {
  campana: null,
  producto: null,
  estadoCliente: "",
};

function toDateInputValue(value) {
  if (!value) return "";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function openCampanaModal(ctx) {
  CURRENT_MODAL_CTX = {
    campana: ctx?.nombre || "",
    producto: ctx?.producto || null,
    estadoCliente: "",
  };

  const modal = qs("#modal");
  if (!modal) return;

  const fechaInicioRaw = getBitrixPropValue(ctx?.producto?.PROPERTY_360);
  const fechaFinRaw = getBitrixPropValue(ctx?.producto?.PROPERTY_356);

  qs("#md-titulo").textContent = ctx?.nombre || "Detalle campaña";
  qs("#md-inicio-text").textContent = formatFechaBitrix(fechaInicioRaw);
  qs("#md-fin-text").textContent = formatFechaBitrix(fechaFinRaw);
  qs("#md-notas").value = "";

  qsa("[data-estado]").forEach((btn) => {
    btn.classList.remove("ring-2", "ring-offset-2", "ring-[#1d73ea]");
    btn.onclick = () => {
      CURRENT_MODAL_CTX.estadoCliente = btn.dataset.estado || "";

      qsa("[data-estado]").forEach((b) => {
        b.classList.remove("ring-2", "ring-offset-2", "ring-[#1d73ea]");
      });

      btn.classList.add("ring-2", "ring-offset-2", "ring-[#1d73ea]");
    };
  });

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeCampanaModal() {
  const modal = qs("#modal");
  if (!modal) return;

  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

function formatNowForLog() {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}/${month}/${day}`;
}

function findEnumOptionByValue(list = [], value = "") {
  const target = String(value || "")
    .trim()
    .toLowerCase();
  return (
    list.find(
      (item) =>
        String(item.VALUE || "")
          .trim()
          .toLowerCase() === target,
    ) || null
  );
}

function getContactUserfieldByName(fieldName) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(
      "crm.contact.userfield.list",
      {
        filter: {
          FIELD_NAME: fieldName,
        },
      },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }

        const rows = result.data() || [];
        resolve(rows[0] || null);
      },
    );
  });
}

function updateContactUserfieldList(fieldId, currentList, newValue) {
  return new Promise((resolve, reject) => {
    const nextList = [...(currentList || [])];

    nextList.push({
      VALUE: newValue,
      SORT: 500,
      XML_ID: `AUTO_${Date.now()}`,
    });

    BX24.callMethod(
      "crm.contact.userfield.update",
      {
        id: fieldId,
        fields: {
          LIST: nextList,
        },
      },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }

        resolve(true);
      },
    );
  });
}

async function ensureContactEnumOption(fieldCode, valueText) {
  const cleanValue = String(valueText || "").trim();
  if (!cleanValue) return "";

  const userField = await getContactUserfieldByName(fieldCode);
  if (!userField?.ID) {
    throw new Error(`No se encontró el campo ${fieldCode}.`);
  }

  let option = findEnumOptionByValue(userField.LIST || [], cleanValue);

  if (!option) {
    await updateContactUserfieldList(
      userField.ID,
      userField.LIST || [],
      cleanValue,
    );
    const refreshedField = await getContactUserfieldByName(fieldCode);
    option = findEnumOptionByValue(refreshedField?.LIST || [], cleanValue);
  }

  if (!option?.ID) {
    throw new Error(
      `No se pudo crear la opción "${cleanValue}" en ${fieldCode}.`,
    );
  }

  CONTACT_DETAIL_ENUMS[fieldCode] = {
    ...(CONTACT_DETAIL_ENUMS[fieldCode] || {}),
    [String(option.ID)]: cleanValue,
  };

  return String(option.ID);
}

async function getContactDetailFieldValues(fieldKey) {
  const cfg = CONTACT_DETAIL_FIELDS[fieldKey];
  if (!cfg) return [];

  const selectedValues = getSelectedOptionsValues(cfg.selector);
  const values = selectedValues.filter((v) => v !== CONTACT_DETAIL_OTHER_VALUE);

  if (selectedValues.includes(CONTACT_DETAIL_OTHER_VALUE)) {
    const manualValue = qs(cfg.otherSelector)?.value.trim() || "";
    if (!manualValue) {
      throw new Error(
        `Debes escribir la opción manual para ${cfg.placeholder}.`,
      );
    }

    const newId = await ensureContactEnumOption(cfg.code, manualValue);
    values.push(String(newId));

    // Deja la nueva opción marcada visualmente después de crearla.
    await loadContactDetailEnums();
    const currentContact = await fetchContactById(CURRENT_CTX?.row?.contactId);
    const nextSelected = [
      ...new Set([
        ...normalizeMultiUfValues(currentContact?.[cfg.code]),
        ...values,
      ]),
    ];
    fillContactDetailSelect(
      cfg.selector,
      CONTACT_DETAIL_ENUMS[cfg.code] || {},
      nextSelected,
      cfg.placeholder,
      cfg.otherSelector,
    );
  }

  return [...new Set(values.map(String).filter(Boolean))];
}

function getDealUserfieldByName(fieldName) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(
      "crm.deal.userfield.list",
      {
        filter: {
          FIELD_NAME: fieldName,
        },
      },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }

        const rows = result.data() || [];
        resolve(rows[0] || null);
      },
    );
  });
}

function updateDealUserfieldList(fieldId, currentList, newValue) {
  return new Promise((resolve, reject) => {
    const nextList = [...(currentList || [])];

    nextList.push({
      VALUE: newValue,
      SORT: 500,
      XML_ID: `AUTO_${Date.now()}`,
    });

    BX24.callMethod(
      "crm.deal.userfield.update",
      {
        id: fieldId,
        fields: {
          LIST: nextList,
        },
      },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }

        resolve(true);
      },
    );
  });
}

// Solo busca el ID de la opción existente. No la crea (los asesores no tienen
// permisos de admin para modificar la lista del userfield del deal).
async function findDealEnumOptionId(fieldCode, valueText) {
  const userField = await getDealUserfieldByName(fieldCode);

  if (!userField?.ID) {
    throw new Error(`No se encontró el campo deal ${fieldCode}.`);
  }

  const option = findEnumOptionByValue(userField.LIST || [], valueText);

  if (!option?.ID) {
    throw new Error(
      `La campaña "${valueText}" no existe en el campo ${fieldCode}. Pide al administrador que la agregue al embudo.`,
    );
  }

  return option.ID;
}

function createDeal(fields) {
  return new Promise((resolve, reject) => {
    BX24.callMethod("crm.deal.add", { fields }, (result) => {
      if (result.error()) {
        reject(result.error());
        return;
      }

      resolve(result.data());
    });
  });
}

function updateDealFields(dealId, fields) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(
      "crm.deal.update",
      { id: String(dealId), fields },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }
        resolve(result.data());
      },
    );
  });
}

function fetchDealById(dealId) {
  return new Promise((resolve, reject) => {
    BX24.callMethod("crm.deal.get", { id: String(dealId) }, (result) => {
      if (result.error()) {
        reject(result.error());
        return;
      }
      resolve(result.data());
    });
  });
}

async function createInteresadoDeal({
  contactId,
  campana,
  estadoCliente,
  notas,
  asesorId,
  nombreCliente,
}) {
  const dealCampanaField = "UF_CRM_1718745465646";
  const dealEstadoField = "UF_CRM_1764401898591";
  const dealNotasField = "UF_CRM_68911F4662EF3";

  const campanaOptionId = await findDealEnumOptionId(dealCampanaField, campana);

  // El campo de estado puede estar configurado como lista (enumeration) o como
  // texto. Si es lista, Bitrix ignora silenciosamente cualquier valor que no sea
  // un ID de opción válido, por eso resolvemos el ID cuando aplica.
  let estadoValue = estadoCliente;
  try {
    const estadoField = await getDealUserfieldByName(dealEstadoField);
    if (estadoField?.USER_TYPE_ID === "enumeration") {
      const option = findEnumOptionByValue(estadoField.LIST || [], estadoCliente);
      if (option?.ID) {
        estadoValue = option.ID;
      }
    }
  } catch (_) {
    // Si no se puede consultar el campo, dejamos el string original y que
    // Bitrix decida. No bloqueamos la creación del negocio por esto.
  }

  const title =
    `${String(nombreCliente || "").trim()} - ${String(campana || "").trim()}`.trim();

  const fields = {
    TITLE: title,
    CATEGORY_ID: 10,
    STAGE_ID: "C10:NEW",
    CONTACT_ID: String(contactId),
    ASSIGNED_BY_ID: asesorId ? Number(asesorId) : undefined,
    [dealEstadoField]: estadoValue,
    [dealNotasField]: notas,
    [dealCampanaField]: campanaOptionId,
  };

  // limpia undefined por si no viene asesor
  Object.keys(fields).forEach((key) => {
    if (fields[key] === undefined) delete fields[key];
  });

  console.log("[deal.add] payload:", fields);
  const dealId = await createDeal(fields);
  console.log("[deal.add] creado dealId:", dealId);

  // Workaround: Bitrix a veces dropea silenciosamente campos UF en el add
  // cuando la visibilidad del campo está restringida a otro embudo. Volvemos
  // a forzar el estado con un update y verificamos qué quedó realmente.
  try {
    const dealCreado = await fetchDealById(dealId);
    const estadoActual = dealCreado?.[dealEstadoField];
    console.log(`[deal.add] ${dealEstadoField} despues del add:`, estadoActual);

    if (!estadoActual || String(estadoActual).trim() === "") {
      console.warn(
        `[deal.add] ${dealEstadoField} quedó vacío tras el add. Reintentando con update...`,
      );
      await updateDealFields(dealId, { [dealEstadoField]: estadoValue });
      const dealCheck = await fetchDealById(dealId);
      console.log(
        `[deal.add] ${dealEstadoField} despues del update:`,
        dealCheck?.[dealEstadoField],
      );
    }
  } catch (err) {
    console.warn("[deal.add] no se pudo verificar/reintentar estado:", err);
  }

  return dealId;
}
async function updateContactEnumValue(contactId, fieldCode, enumId) {
  const contact = await fetchContactById(contactId);

  const currentValues = Array.isArray(contact?.[fieldCode])
    ? contact[fieldCode].map(String).filter(Boolean)
    : contact?.[fieldCode]
      ? [String(contact[fieldCode])]
      : [];

  const nextValues = [...new Set([...currentValues, String(enumId)])];

  return new Promise((resolve, reject) => {
    BX24.callMethod(
      "crm.contact.update",
      {
        id: String(contactId),
        fields: {
          [fieldCode]: nextValues,
        },
      },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }

        resolve(true);
      },
    );
  });
}

qs("#md-guardar")?.addEventListener("click", async () => {
  if (!CURRENT_MODAL_CTX.estadoCliente) {
    showToast("Selecciona un estado del cliente antes de guardar.", "error");
    return;
  }

  const estadoRaw = CURRENT_MODAL_CTX.estadoCliente;

  const estadoLabelMap = {
    interesado: "Interesado",
    no_interesado: "No interesado",
    inseguro: "Inseguro",
  };

  const estadoCliente = estadoLabelMap[estadoRaw] || estadoRaw;
  const notas = qs("#md-notas")?.value.trim() || "";
  const fechaActual = formatNowForLog();
  const campana = CURRENT_MODAL_CTX.campana || "Sin campaña";
  const contactId = CURRENT_CTX?.row?.contactId;

  if (!contactId) {
    showToast("No se encontró el contacto actual.", "error");
    return;
  }

  // Historial de gestiones de la card.
  // IMPORTANTE: este campo es TEXTO, no LISTA. Así los asesores pueden guardar
  // sin permisos de administrador, porque solo se actualiza el contacto.
  const historialFieldCode = "UF_CRM_1778554107651";
  const resumen = notas
    ? `${fechaActual} | ${campana} | ${estadoCliente} | ${notas}`
    : `${fechaActual} | ${campana} | ${estadoCliente}`;

  try {
    setModalGuardarState("loading");
    showModalLoader();

    const contactActual = await fetchContactById(contactId);
    const historialActual = String(contactActual?.[historialFieldCode] || "").trim();
    const historialFinal = historialActual
      ? `${historialActual}
${resumen}`
      : resumen;

    // Estado de la card (visible para todos los asesores y el admin).
    // Mapeo: Interesado / No interesado → "Completado"; Inseguro → "Seguimiento".
    const cardEstadoBitrix =
      estadoRaw === "inseguro"
        ? "Seguimiento"
        : estadoRaw === "interesado" || estadoRaw === "no_interesado"
          ? "Completado"
          : "";

    const cardStatusBitrix = parseContactCardStatus(contactActual);
    if (cardEstadoBitrix && campana) {
      cardStatusBitrix[campana] = cardEstadoBitrix;
    }

    await bxCall("crm.contact.update", {
      id: String(contactId),
      fields: {
        [historialFieldCode]: historialFinal,
        [CARD_STATUS_FIELD_CODE]: JSON.stringify(cardStatusBitrix),
      },
    });

    let dealFailed = false;
    let dealErrorMsg = "";

    if (estadoRaw === "interesado") {
      const nombreCliente = (CURRENT_CTX?.row?.nombre || "").trim();

      // La creación del negocio es complementaria. Si Bitrix bloquea la creación
      // o la opción de lista del negocio, no debe perderse el historial guardado.
      try {
        await createInteresadoDeal({
          contactId,
          campana,
          estadoCliente,
          notas,
          asesorId: STATE.asesorId || CURRENT_CTX?.row?.asesor || "",
          nombreCliente,
        });
      } catch (dealError) {
        dealFailed = true;
        dealErrorMsg =
          dealError?.ex?.error_description ||
          dealError?.error_description ||
          dealError?.message ||
          String(dealError);
        console.warn(
          "Historial guardado, pero no se pudo crear la negociación:",
          dealError,
        );
      }
    }

    const statusMap = loadCardStatusMap();
    const cardKey = getCardStatusKey(contactId, campana);

    if (estadoRaw === "no_interesado" || estadoRaw === "interesado") {
      statusMap[cardKey] = "Completado";
    }

    if (estadoRaw === "inseguro") {
      statusMap[cardKey] = "Seguimiento";
    }

    saveCardStatusMap(statusMap);

    await renderCampaignCardsByContact(contactId);
    setModalGuardarState("success");
    hideModalLoader();

    if (dealFailed) {
      showToast(
        `Historial guardado, pero la negociación no se creó: ${dealErrorMsg}`,
        "error",
      );
    } else {
      showToast("Guardado correctamente.");
    }

    setTimeout(() => {
      closeCampanaModal();
      setModalGuardarState("idle");
    }, 500);
  } catch (e) {
    console.error("Error guardando historial de la card:", e);
    setModalGuardarState("idle");
    hideModalLoader();
    showToast("No se pudo guardar el historial de la card.", "error");
  }
});

function setActualizarButtonState(state = "idle") {
  const btn = document.getElementById("btn-actualizar-contacto");
  if (!btn) return;

  if (!btn.dataset.originalText) {
    btn.dataset.originalText = btn.textContent.trim() || "Actualizar datos";
  }

  if (state === "loading") {
    btn.disabled = true;
    btn.classList.add("opacity-70", "cursor-not-allowed");
    btn.innerHTML = `
      <span class="inline-flex items-center gap-2">
        <i class="fa-solid fa-spinner fa-spin"></i>
        Guardando...
      </span>
    `;
    return;
  }

  if (state === "success") {
    btn.disabled = true;
    btn.classList.remove("opacity-70", "cursor-not-allowed");
    btn.innerHTML = `
      <span class="inline-flex items-center gap-2">
        <i class="fa-solid fa-check"></i>
        Datos actualizados
      </span>
    `;
    return;
  }

  btn.disabled = false;
  btn.classList.remove("opacity-70", "cursor-not-allowed");
  btn.textContent = btn.dataset.originalText || "Actualizar datos";
}

function formatContactDetailValueForBitrix(fieldCode, ids = []) {
  const cleanIds = [...new Set((ids || []).map(String).filter(Boolean))];
  const meta = CONTACT_DETAIL_META[fieldCode] || {};

  // Viajes futuros y realizados suelen ser múltiples.
  // Tipo contacto/tipo cliente muchas veces en Bitrix es lista simple.
  // Si el campo NO es múltiple y enviamos array, Bitrix puede dejarlo como "no seleccionado".
  if (!meta.isMultiple) {
    return cleanIds.length ? cleanIds[0] : null;
  }

  return cleanIds.length ? cleanIds : null;
}

async function saveContactFromDetalle() {
  const row = CURRENT_CTX.row;
  if (!row || !row.contactId) {
    showToast("No se encontró el contacto para este registro.", "error");
    return;
  }

  const fullName = qs("#dtl-person")?.value.trim() || "";
  const email = qs("#dtl-email")?.value.trim() || "";
  const phone = qs("#dtl-phone")?.value.trim() || "";
  const municipioId = qs("#dtl-place")?.value || "";
  const comments = qs("#dtl-comments")?.value.trim() || "";
  const placeTxt = MUNICIPIO_ENUM[municipioId] || "";
  let viajesFuturosIds = [];
  let tipoContactoIds = [];
  let viajesRealizadosIds = [];

  let NAME = fullName;
  let LAST_NAME = "";
  if (fullName.includes(" ")) {
    const parts = fullName.split(" ");
    NAME = parts.shift() || "";
    LAST_NAME = parts.join(" ");
  }

  setActualizarButtonState("loading");
  showDetalleLoader();

  try {
    viajesFuturosIds = await getContactDetailFieldValues("viajesFuturos");
    tipoContactoIds = await getContactDetailFieldValues("tipoContacto");
    viajesRealizadosIds = await getContactDetailFieldValues("viajesRealizados");

    const contact = await fetchContactById(row.contactId);

    // COMMENTS: no mostramos historial en pantalla, pero sí lo conservamos en Bitrix.
    // Formato solicitado: fecha sin hora + comentario.
    const comentariosActuales = contact?.COMMENTS || "";
    const fechaComentario = new Date().toLocaleDateString("es-CO");
    const commentsFinal = comments
      ? `${comentariosActuales}\n${fechaComentario} - ${comments}`.trim()
      : comentariosActuales;

    const emails = Array.isArray(contact?.EMAIL) ? contact.EMAIL : [];
    const phones = Array.isArray(contact?.PHONE) ? contact.PHONE : [];

    const firstEmail = emails[0] || null;
    const firstPhone = phones[0] || null;

    const emailPayload = [];
    const phonePayload = [];

    if (email) {
      if (firstEmail?.ID) {
        emailPayload.push({
          ID: firstEmail.ID,
          VALUE: email,
          VALUE_TYPE: firstEmail.VALUE_TYPE || "WORK",
        });
      } else {
        emailPayload.push({
          VALUE: email,
          VALUE_TYPE: "WORK",
        });
      }

      // elimina emails extra
      for (let i = 1; i < emails.length; i++) {
        if (emails[i]?.ID) {
          emailPayload.push({
            ID: emails[i].ID,
            DELETE: "Y",
          });
        }
      }
    }

    if (phone) {
      if (firstPhone?.ID) {
        phonePayload.push({
          ID: firstPhone.ID,
          VALUE: phone,
          VALUE_TYPE: firstPhone.VALUE_TYPE || "WORK",
        });
      } else {
        phonePayload.push({
          VALUE: phone,
          VALUE_TYPE: "WORK",
        });
      }

      // elimina teléfonos extra
      for (let i = 1; i < phones.length; i++) {
        if (phones[i]?.ID) {
          phonePayload.push({
            ID: phones[i].ID,
            DELETE: "Y",
          });
        }
      }
    }

    const fields = {
      NAME,
      LAST_NAME,
      COMMENTS: commentsFinal,
      UF_CRM_1722975246: municipioId || null,
      UF_CRM_1723205267: formatContactDetailValueForBitrix(
        "UF_CRM_1723205267",
        viajesFuturosIds,
      ),
      TYPE_ID: formatContactDetailValueForBitrix(
        "TYPE_ID",
        tipoContactoIds,
      ),
      UF_CRM_1671644220: formatContactDetailValueForBitrix(
        "UF_CRM_1671644220",
        viajesRealizadosIds,
      ),
    };

    if (email) fields.EMAIL = emailPayload;
    if (phone) fields.PHONE = phonePayload;

    console.log("Campos detalle a actualizar:", {
      viajesFuturosIds,
      tipoContactoIds,
      viajesRealizadosIds,
      fields,
      CONTACT_DETAIL_META,
    });

    BX24.callMethod(
      "crm.contact.update",
      { id: row.contactId, fields },
      function (result) {
        if (result.error()) {
          console.error("Error al actualizar contacto:", result.error());
          setActualizarButtonState("idle");
          hideDetalleLoader();
          showToast("Error actualizando el contacto.", "error");
          return;
        }

        row.nombre = fullName || row.nombre;
        row.email = email || row.email;
        row.phone = phone || row.phone;
        row.municipioId = municipioId;
        row.place = placeTxt || row.place;
        row.viajesFuturosIds = viajesFuturosIds;
        row.tipoContactoIds = tipoContactoIds;
        row.viajesRealizadosIds = viajesRealizadosIds;
        row.comments = comments;
        if (qs("#dtl-comments")) qs("#dtl-comments").value = "";

        qs("#dtl-nombre").textContent = row.nombre || "Contacto";
        renderTabla();

        setActualizarButtonState("success");
        hideDetalleLoader();
        showToast("Datos actualizados correctamente.");

        setTimeout(() => setActualizarButtonState("idle"), 1800);
      },
    );
  } catch (e) {
    console.error("No se pudo preparar la actualización del contacto:", e);
    setActualizarButtonState("idle");
    hideDetalleLoader();
    showToast(
      e?.message || "No se pudo preparar la actualización del contacto.",
      "error",
    );
  }
}