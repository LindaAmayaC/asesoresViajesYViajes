
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
  rows: [], // filas para la tabla (contactos)
  campanasDisponibles: [],
  asesoresDisponibles: [],
};
const LS_CARD_STATUS_KEY = "vyv_card_status_v1";
let SHOW_ALL_CAMPAIGNS = false;
// === TEMP: desactivar login inicial (mostrar HOME directo) ===
const DISABLE_LOGIN = false;
let USER_MAP = {}; // ID -> Nombre completo
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

function getCardStatusKey(contactId, campana) {
  return `${String(contactId)}::${String(campana || "").trim().toLowerCase()}`;
}

function showToast(message = "", type = "success") {
  let toast = document.getElementById("vyv-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "vyv-toast";
    toast.className = "fixed top-5 right-5 z-[9999] hidden min-w-[280px] max-w-[420px] rounded-2xl px-4 py-3 shadow-2xl border text-sm font-medium transition-all";
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

      if (result.more()) {
        result.next();
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

async function loadUsersMap() {
  try {
    const users = await bxList("user.get", {
      select: ["ID", "NAME", "LAST_NAME", "SECOND_NAME", "EMAIL"],
    });

    USER_MAP = {};

    users.forEach((u) => {
      const id = String(u.ID || "");
      const nombre = [u.NAME, u.LAST_NAME]
        .filter(Boolean)
        .join(" ")
        .trim();

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
    .map((id) => CAMPANA_ENUM[String(id)] || String(id))
    .filter(Boolean);
}


async function loadContactosFromBitrix() {
  const contacts = await bxList("crm.contact.list", {
    filter: {
      "!UF_CRM_1768059328177": false,
      ...(STATE.asesorId ? { ASSIGNED_BY_ID: STATE.asesorId } : {}),
    },
    select: [
      "ID",
      "NAME",
      "LAST_NAME",
      "SECOND_NAME",
      "ASSIGNED_BY_ID",
      "UF_CRM_1722975246",
      "UF_CRM_1768059328177",
      "PHONE",
      "EMAIL",
    ],
  });

  STATE.rows = contacts.map((c) => {
    const id = String(c.ID || "");
    const asesorId = String(c.ASSIGNED_BY_ID || "");
    const nombre =
      [c.NAME, c.LAST_NAME].filter(Boolean).join(" ") || `Contacto #${id}`;
    const phoneArr = Array.isArray(c.PHONE) ? c.PHONE : [];
    const emailArr = Array.isArray(c.EMAIL) ? c.EMAIL : [];
    const phone = phoneArr[0]?.VALUE || "";
    const email = emailArr[0]?.VALUE || "";
    const municipioId = c.UF_CRM_1722975246 || "";
    const campanaIds = normalizeMultiValue(c.UF_CRM_1768059328177);
    const campanaTexts = campanaIdsToTexts(campanaIds);

    return {
    id,
    contactId: id,
    nombre,
    asesor: asesorId,
    asesorNombre: USER_MAP[asesorId]?.nombre || `Asesor ${asesorId}`,
    email,
    phone,
    place: MUNICIPIO_ENUM[String(municipioId)] || "",
    municipioId,
    campanaIds,
    campanaTexts,
    campanaFila: campanaTexts[0] || "-",
    estadoFila: campanaTexts.length ? "Activo" : "Sin campañas",
  };
  });

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
          email: r.asesorEmail,
        },
      ])
  ).values(),
].sort((a, b) => a.nombre.localeCompare(b.nombre));
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
      }
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

async function validateAsesorEmail(value) {
  const term = String(value || "").trim().toLowerCase();
  if (!term) return false;

  try {
    const users = await bxList("user.get", {
      filter: { EMAIL: term },
      select: ["ID", "EMAIL", "NAME", "LAST_NAME"],
    });

    const match = users.find(
      (u) => String(u.EMAIL || "").trim().toLowerCase() === term
    );

    if (!match) return null;

    return {
      id: String(match.ID || ""),
      email: String(match.EMAIL || "").trim(),
      nombre: [match.NAME, match.LAST_NAME].filter(Boolean).join(" ").trim(),
    };
  } catch (e) {
    console.error("Error validando asesor por email en Bitrix24:", e);
    return null;
  }
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

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

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
    if (!count) {
      labelEl.textContent = placeholder;
      labelEl.classList.add("text-slate-500");
      labelEl.classList.remove("text-slate-700");
      return;
    }

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
document.addEventListener("DOMContentLoaded", () => {
  if (DISABLE_LOGIN) {
    (async () => {
      try {
        hideById("#view-login");
        showById("#view-home");

        showGlobalLoader("Cargando informacion...");

        if (window.BX24) {
          await new Promise((resolve) => BX24.init(resolve));
        showGlobalLoader("Cargando municipios...");
        await loadMunicipioEnum();

        showGlobalLoader("Cargando campanas...");
        await loadCampanaEnum();

        showGlobalLoader("Cargando asesores...");
        await loadUsersMap(); 

        showGlobalLoader("Cargando contactos...");
        await loadContactosFromBitrix(); 

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
    hideById("#view-home");
    showById("#view-login");

  const btnLogin = qs("#btn-login");
  const asesorInput = qs("#in-asesor");



  if (!btnLogin) {
    console.error("No se encontro el boton #btn-login");
    return;
  }

  if (asesorInput) asesorInput.addEventListener("input", () => clearLoginError());

  btnLogin.addEventListener("click", async () => {
    const n = asesorInput?.value.trim() || "";
    clearLoginError();
    if (!n) {
      setLoginError("Ingresa tu numero de asesor para continuar.");
      return;
    }

    if (!window.BX24) {
      console.warn("BX24 no esta definido. Front sin datos reales.");
      alert("No se encontro BX24. Estas viendo solo el front sin datos reales.");

      STATE.asesorActual = n;
      STATE.asesorId = "";
      showGlobalLoader("Cargando informacion...");
      hideById("#view-login");
      showById("#view-home");
      initHome();
      hideGlobalLoader();
      return;
    }

    showGlobalLoader("Validando asesor...");

    try {
      await new Promise((resolve) => BX24.init(resolve));
      const user = await validateAsesorEmail(n);
      if (!user || !user.id) {
        setLoginError("No encontramos ese asesor en Bitrix24 con ese correo.");
        hideGlobalLoader();
        return;
      }

      STATE.asesorActual = n;
      STATE.asesorId = user.id;

      showGlobalLoader("Cargando informacion...");
      hideById("#view-login");
      showById("#view-home");

      showGlobalLoader("Cargando municipios...");
      await loadMunicipioEnum();

      showGlobalLoader("Cargando campanas...");
      await loadCampanaEnum();

      showGlobalLoader("Cargando asesores...");
      await loadUsersMap();

      showGlobalLoader("Cargando contactos...");
      await loadContactosFromBitrix();

      showGlobalLoader("Preparando vista...");
      initHome();
    } catch (e) {
      console.error("Error al cargar crm.contact.list:", e);
      alert("Error cargando contactos desde Bitrix24. Revisa la consola.");
      initHome();
    } finally {
      hideGlobalLoader();
    }
  });
});

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
          STATE.filtros.campanas = set instanceof Set ? set : new Set(set || []);
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
          label: a.email ? `${a.nombre} (${a.email})` : a.nombre,
        })),
        selected: STATE.filtros.asesores,
        placeholder: "Selecciona asesores",
        onChange: (set) => {
          STATE.filtros.asesores = set instanceof Set ? set : new Set(set || []);
        },
      });
    }
  }

  const fxInicio = qs("#fx-inicio");
  const fxFin = qs("#fx-fin");
  if (fxInicio) fxInicio.addEventListener("change", (e) => (STATE.filtros.inicio = e.target.value));
  if (fxFin) fxFin.addEventListener("change", (e) => (STATE.filtros.fin = e.target.value));

  const btnFiltros = qs("#btn-filtros");
  const btnCloseDrawer = qs("#btn-close-drawer");
  const btnCancelarFiltros = qs("#btn-cancelar-filtros");
  const btnAplicarFiltros = qs("#btn-aplicar-filtros");

  if (btnFiltros) btnFiltros.addEventListener("click", openDrawer);
  if (btnCloseDrawer) btnCloseDrawer.addEventListener("click", closeDrawer);
  if (btnCancelarFiltros) btnCancelarFiltros.addEventListener("click", closeDrawer);
  if (btnAplicarFiltros) {
    btnAplicarFiltros.addEventListener("click", () => {
      closeDrawer();
      renderTabla();
    });
  }

  renderTabla();
}

