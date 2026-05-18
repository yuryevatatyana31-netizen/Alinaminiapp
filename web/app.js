const roleBadge = document.querySelector("#roleBadge");
const clientRoot = document.querySelector("#clientRoot");
const masterRoot = document.querySelector("#masterRoot");
const toastEl = document.querySelector("#toast");

const WEEK_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS_RU = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь"
];

const state = {
  role: "client",
  actor: {
    telegramId: "",
    username: "",
    firstName: "",
    lastName: "",
    phone: ""
  },
  meta: null,
  client: {
    duration: "60",
    month: "",
    availableDays: [],
    hasAnyDay: true,
    selectedDateIso: "",
    slots: [],
    selectedSlot: null,
    name: "",
    phone: "",
    formError: "",
    noSlotsMessage: "",
    noSlotsSending: false
  },
  history: []
  ,
  master: {
    month: "",
    availableDays: [],
    selectedDateIso: "",
    dayConfig: null,
    dayBookings: [],
    scheduleExpanded: false,
    requestsExpanded: false,
    freeSlotsExpanded: false,
    freeSlots: [],
    requestsFilter: "all",
    requests: [],
    excludesDraft: [],
    replyDraftByBookingId: {},
    rescheduleDraftByBookingId: {}
  }
};

function showToast(message, timeout = 2800) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  window.setTimeout(() => toastEl.classList.add("hidden"), timeout);
}

function ensureString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePhone(value) {
  const digits = ensureString(value).replace(/\D/g, "");
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return `+7${digits.slice(1)}`;
  }
  return "";
}

function isValidPhone(phone) {
  return normalizePhone(phone).length === 12;
}

function getNowMonthIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isoDateToRu(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

function parseMonth(monthIso) {
  const [y, m] = monthIso.split("-").map(Number);
  return { y, m };
}

function addMonths(monthIso, delta) {
  const { y, m } = parseMonth(monthIso);
  const date = new Date(y, m - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(monthIso) {
  const { y, m } = parseMonth(monthIso);
  return `${MONTHS_RU[m - 1]} ${y}`;
}

function formatRole(role) {
  if (role === "master" || role === "admin") return "Мастер / Администратор";
  return "Клиент";
}

function panel(title, bodyHtml, expanded = false, id = "") {
  const el = document.createElement("article");
  el.className = "panel";
  const bodyClass = expanded ? "panel-body" : "panel-body hidden";
  el.innerHTML = `
    <button class="panel-head" type="button" ${id ? `data-panel-id="${id}"` : ""}>
      <span>${title}</span>
      <span>${expanded ? "▲" : "▼"}</span>
    </button>
    <div class="${bodyClass}">${bodyHtml}</div>
  `;
  const head = el.querySelector(".panel-head");
  const arrow = head.querySelector("span:last-child");
  const body = el.querySelector(".panel-body");
  head.addEventListener("click", () => {
    body.classList.toggle("hidden");
    arrow.textContent = body.classList.contains("hidden") ? "▼" : "▲";
    if (id === "new-booking") {
      state.client.newBookingExpanded = !body.classList.contains("hidden");
    }
    if (id === "history") {
      state.client.historyExpanded = !body.classList.contains("hidden");
    }
    if (id === "master-schedule") {
      state.master.scheduleExpanded = !body.classList.contains("hidden");
    }
    if (id === "master-requests") {
      state.master.requestsExpanded = !body.classList.contains("hidden");
    }
  });
  return el;
}

async function api(path, options = {}) {
  const miniAppBase = window.location.pathname.startsWith("/miniapp") ? "/miniapp" : "";
  const resolvedPath = path.startsWith("/api/") ? `${miniAppBase}${path}` : path;
  const headers = {
    "Content-Type": "application/json",
    "x-telegram-id": state.actor.telegramId || "",
    "x-telegram-username": state.actor.username || "",
    ...(options.headers || {})
  };
  const response = await fetch(resolvedPath, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw data;
  return data;
}

function getTelegramUser() {
  const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (!user) return null;
  return {
    telegramId: String(user.id || ""),
    username: ensureString(user.username),
    firstName: ensureString(user.first_name),
    lastName: ensureString(user.last_name)
  };
}

function getFallbackUserFromQuery() {
  const url = new URL(window.location.href);
  return {
    telegramId: ensureString(url.searchParams.get("telegramId") || ""),
    username: ensureString(url.searchParams.get("username") || ""),
    firstName: ensureString(url.searchParams.get("firstName") || ""),
    lastName: ensureString(url.searchParams.get("lastName") || "")
  };
}

function initTelegramWebAppShell() {
  try {
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }
  } catch {
    // Ignore shell init errors and continue in browser mode.
  }
}

function getOrCreateWebDebugId() {
  const key = "electro_web_debug_id";
  let value = localStorage.getItem(key) || "";
  if (!value) {
    value = `web_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    localStorage.setItem(key, value);
  }
  return value;
}

function buildDefaultClientName(actor) {
  const fullName = `${actor.firstName || ""} ${actor.lastName || ""}`.trim();
  if (fullName) return fullName;
  if (actor.username) return `@${actor.username.replace(/^@/, "")}`;
  return "";
}

function getDurationSafe() {
  const parsed = Number(state.client.duration);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.min(Math.max(Math.round(parsed), 5), 600);
}

function createCalendarGrid(monthIso) {
  const { y, m } = parseMonth(monthIso);
  const first = new Date(y, m - 1, 1);
  const firstWeekDay = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m, 0).getDate();
  const prevMonthDays = new Date(y, m - 1, 0).getDate();
  const cells = [];

  for (let i = 0; i < firstWeekDay; i += 1) {
    cells.push({
      day: prevMonthDays - firstWeekDay + i + 1,
      inCurrentMonth: false
    });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ day, inCurrentMonth: true });
  }

  while (cells.length < 42) {
    cells.push({ day: cells.length - (firstWeekDay + daysInMonth) + 1, inCurrentMonth: false });
  }

  return cells;
}

function toIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function scrollToElement(selector) {
  const target = document.querySelector(selector);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function loadAvailableDays() {
  const duration = getDurationSafe();
  const month = state.client.month;
  const data = await api(`/api/client/available-days?month=${month}&duration=${duration}`);
  state.client.availableDays = data.availableDays || [];
  state.client.hasAnyDay = Boolean(data.hasAny);
}

async function loadSlotsForSelectedDate() {
  if (!state.client.selectedDateIso) {
    state.client.slots = [];
    return;
  }
  const duration = getDurationSafe();
  const data = await api(
    `/api/client/day-slots?date=${state.client.selectedDateIso}&duration=${duration}`
  );
  state.client.slots = data.slots || [];
}

function renderClientCalendar() {
  const calendarRoot = document.querySelector("#calendarRoot");
  if (!calendarRoot) return;
  const cells = createCalendarGrid(state.client.month);
  const selectedDay = state.client.selectedDateIso
    ? Number(state.client.selectedDateIso.slice(-2))
    : null;

  calendarRoot.innerHTML = `
    <div class="calendar-head">
      <strong>${monthTitle(state.client.month)}</strong>
      <div class="btn-row">
        <button class="chip" type="button" data-cal-nav="-1">◀</button>
        <button class="chip" type="button" data-cal-nav="1">▶</button>
      </div>
    </div>
    <div class="calendar-weekdays">
      ${WEEK_DAYS.map((day) => `<span>${day}</span>`).join("")}
    </div>
    <div class="calendar-grid">
      ${cells
        .map((cell) => {
          const inCurrent = cell.inCurrentMonth;
          const isAvailable = inCurrent && state.client.availableDays.includes(cell.day);
          const isSelected = inCurrent && selectedDay === cell.day;
          const classes = [
            "day",
            inCurrent ? "current-month" : "",
            isAvailable ? "available" : "",
            isSelected ? "selected" : ""
          ]
            .filter(Boolean)
            .join(" ");
          return `<button class="${classes}" type="button" data-day="${cell.day}" data-current="${inCurrent}">${cell.day}</button>`;
        })
        .join("")}
    </div>
  `;

  calendarRoot.querySelectorAll("[data-cal-nav]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const delta = Number(btn.getAttribute("data-cal-nav"));
      state.client.month = addMonths(state.client.month, delta);
      state.client.selectedDateIso = "";
      state.client.selectedSlot = null;
      state.client.slots = [];
      await loadAvailableDays();
      renderClient();
    });
  });

  calendarRoot.querySelectorAll("[data-day]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const isCurrent = btn.getAttribute("data-current") === "true";
      const day = Number(btn.getAttribute("data-day"));
      const isAvailable = state.client.availableDays.includes(day);
      if (!isCurrent || !isAvailable) return;
      const { y, m } = parseMonth(state.client.month);
      state.client.selectedDateIso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      state.client.selectedSlot = null;
      await loadSlotsForSelectedDate();
      renderClient();
      scrollToElement("#timeSlotsBlock");
    });
  });
}

async function submitNoSlotsMessage() {
  const name = ensureString(state.client.name);
  const phone = ensureString(state.client.phone);
  if (!name || !isValidPhone(phone)) {
    state.client.formError = "Введите имя и номер телефона и нажмите \"Отправить заявку\".";
    renderClient();
    scrollToElement("#identityBlock");
    return;
  }
  state.client.noSlotsSending = true;
  renderClient();
  try {
    await api("/api/client/send-master-message", {
      method: "POST",
      body: JSON.stringify({
        user: state.actor,
        type: "no_slots",
        name,
        phone,
        duration: getDurationSafe(),
        message: state.client.noSlotsMessage
      })
    });
    showToast("Сообщение отправлено мастеру");
  } catch (error) {
    showToast(error?.message || "Ошибка отправки");
  } finally {
    state.client.noSlotsSending = false;
    renderClient();
  }
}

async function submitBooking() {
  const name = ensureString(state.client.name);
  const phone = ensureString(state.client.phone);
  if (!name || !isValidPhone(phone)) {
    state.client.formError = "Введите имя и номер телефона и нажмите \"Отправить заявку\".";
    renderClient();
    scrollToElement("#identityBlock");
    return;
  }
  if (!state.client.selectedDateIso || !state.client.selectedSlot) {
    showToast("Выберите дату и время");
    return;
  }

  try {
    const result = await api("/api/client/create-booking", {
      method: "POST",
      body: JSON.stringify({
        user: state.actor,
        name,
        phone,
        date: state.client.selectedDateIso,
        start: state.client.selectedSlot.start,
        duration: getDurationSafe()
      })
    });
    localStorage.setItem("electro_client_phone", normalizePhone(phone));
    state.client.formError = "";
    state.client.selectedSlot = null;
    state.client.selectedDateIso = "";
    state.client.slots = [];
    await loadAvailableDays();
    await loadHistory();
    renderClient();
    showToast("Ваша заявка на рассмотрении у мастера.");
    return result;
  } catch (error) {
    if (error?.error === "SLOT_ALREADY_REQUESTED") {
      showToast("На это время уже отправлена заявка.");
      await loadSlotsForSelectedDate();
      renderClient();
      return;
    }
    if (error?.error === "NAME_PHONE_REQUIRED") {
      state.client.formError = error?.message || "Введите имя и телефон";
      renderClient();
      scrollToElement("#identityBlock");
      return;
    }
    showToast(error?.message || "Ошибка отправки заявки");
  }
}

async function loadHistory() {
  const phone = normalizePhone(state.client.phone || localStorage.getItem("electro_client_phone") || "");
  if (!state.actor.telegramId && !phone) {
    state.history = [];
    return;
  }
  const data = await api(
    `/api/client/history?telegramId=${encodeURIComponent(state.actor.telegramId || "")}&phone=${encodeURIComponent(phone)}`
  );
  state.history = data.items || [];
}

async function handleHistoryCancel(bookingId) {
  const booking = state.history.find((item) => item.id === bookingId);
  if (!booking) return;
  const name = ensureString(state.client.name);
  const phone = ensureString(state.client.phone);
  if (!name || !isValidPhone(phone)) {
    state.client.formError = "Введите имя и номер телефона и нажмите \"Отправить заявку\".";
    state.client.newBookingExpanded = true;
    renderClient();
    scrollToElement("#identityBlock");
    return;
  }
  const cancelMessage = ensureString(state.client.cancelMessage || "Алина, я не смогу прийти в это время.");
  try {
    await api("/api/client/cancel-booking", {
      method: "POST",
      body: JSON.stringify({
        user: state.actor,
        bookingId,
        phone
      })
    });
    await api("/api/client/send-master-message", {
      method: "POST",
      body: JSON.stringify({
        user: state.actor,
        type: "cancel_booking",
        name,
        phone,
        duration: booking.durationMinutes || getDurationSafe(),
        message: `${cancelMessage}\nЗапись: ${booking.line}`
      })
    });
    state.client.pendingCancelBookingId = "";
    state.client.cancelMessage = "";
    await loadAvailableDays();
    await loadHistory();
    renderClient();
    showToast("Запись отменена");
  } catch (error) {
    showToast(error?.message || "Не удалось отменить запись");
  }
}

function startRebooking(booking) {
  state.client.duration = String(booking.durationMinutes || 60);
  state.client.selectedDateIso = "";
  state.client.selectedSlot = null;
  state.client.slots = [];
  state.client.newBookingExpanded = true;
  state.client.historyExpanded = false;
  state.client.pendingCancelBookingId = "";
  state.client.cancelMessage = "";
  loadAvailableDays()
    .then(() => {
      renderClient();
      scrollToElement("[data-panel-id='new-booking']");
    })
    .catch(() => {
      showToast("Ошибка загрузки слотов");
    });
}

function renderHistoryList() {
  if (!state.history.length) {
    return `<p class="helper">История пока пуста.</p>`;
  }
  return state.history
    .map(
      (item) => `
        <div class="history-item">
          <div class="line-compact">${item.line}</div>
          <div class="status">${item.status}</div>
          <div class="btn-row">
            <button type="button" class="btn ghost" data-history-action="cancel-open" data-booking-id="${item.id}">Отменить</button>
            <button type="button" class="btn secondary" data-history-action="rebook" data-booking-id="${item.id}">Перезаписаться</button>
          </div>
          ${
            state.client.pendingCancelBookingId === item.id
              ? `
                <div class="field">
                  <label>Сообщение мастеру</label>
                  <textarea data-cancel-message>${state.client.cancelMessage || "Алина, я не смогу прийти в это время."}</textarea>
                </div>
                <button type="button" class="btn" data-history-action="cancel-send" data-booking-id="${item.id}">Отправить мастеру</button>
              `
              : ""
          }
        </div>
      `
    )
    .join("");
}

function renderClient() {
  const helperText = state.client.hasAnyDay
    ? "Выберите день."
    : "К сожалению, в этом месяце нет свободных окошек. Вы можете написать мастеру.";
  const noSlotsDefaultText = `Алина, я не смогла записаться. Подберите мне, пожалуйста, ${getDurationSafe()} минут.`;
  if (!state.client.noSlotsMessage) {
    state.client.noSlotsMessage = noSlotsDefaultText;
  }
  const slotsHtml = state.client.selectedDateIso
    ? `
      <div id="timeSlotsBlock" class="field">
        <label>Свободное время на ${isoDateToRu(state.client.selectedDateIso)}</label>
        <div class="chips">
          ${
            state.client.slots.length
              ? state.client.slots
                  .map((slot) => {
                    const selected =
                      state.client.selectedSlot && state.client.selectedSlot.start === slot.start;
                    return `<button type="button" class="chip ${selected ? "selected" : ""}" data-slot="${slot.start}">${slot.start}-${slot.end}</button>`;
                  })
                  .join("")
              : `<span class="helper">Нет свободных слотов для выбранной длительности.</span>`
          }
        </div>
      </div>
    `
    : "";

  const panelNew = panel(
    "Новая запись",
    `
      <div class="field">
        <label>Длительность (минуты)</label>
        <input id="durationInput" type="text" inputmode="numeric" value="${state.client.duration}" />
      </div>
      <div class="calendar" id="calendarRoot"></div>
      <p class="helper ${state.client.hasAnyDay ? "" : "error"}">${helperText}</p>
      ${
        !state.client.hasAnyDay
          ? `
          <div class="field">
            <label>Сообщение мастеру</label>
            <textarea id="noSlotsMessage">${state.client.noSlotsMessage}</textarea>
          </div>
          <button id="sendNoSlotsBtn" class="btn secondary" type="button" ${state.client.noSlotsSending ? "disabled" : ""}>Отправить мастеру</button>
        `
          : ""
      }
      ${slotsHtml}
      <div id="identityBlock" class="field">
        <label>Имя</label>
        <input id="clientNameInput" type="text" value="${state.client.name}" />
      </div>
      <div class="field">
        <label>Телефон (+7... или 8...)</label>
        <input id="clientPhoneInput" type="tel" value="${state.client.phone}" />
      </div>
      ${
        state.client.formError
          ? `<p class="helper error" id="identityError">${state.client.formError}</p>`
          : ""
      }
      <button id="sendBookingBtn" class="btn" type="button">Отправить заявку</button>
    `,
    state.client.newBookingExpanded,
    "new-booking"
  );

  const panelHistory = panel("История", renderHistoryList(), state.client.historyExpanded, "history");
  clientRoot.innerHTML = "";
  clientRoot.append(panelNew, panelHistory);

  renderClientCalendar();

  const durationInput = document.querySelector("#durationInput");
  durationInput?.addEventListener("change", async () => {
    state.client.duration = ensureString(durationInput.value) || "60";
    state.client.selectedDateIso = "";
    state.client.selectedSlot = null;
    state.client.slots = [];
    state.client.noSlotsMessage = "";
    await loadAvailableDays();
    renderClient();
  });

  document.querySelector("#sendBookingBtn")?.addEventListener("click", submitBooking);

  document.querySelector("#sendNoSlotsBtn")?.addEventListener("click", async () => {
    const msg = document.querySelector("#noSlotsMessage");
    state.client.noSlotsMessage = ensureString(msg?.value || "");
    await submitNoSlotsMessage();
  });

  const nameInput = document.querySelector("#clientNameInput");
  const phoneInput = document.querySelector("#clientPhoneInput");
  nameInput?.addEventListener("input", () => {
    state.client.name = nameInput.value;
    state.client.formError = "";
  });
  phoneInput?.addEventListener("input", () => {
    state.client.phone = phoneInput.value;
    state.client.formError = "";
  });

  document.querySelectorAll("[data-slot]").forEach((slotBtn) => {
    slotBtn.addEventListener("click", () => {
      const start = slotBtn.getAttribute("data-slot");
      state.client.selectedSlot = state.client.slots.find((item) => item.start === start) || null;
      renderClient();
      scrollToElement("#identityBlock");
    });
  });

  document.querySelectorAll("[data-history-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-history-action");
      const bookingId = btn.getAttribute("data-booking-id");
      const booking = state.history.find((item) => item.id === bookingId);
      if (!booking) return;

      if (action === "rebook") {
        startRebooking(booking);
        return;
      }

      if (action === "cancel-open") {
        state.client.historyExpanded = true;
        state.client.pendingCancelBookingId = bookingId;
        state.client.cancelMessage = "Алина, я не смогу прийти в это время.";
        renderClient();
        scrollToElement("[data-cancel-message]");
        return;
      }

      if (action === "cancel-send") {
        const messageTextarea = document.querySelector("[data-cancel-message]");
        state.client.cancelMessage = ensureString(messageTextarea?.value || state.client.cancelMessage);
        await handleHistoryCancel(bookingId);
      }
    });
  });
}

function renderMasterSkeleton() {
  if (!state.master.month) state.master.month = getNowMonthIso();
}

async function loadMasterAvailableDays() {
  const duration = getDurationSafe();
  const data = await api(
    `/api/master/free-days?month=${state.master.month}&duration=${duration}&telegramId=${encodeURIComponent(
      state.actor.telegramId
    )}&username=${encodeURIComponent(state.actor.username)}`
  );
  state.master.availableDays = data.availableDays || [];
}

async function loadMasterDay(dateIso) {
  if (!dateIso) return;
  const q = `date=${dateIso}&telegramId=${encodeURIComponent(state.actor.telegramId)}&username=${encodeURIComponent(
    state.actor.username
  )}`;
  const [configData, bookingsData, freeSlotsData] = await Promise.all([
    api(`/api/master/day-config?${q}`),
    api(`/api/master/day-bookings?${q}`),
    api(`/api/master/free-slots?${q}&duration=${getDurationSafe()}`)
  ]);
  state.master.dayConfig = configData.config;
  state.master.excludesDraft = (configData.config?.excludes || []).map((item) => ({
    start: item.start,
    end: item.end
  }));
  state.master.dayBookings = bookingsData.items || [];
  state.master.freeSlots = freeSlotsData.slots || [];
}

async function loadMasterRequests() {
  const status = encodeURIComponent(state.master.requestsFilter);
  const data = await api(
    `/api/master/bookings?status=${status}&telegramId=${encodeURIComponent(
      state.actor.telegramId
    )}&username=${encodeURIComponent(state.actor.username)}`
  );
  state.master.requests = data.items || [];
}

function renderMasterCalendar() {
  const root = document.querySelector("#masterCalendarRoot");
  if (!root) return;
  const cells = createCalendarGrid(state.master.month);
  const selectedDay = state.master.selectedDateIso
    ? Number(state.master.selectedDateIso.slice(-2))
    : null;

  root.innerHTML = `
    <div class="calendar-head">
      <strong>${monthTitle(state.master.month)}</strong>
      <div class="btn-row">
        <button class="chip" type="button" data-master-cal-nav="-1">◀</button>
        <button class="chip" type="button" data-master-cal-nav="1">▶</button>
      </div>
    </div>
    <div class="calendar-weekdays">${WEEK_DAYS.map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="calendar-grid">
      ${cells
        .map((cell) => {
          const inCurrent = cell.inCurrentMonth;
          const available = inCurrent && state.master.availableDays.includes(cell.day);
          const selected = inCurrent && cell.day === selectedDay;
          const classes = [
            "day",
            inCurrent ? "current-month" : "",
            available ? "available" : "",
            selected ? "selected" : ""
          ]
            .filter(Boolean)
            .join(" ");
          return `<button class="${classes}" type="button" data-master-day="${cell.day}" data-current="${inCurrent}">${cell.day}</button>`;
        })
        .join("")}
    </div>
  `;

  root.querySelectorAll("[data-master-cal-nav]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const delta = Number(btn.getAttribute("data-master-cal-nav"));
      state.master.month = addMonths(state.master.month, delta);
      state.master.selectedDateIso = "";
      state.master.dayConfig = null;
      state.master.dayBookings = [];
      state.master.freeSlots = [];
      await loadMasterAvailableDays();
      renderMaster();
    });
  });

  root.querySelectorAll("[data-master-day]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const inCurrent = btn.getAttribute("data-current") === "true";
      if (!inCurrent) return;
      const day = Number(btn.getAttribute("data-master-day"));
      const { y, m } = parseMonth(state.master.month);
      state.master.selectedDateIso = toIsoDate(y, m, day);
      await loadMasterDay(state.master.selectedDateIso);
      renderMaster();
      scrollToElement("#masterDayConfig");
    });
  });
}

function renderMasterMonthTools() {
  return `
    <div class="field">
      <label>Месяц: ${monthTitle(state.master.month)}</label>
      <button id="fillMasterMonthBtn" type="button" class="btn">Заполнить весь месяц 08:00-20:00</button>
    </div>
  `;
}

function renderMasterDayConfig() {
  if (!state.master.selectedDateIso || !state.master.dayConfig) {
    return `<p class="helper">Выберите день в календаре, чтобы настроить график и посмотреть записи.</p>`;
  }
  const cfg = state.master.dayConfig;
  return `
    <div id="masterDayConfig" class="field">
      <label>Дата</label>
      <input type="text" value="${isoDateToRu(state.master.selectedDateIso)}" readonly />
    </div>
    <div class="field">
      <label><input id="dayOffCheckbox" type="checkbox" ${cfg.isDayOff ? "checked" : ""} /> Выходной</label>
    </div>
    <div class="btn-row">
      <div class="field">
        <label>Начало</label>
        <input id="workStartInput" type="time" value="${cfg.workStart || "08:00"}" />
      </div>
      <div class="field">
        <label>Конец</label>
        <input id="workEndInput" type="time" value="${cfg.workEnd || "20:00"}" />
      </div>
    </div>
    <div class="field">
      <label>Исключенные периоды</label>
      <div id="excludeList">
        ${
          state.master.excludesDraft.length
            ? state.master.excludesDraft
                .map(
                  (item, idx) => `
              <div class="btn-row" data-exclude-row="${idx}">
                <input type="time" data-exclude-start="${idx}" value="${item.start}" />
                <input type="time" data-exclude-end="${idx}" value="${item.end}" />
                <button type="button" class="chip" data-exclude-remove="${idx}">✕</button>
              </div>
            `
                )
                .join("")
            : `<p class="helper">Периодов пока нет.</p>`
        }
      </div>
      <button id="addExcludeBtn" type="button" class="btn ghost">Добавить период</button>
    </div>
    <button id="saveDayConfigBtn" type="button" class="btn">Сохранить график дня</button>
  `;
}

function renderDayBookings() {
  if (!state.master.selectedDateIso) return "";
  if (!state.master.dayBookings.length) {
    return `
      <div class="field">
        <label>Записи дня</label>
        <p class="helper">Записей на выбранный день нет.</p>
      </div>
    `;
  }
  return `
    <div class="field">
      <label>Записи дня</label>
      <div class="chips">
        ${state.master.dayBookings
          .map(
            (item) =>
              `<div class="chip">${item.timeRange} · ${item.durationMinutes} мин · ${item.clientName} · ${item.clientPhone}</div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderMasterFreeSlots() {
  const visible = state.master.freeSlotsExpanded;
  return `
    <article class="panel">
      <button id="toggleMasterFreeSlots" class="panel-head" type="button">
        <span>Свободное время</span>
        <span>${visible ? "▲" : "▼"}</span>
      </button>
      <div class="panel-body ${visible ? "" : "hidden"}">
        ${
          state.master.selectedDateIso
            ? state.master.freeSlots.length
              ? `<div class="chips">${state.master.freeSlots.map((slot) => `<span class="chip">${slot}</span>`).join("")}</div>`
              : "<p class='helper'>Нет свободных периодов на выбранную дату.</p>"
            : "<p class='helper'>Выберите день, чтобы увидеть свободные периоды.</p>"
        }
      </div>
    </article>
  `;
}

async function fillMasterMonth() {
  try {
    await api("/api/master/month-config", {
      method: "POST",
      body: JSON.stringify({
        user: state.actor,
        month: state.master.month,
        workStart: "08:00",
        workEnd: "20:00"
      })
    });
    await loadMasterAvailableDays();
    if (state.master.selectedDateIso?.startsWith(state.master.month)) {
      await loadMasterDay(state.master.selectedDateIso);
    }
    renderMaster();
    showToast("Месяц заполнен");
  } catch {
    showToast("Ошибка заполнения месяца");
  }
}

async function saveMasterDayConfig() {
  if (!state.master.selectedDateIso) return;
  const workStart = ensureString(document.querySelector("#workStartInput")?.value || "08:00");
  const workEnd = ensureString(document.querySelector("#workEndInput")?.value || "20:00");
  const isDayOff = Boolean(document.querySelector("#dayOffCheckbox")?.checked);
  const excludes = [];
  document.querySelectorAll("[data-exclude-row]").forEach((row) => {
    const idx = row.getAttribute("data-exclude-row");
    const start = ensureString(document.querySelector(`[data-exclude-start='${idx}']`)?.value || "");
    const end = ensureString(document.querySelector(`[data-exclude-end='${idx}']`)?.value || "");
    if (start && end) excludes.push({ start, end });
  });
  try {
    await api("/api/master/day-config", {
      method: "POST",
      body: JSON.stringify({
        user: state.actor,
        date: state.master.selectedDateIso,
        workStart,
        workEnd,
        isDayOff,
        excludes
      })
    });
    await loadMasterAvailableDays();
    await loadMasterDay(state.master.selectedDateIso);
    renderMaster();
    showToast("График дня сохранен");
  } catch {
    showToast("Ошибка сохранения графика");
  }
}

async function handleMasterRequestAction(action, bookingId) {
  const booking = state.master.requests.find((item) => item.id === bookingId);
  if (!booking) return;
  try {
    if (action === "confirm") {
      await api("/api/master/update-booking-status", {
        method: "POST",
        body: JSON.stringify({
          user: state.actor,
          bookingId,
          status: "подтверждена"
        })
      });
      showToast("Заявка подтверждена");
    } else if (action === "reject") {
      await api("/api/master/update-booking-status", {
        method: "POST",
        body: JSON.stringify({
          user: state.actor,
          bookingId,
          status: "отклонена"
        })
      });
      showToast("Заявка отклонена");
    } else if (action === "cancel") {
      await api("/api/master/update-booking-status", {
        method: "POST",
        body: JSON.stringify({
          user: state.actor,
          bookingId,
          status: "отменена"
        })
      });
      showToast("Запись отменена мастером");
    } else if (action === "reply-send") {
      const text = ensureString(
        document.querySelector(`[data-reply-input='${bookingId}']`)?.value ||
          state.master.replyDraftByBookingId[bookingId] ||
          ""
      );
      if (!text) {
        showToast("Введите текст ответа");
        return;
      }
      await api("/api/master/reply-client", {
        method: "POST",
        body: JSON.stringify({
          user: state.actor,
          bookingId,
          text
        })
      });
      state.master.replyDraftByBookingId[bookingId] = "";
      showToast("Ответ отправлен клиенту");
    } else if (action === "reschedule-send") {
      const draft = state.master.rescheduleDraftByBookingId[bookingId] || {};
      const newDate = ensureString(
        document.querySelector(`[data-reschedule-date='${bookingId}']`)?.value || draft.newDate || ""
      );
      const newStart = ensureString(
        document.querySelector(`[data-reschedule-start='${bookingId}']`)?.value || draft.newStart || ""
      );
      const newDuration = Number(
        document.querySelector(`[data-reschedule-duration='${bookingId}']`)?.value || draft.newDuration || booking.durationMinutes
      );
      if (!newDate || !newStart) {
        showToast("Укажите дату и время для перезаписи");
        return;
      }
      await api("/api/master/reschedule-booking", {
        method: "POST",
        body: JSON.stringify({
          user: state.actor,
          bookingId,
          newDate,
          newStart,
          newDuration
        })
      });
      state.master.rescheduleDraftByBookingId[bookingId] = {};
      showToast("Запись перезаписана мастером");
    }
    await loadMasterRequests();
    if (state.master.selectedDateIso) {
      await loadMasterAvailableDays();
      await loadMasterDay(state.master.selectedDateIso);
    }
    renderMaster();
  } catch (error) {
    showToast(error?.message || "Операция не выполнена");
  }
}

function renderMasterRequests() {
  const filters = [
    { key: "all", label: "Все" },
    { key: "на согласовании", label: "На согласовании" },
    { key: "подтверждена", label: "Подтвержденные" },
    { key: "завершена", label: "Завершенные" },
    { key: "отменена", label: "Отмененные" },
    { key: "перезаписано мастером", label: "Перезаписано" }
  ];

  const filtersHtml = `
    <div class="chips">
      ${filters
        .map(
          (f) =>
            `<button type="button" class="chip ${state.master.requestsFilter === f.key ? "selected" : ""}" data-master-filter="${f.key}">${f.label}</button>`
        )
        .join("")}
    </div>
  `;

  const listHtml = state.master.requests.length
    ? state.master.requests
        .map((item) => {
          const replyOpen = Object.prototype.hasOwnProperty.call(state.master.replyDraftByBookingId, item.id);
          const rescheduleOpen = Object.prototype.hasOwnProperty.call(
            state.master.rescheduleDraftByBookingId,
            item.id
          );
          return `
          <div class="history-item">
            <div class="line-compact">${item.date} · ${item.timeRange} · ${item.durationMinutes} мин</div>
            <div class="status">${item.clientName} · ${item.clientPhone}</div>
            <div class="status">${item.status}</div>
            <div class="btn-row">
              <button type="button" class="btn ghost" data-master-action="confirm" data-booking-id="${item.id}">Подтвердить</button>
              <button type="button" class="btn ghost" data-master-action="reject" data-booking-id="${item.id}">Отклонить</button>
            </div>
            <div class="btn-row">
              <button type="button" class="btn ghost" data-master-action="cancel" data-booking-id="${item.id}">Отменить</button>
              <button type="button" class="btn secondary" data-master-action="reschedule-open" data-booking-id="${item.id}">Перезаписать</button>
              <button type="button" class="btn secondary" data-master-action="reply-open" data-booking-id="${item.id}">Ответить клиенту</button>
            </div>
            ${
              replyOpen
                ? `
                <div class="field">
                  <label>Ответ клиенту</label>
                  <textarea data-reply-input="${item.id}">${state.master.replyDraftByBookingId[item.id] || ""}</textarea>
                </div>
                <button type="button" class="btn" data-master-action="reply-send" data-booking-id="${item.id}">Отправить клиенту</button>
              `
                : ""
            }
            ${
              rescheduleOpen
                ? `
                <div class="field">
                  <label>Новая дата</label>
                  <input type="date" data-reschedule-date="${item.id}" value="${state.master.rescheduleDraftByBookingId[item.id]?.newDate || item.dateIso}" />
                </div>
                <div class="btn-row">
                  <div class="field">
                    <label>Новое время</label>
                    <input type="time" data-reschedule-start="${item.id}" value="${state.master.rescheduleDraftByBookingId[item.id]?.newStart || item.timeRange.split("-")[0]}" />
                  </div>
                  <div class="field">
                    <label>Минуты</label>
                    <input type="number" data-reschedule-duration="${item.id}" value="${state.master.rescheduleDraftByBookingId[item.id]?.newDuration || item.durationMinutes}" />
                  </div>
                </div>
                <button type="button" class="btn" data-master-action="reschedule-send" data-booking-id="${item.id}">Подтвердить перезапись</button>
              `
                : ""
            }
          </div>
        `;
        })
        .join("")
    : `<p class="helper">Заявок по выбранному фильтру нет.</p>`;

  return `${filtersHtml}<div class="field">${listHtml}</div>`;
}

function renderMaster() {
  const scheduleBody = `
    ${renderMasterMonthTools()}
    <div class="calendar" id="masterCalendarRoot"></div>
    ${renderMasterDayConfig()}
    ${renderDayBookings()}
    ${renderMasterFreeSlots()}
  `;
  const requestsBody = renderMasterRequests();
  const schedulePanel = panel("Рабочий график", scheduleBody, state.master.scheduleExpanded, "master-schedule");
  const requestsPanel = panel("Заявки", requestsBody, state.master.requestsExpanded, "master-requests");
  masterRoot.innerHTML = "";
  masterRoot.append(schedulePanel, requestsPanel);
  renderMasterCalendar();

  document.querySelector("#toggleMasterFreeSlots")?.addEventListener("click", () => {
    state.master.freeSlotsExpanded = !state.master.freeSlotsExpanded;
    renderMaster();
  });

  document.querySelector("#addExcludeBtn")?.addEventListener("click", () => {
    state.master.excludesDraft.push({ start: "13:00", end: "14:00" });
    renderMaster();
  });

  document.querySelectorAll("[data-exclude-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-exclude-remove"));
      state.master.excludesDraft.splice(idx, 1);
      renderMaster();
    });
  });

  document.querySelector("#saveDayConfigBtn")?.addEventListener("click", saveMasterDayConfig);
  document.querySelector("#fillMasterMonthBtn")?.addEventListener("click", fillMasterMonth);

  document.querySelectorAll("[data-master-filter]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.master.requestsFilter = btn.getAttribute("data-master-filter");
      await loadMasterRequests();
      renderMaster();
    });
  });

  document.querySelectorAll("[data-master-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-master-action");
      const bookingId = btn.getAttribute("data-booking-id");
      if (!bookingId) return;
      if (action === "reply-open") {
        state.master.replyDraftByBookingId[bookingId] = "";
        renderMaster();
        scrollToElement(`[data-reply-input='${bookingId}']`);
        return;
      }
      if (action === "reschedule-open") {
        const request = state.master.requests.find((item) => item.id === bookingId);
        state.master.rescheduleDraftByBookingId[bookingId] = {
          newDate: request?.dateIso || "",
          newStart: request?.timeRange?.split("-")[0] || "08:00",
          newDuration: request?.durationMinutes || 60
        };
        renderMaster();
        scrollToElement(`[data-reschedule-date='${bookingId}']`);
        return;
      }
      await handleMasterRequestAction(action, bookingId);
    });
  });
}

async function initMasterState() {
  renderMasterSkeleton();
  state.master.month = getNowMonthIso();
  state.master.selectedDateIso = "";
  state.master.dayConfig = null;
  state.master.dayBookings = [];
  state.master.scheduleExpanded = false;
  state.master.requestsExpanded = false;
  state.master.freeSlots = [];
  state.master.freeSlotsExpanded = false;
  state.master.requestsFilter = "all";
  state.master.requests = [];
  state.master.excludesDraft = [];
  state.master.replyDraftByBookingId = {};
  state.master.rescheduleDraftByBookingId = {};
  await loadMasterAvailableDays();
  await loadMasterRequests();
  renderMaster();
}

async function initClientState() {
  state.client.month = getNowMonthIso();
  state.client.duration = "60";
  state.client.selectedDateIso = "";
  state.client.selectedSlot = null;
  state.client.slots = [];
  state.client.formError = "";
  state.client.noSlotsMessage = "";
  state.client.name = buildDefaultClientName(state.actor);
  state.client.phone = localStorage.getItem("electro_client_phone") || "";
  state.client.newBookingExpanded = false;
  state.client.historyExpanded = false;
  state.client.pendingCancelBookingId = "";
  state.client.cancelMessage = "";
  await loadAvailableDays();
  await loadHistory();
}

async function bootstrap() {
  initTelegramWebAppShell();
  const tgUser = getTelegramUser();
  const fallbackUser = getFallbackUserFromQuery();
  const isTelegramContext = Boolean(tgUser?.telegramId);
  const debugId = !isTelegramContext ? getOrCreateWebDebugId() : "";
  state.actor = {
    telegramId: tgUser?.telegramId || fallbackUser.telegramId || debugId,
    username: tgUser?.username || fallbackUser.username || "",
    firstName: tgUser?.firstName || fallbackUser.firstName || "",
    lastName: tgUser?.lastName || fallbackUser.lastName || "",
    phone: ""
  };

  const roleParam = new URL(window.location.href).searchParams.get("role");
  const roleQuery = roleParam ? `&role=${encodeURIComponent(roleParam)}` : "";
  const bootstrapData = await api(
    `/api/bootstrap?telegramId=${encodeURIComponent(state.actor.telegramId)}&username=${encodeURIComponent(
      state.actor.username
    )}&firstName=${encodeURIComponent(state.actor.firstName)}&lastName=${encodeURIComponent(
      state.actor.lastName
    )}${roleQuery}`
  );
  state.role = bootstrapData.actor?.role || "client";
  state.meta = bootstrapData.meta || null;
  roleBadge.textContent = formatRole(state.role);

  if (state.role === "master" || state.role === "admin") {
    clientRoot.classList.remove("hidden");
    masterRoot.classList.remove("hidden");
    await initClientState();
    renderClient();
    await initMasterState();
    return;
  }

  masterRoot.classList.add("hidden");
  clientRoot.classList.remove("hidden");
  await initClientState();
  renderClient();
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  showToast("Ошибка загрузки");
});