function openDrawer() {
  const d = qs("#drawer");
  if (!d) return;
  d.classList.remove("hidden");
  requestAnimationFrame(() => d.classList.replace("translate-x-full", "translate-x-0"));
}
function closeDrawer() {
  const d = qs("#drawer");
  if (!d) return;
  d.classList.replace("translate-x-0", "translate-x-full");
  setTimeout(() => d.classList.add("hidden"), 250);
}

function applyFilters(rows) {
  const norm = (v) => String(v || "").trim();

  if (STATE.filtros.campanas && STATE.filtros.campanas.size) {
    const set = new Set([...STATE.filtros.campanas].map(norm));
    rows = rows.filter((r) => (r.campanaTexts || []).some((c) => set.has(norm(c))));
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

function renderCampanasCell(campanas = []) {
  if (!campanas.length) return "-";

  const max = 3;
  const visibles = campanas.slice(0, max);
  const restantes = campanas.length - max;
  const id = "camp_" + Math.random().toString(36).slice(2, 9);

  if (restantes <= 0) {
    return visibles.join(", ");
  }

  const campanasJson = JSON.stringify(campanas)
    .replace(/"/g, "&quot;");

  return `
    <span id="${id}">
      ${visibles.join(", ")}
      <button
        type="button"
        class="text-[#1d73ea] font-semibold ml-1 hover:underline"
        onclick='expandCampanas("${id}", ${campanasJson})'
      >
        +${restantes} más
      </button>
    </span>
  `;
}

function expandCampanas(id, campanas) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = campanas.join(", ");
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
    .map((c) => `<div class="text-xs text-slate-700 leading-5">${escapeHtml(c)}</div>`)
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
    <td class="px-5 py-3">${r.nombre}</td>
    <td class="px-5 py-3 align-top overflow-hidden">${campanaTexto}</td>
    <td class="px-5 py-3 relative z-10">
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
let CURRENT_CTX = { row: null };

function openDetalle(id) {
  const row = STATE.rows.find((x) => String(x.id) === String(id));
  if (!row) return;

  CURRENT_CTX.row = row;

  hideById("#view-home");
  showById("#view-detalle");

  qs("#dtl-nombre").textContent = row.nombre || "Contacto";
  qs("#dtl-person").value = row.nombre || "";
  qs("#dtl-email").value = row.email || "";
  qs("#dtl-phone").value = row.phone || "";

  fillMunicipioSelect(row.municipioId || "");
const btnToggle = document.getElementById("btn-toggle-campanas");

if (btnToggle) {
  btnToggle.onclick = () => {
    SHOW_ALL_CAMPAIGNS = !SHOW_ALL_CAMPAIGNS;

    btnToggle.textContent = SHOW_ALL_CAMPAIGNS
      ? "Ocultar campañas completadas"
      : "Ver todas las campañas";

    renderCampaignCardsByContact(row.contactId);
  };
}
  const btnActualizar = document.getElementById("btn-actualizar-contacto");
  if (btnActualizar) {
    btnActualizar.onclick = () => {
      saveContactFromDetalle();
    };
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
  } catch (e) {
    console.error("Error consultando contacto:", e);
    wrap.innerHTML = `<div class="text-sm text-red-500">No se pudieron cargar las campañas activas.</div>`;
    return;
  }

  if (!contact) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">No se encontró el contacto.</div>`;
    return;
  }

  if (STATE.asesorId && String(contact.ASSIGNED_BY_ID || "") !== STATE.asesorId) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">Este contacto no está asignado a tu usuario.</div>`;
    return;
  }

  const campanasTodas = campanaIdsToTexts(contact.UF_CRM_1768059328177);

const statusMap = loadCardStatusMap();

const campanas = campanasTodas.filter((campanaTxt) => {
  const key = getCardStatusKey(contactId, campanaTxt);
  const estado = statusMap[key];

  // si NO estamos mostrando todas → ocultar completadas
  if (!SHOW_ALL_CAMPAIGNS && estado === "Completado") {
    return false;
  }

  return true;
});

  if (!campanas.length) {
    wrap.innerHTML = `<div class="text-sm text-slate-500">Este contacto no tiene campañas activas.</div>`;
    return;
  }

  wrap.innerHTML = "";

  for (const campanaTxt of campanas) {
    let producto = null;

    try {
      producto = await fetchProductoCampanaByNombre(campanaTxt);
    } catch (e) {
      console.error("Error consultando producto de campaña:", campanaTxt, e);
    }

    const fechaInicioRaw = getBitrixPropValue(producto?.PROPERTY_360);
    const fechaFinRaw = getBitrixPropValue(producto?.PROPERTY_356);
    const estadoRaw = getBitrixPropValue(producto?.PROPERTY_358);

    const fechaInicio = formatFechaBitrix(fechaInicioRaw);
    const fechaFin = formatFechaBitrix(fechaFinRaw);
   const estadoCampana = estadoRaw || "Sin estado";
    const statusMap = loadCardStatusMap();
    const cardKey = getCardStatusKey(contactId, campanaTxt);
    const estadoSeguimiento = statusMap[cardKey] || "Por completar";

    const card = document.createElement("div");
    card.className = "bg-white border border-slate-200 shadow-sm rounded-2xl p-6";

    card.innerHTML = `
      <div class="flex items-start justify-between">
        <div class="text-xl font-semibold text-slate-900">
          ${campanaTxt}
        </div>

        <div class="text-sm font-semibold text-green-600">
          ${estadoCampana}
        </div>
      </div>

      <div class="mt-6 flex items-center justify-between">
      <div class="text-sm font-medium ${
  estadoSeguimiento === "Completado"
    ? "text-green-600"
    : estadoSeguimiento === "Seguimiento"
    ? "text-blue-600"
    : "text-orange-500"
}">
  ${estadoSeguimiento}
</div>

        <button 
          class="btn-detalle px-4 py-2 rounded-full border border-blue-500 text-blue-500 text-sm font-medium hover:bg-blue-50 transition"
        >
          Detalle
        </button>
      </div>
    `;

    const btn = card.querySelector(".btn-detalle");
    if (btn) {
      btn.onclick = () => {
        openCampanaModal({
          nombre: campanaTxt,
          producto,
        });
      };
    }

    wrap.appendChild(card);
  }
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
  const target = String(value || "").trim().toLowerCase();
  return list.find(
    (item) => String(item.VALUE || "").trim().toLowerCase() === target
  ) || null;
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
      }
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
      }
    );
  });
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
      }
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
      }
    );
  });
}

async function ensureDealEnumOption(fieldCode, valueText) {
  const userField = await getDealUserfieldByName(fieldCode);

  if (!userField?.ID) {
    throw new Error(`No se encontró el campo deal ${fieldCode}.`);
  }

  let option = findEnumOptionByValue(userField.LIST || [], valueText);

  if (!option) {
    await updateDealUserfieldList(userField.ID, userField.LIST || [], valueText);

    const refreshedField = await getDealUserfieldByName(fieldCode);
    option = findEnumOptionByValue(refreshedField?.LIST || [], valueText);
  }

  if (!option?.ID) {
    throw new Error(`No se pudo obtener el ID de la opción en ${fieldCode}.`);
  }

  return option.ID;
}

function createDeal(fields) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(
      "crm.deal.add",
      { fields },
      (result) => {
        if (result.error()) {
          reject(result.error());
          return;
        }

        resolve(result.data());
      }
    );
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

  const campanaOptionId = await ensureDealEnumOption(dealCampanaField, campana);

  const title = `${String(nombreCliente || "").trim()} - ${String(campana || "").trim()}`.trim();

  const fields = {
    TITLE: title,
    CATEGORY_ID: 10,
    STAGE_ID: "C10:NEW",
    CONTACT_ID: String(contactId),
    ASSIGNED_BY_ID: asesorId ? Number(asesorId) : undefined,
    [dealEstadoField]: estadoCliente,
    [dealNotasField]: notas,
    [dealCampanaField]: campanaOptionId,
  };

  // limpia undefined por si no viene asesor
  Object.keys(fields).forEach((key) => {
    if (fields[key] === undefined) delete fields[key];
  });

  return await createDeal(fields);
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
      }
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

  const resumen = notas
    ? `${campana} - ${estadoCliente} - ${notas} - ${fechaActual}`
    : `${campana} - ${estadoCliente} - ${fechaActual}`;
    
  try {
    
     setModalGuardarState("loading");
     showModalLoader();
    const fieldCode = "UF_CRM_1776206743575";

    const userField = await getContactUserfieldByName(fieldCode);

    if (!userField?.ID) {
  showToast(`No se encontró el campo ${fieldCode}.`, "error");
  setModalGuardarState("idle");
  hideModalLoader();
  return;
}

    let option = findEnumOptionByValue(userField.LIST || [], resumen);

    if (!option) {
      await updateContactUserfieldList(userField.ID, userField.LIST || [], resumen);

      const refreshedField = await getContactUserfieldByName(fieldCode);
      option = findEnumOptionByValue(refreshedField?.LIST || [], resumen);
    }

  if (!option?.ID) {
  showToast("No se pudo obtener el ID de la opción creada.", "error");
  setModalGuardarState("idle");
  hideModalLoader();
  return;
}

    await updateContactEnumValue(contactId, fieldCode, option.ID);

if (estadoRaw === "interesado") {
  const nombreCliente = (CURRENT_CTX?.row?.nombre || "").trim();

  await createInteresadoDeal({
    contactId,
    campana,
    estadoCliente,
    notas,
    asesorId: STATE.asesorId || CURRENT_CTX?.row?.asesor || "",
    nombreCliente,
  });
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
showToast("Guardado correctamente.");

setTimeout(() => {
  closeCampanaModal();
  setModalGuardarState("idle");
}, 500);

}  catch (e) {
  console.error("Error guardando opción dinámica:", e);
  setModalGuardarState("idle");
  hideModalLoader();
  showToast("No se pudo guardar la opción dinámica en la lista.", "error");
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
  const placeTxt = MUNICIPIO_ENUM[municipioId] || "";

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
    const contact = await fetchContactById(row.contactId);

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
      UF_CRM_1722975246: municipioId || null,
    };

    if (email) fields.EMAIL = emailPayload;
    if (phone) fields.PHONE = phonePayload;

    BX24.callMethod("crm.contact.update", { id: row.contactId, fields }, function (result) {
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

  qs("#dtl-nombre").textContent = row.nombre || "Contacto";
  renderTabla();

  setActualizarButtonState("success");
  hideDetalleLoader();
  showToast("Datos actualizados correctamente.");

  setTimeout(() => setActualizarButtonState("idle"), 1800);
});
  } catch (e) {
    setActualizarButtonState("idle");
    hideDetalleLoader();
    showToast("No se pudo preparar la actualización del contacto.", "error");
  }
}