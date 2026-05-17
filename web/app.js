const roleBadge = document.querySelector("#roleBadge");
const clientRoot = document.querySelector("#clientRoot");
const masterRoot = document.querySelector("#masterRoot");
const toastEl = document.querySelector("#toast");

const WEEK_DAYS = ["", "", "", "", "", "", ""];
const MONTHS_RU = [
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  ""
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
  if (role === "master" || role === "admin") return " / ";
  return "";
}

function panel(title, bodyHtml, expanded = false, id = "") {
  const el = document.createElement("article");
  el.className = "panel";
  const bodyClass = expanded ? "panel-body" : "panel-body hidden";
  el.innerHTML = `
    <button class="panel-head" type="button" ${id ? `data-panel-id="${id}"` : ""}>
      <span>${title}</span>
      <span>${expanded ? "" : ""}</span>
    </button>
    <div class="${bodyClass}">${bodyHtml}</div>
  `;
  const head = el.querySelector(".panel-head");
  const arrow = head.querySelector("span:last-child");
  const body = el.querySelector(".panel-body");
  head.addEventListener("click", () => {
    body.classList.toggle("hidden");
    arrow.textContent = body.classList.contains("hidden") ? "" : "";
    if (id === "new-booking") {
      state.client.newBookingExpanded = !body.classList.contains("hidden");
    }
    if (id === "history") {
      state.client.historyExpanded = !body.classList.contains("hidden");
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
        <button class="chip" type="button" data-cal-nav="-1"></button>
        <button class="chip" type="button" data-cal-nav="1"></button>
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
    state.client.formError = "       \" \".";
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
    showToast("  ");
  } catch (error) {
    showToast(error?.message || " ");
  } finally {
    state.client.noSlotsSending = false;
    renderClient();
  }
}

async function submitBooking() {
  const name = ensureString(state.client.name);
  const phone = ensureString(state.client.phone);
  if (!name || !isValidPhone(phone)) {
    state.client.formError = "       \" \".";
    renderClient();
    scrollToElement("#identityBlock");
    return;
  }
  if (!state.client.selectedDateIso || !state.client.selectedSlot) {
    showToast("   ");
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
    showToast("     .");
    return result;
  } catch (error) {
    if (error?.error === "SLOT_ALREADY_REQUESTED") {
      showToast("     .");
      await loadSlotsForSelectedDate();
      renderClient();
      return;
    }
    if (error?.error === "NAME_PHONE_REQUIRED") {
      state.client.formError = error?.message || "   ";
      renderClient();
      scrollToElement("#identityBlock");
      return;
    }
    showToast(error?.message || "  ");
  }
}

async function loadHistory() {
  if (!state.actor.telegramId) {
    state.history = [];
    return;
  }
  const data = await api(`/api/client/history?telegramId=${state.actor.telegramId}`);
  state.history = data.items || [];
}

async function handleHistoryCancel(bookingId) {
  const booking = state.history.find((item) => item.id === bookingId);
  if (!booking) return;
  const name = ensureString(state.client.name);
  const phone = ensureString(state.client.phone);
  if (!name || !isValidPhone(phone)) {
    state.client.formError = "       \" \".";
    state.client.newBookingExpanded = true;
    renderClient();
    scrollToElement("#identityBlock");
    return;
  }
  const cancelMessage = ensureString(state.client.cancelMessage || ",       .");
  try {
    await api("/api/client/cancel-booking", {
      method: "POST",
      body: JSON.stringify({
        user: state.actor,
        bookingId
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
        message: `${cancelMessage}\n: ${booking.line}`
      })
    });
    state.client.pendingCancelBookingId = "";
    state.client.cancelMessage = "";
    await loadAvailableDays();
    await loadHistory();
    renderClient();
    showToast(" ");
  } catch (error) {
    showToast(error?.message || "   ");
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
      showToast("  ");
    });
}

function renderHistoryList() {
  if (!state.history.length) {
    return `<p class="helper">  .</p>`;
  }
  return state.history
    .map(
      (item) => `
        <div class="history-item">
          <div class="line-compact">${item.line}</div>
          <div class="status">${item.status}</div>
          <div class="btn-row">
            <button type="button" class="btn ghost" data-history-action="cancel-open" data-booking-id="${item.id}"></button>
            <button type="button" class="btn secondary" data-history-action="rebook" data-booking-id="${item.id}"></button>
          </div>
          ${
            state.client.pendingCancelBookingId === item.id
              ? `
                <div class="field">
                  <label> </label>
                  <textarea data-cancel-message>${state.client.cancelMessage || ",       ."}</textarea>
                </div>
                <button type="button" class="btn" data-history-action="cancel-send" data-booking-id="${item.id}"> </button>
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
    ? " ."
    : " ,      .    .";
  const noSlotsDefaultText = `,    .  , , ${getDurationSafe()} .`;
  if (!state.client.noSlotsMessage) {
    state.client.noSlotsMessage = noSlotsDefaultText;
  }
  const slotsHtml = state.client.selectedDateIso
    ? `
      <div id="timeSlotsBlock" class="field">
        <label>   ${isoDateToRu(state.client.selectedDateIso)}</label>
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
              : `<span class="helper">     .</span>`
          }
        </div>
      </div>
    `
    : "";

  const panelNew = panel(
    " ",
    `
      <div class="field">
        <label> ()</label>
        <input id="durationInput" type="text" inputmode="numeric" value="${state.client.duration}" />
      </div>
      <div class="calendar" id="calendarRoot"></div>
      <p class="helper ${state.client.hasAnyDay ? "" : "error"}">${helperText}</p>
      ${
        !state.client.hasAnyDay
          ? `
          <div class="field">
            <label> </label>
            <textarea id="noSlotsMessage">${state.client.noSlotsMessage}</textarea>
          </div>
          <button id="sendNoSlotsBtn" class="btn secondary" type="button" ${state.client.noSlotsSending ? "disabled" : ""}> </button>
        `
          : ""
      }
      ${slotsHtml}
      <div id="identityBlock" class="field">
        <label></label>
        <input id="clientNameInput" type="text" value="${state.client.name}" />
      </div>
      <div class="field">
        <label> (+7...  8...)</label>
        <input id="clientPhoneInput" type="tel" value="${state.client.phone}" />
      </div>
      ${
        state.client.formError
          ? `<p class="helper error" id="identityError">${state.client.formError}</p>`
          : ""
      }
      <button id="sendBookingBtn" class="btn" type="button"> </button>
    `,
    state.client.newBookingExpanded,
    "new-booking"
  );

  const panelHistory = panel("", renderHistoryList(), state.client.historyExpanded, "history");
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
        state.client.cancelMessage = ",       .";
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
        <button class="chip" type="button" data-master-cal-nav="-1"></button>
        <button class="chip" type="button" data-master-cal-nav="1"></button>
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

function renderMasterDayConfig() {
  if (!state.master.selectedDateIso || !state.master.dayConfig) {
    return `<p class="helper">   ,      .</p>`;
  }
  const cfg = state.master.dayConfig;
  return `
    <div id="masterDayConfig" class="field">
      <label></label>
      <input type="text" value="${isoDateToRu(state.master.selectedDateIso)}" readonly />
    </div>
    <div class="field">
      <label><input id="dayOffCheckbox" type="checkbox" ${cfg.isDayOff ? "checked" : ""} /> </label>
    </div>
    <div class="btn-row">
      <div class="field">
        <label></label>
        <input id="workStartInput" type="time" value="${cfg.workStart || "08:00"}" />
      </div>
      <div class="field">
        <label></label>
        <input id="workEndInput" type="time" value="${cfg.workEnd || "20:00"}" />
      </div>
    </div>
    <div class="field">
      <label> </label>
      <div id="excludeList">
        ${
          state.master.excludesDraft.length
            ? state.master.excludesDraft
                .map(
                  (item, idx) => `
              <div class="btn-row" data-exclude-row="${idx}">
                <input type="time" data-exclude-start="${idx}" value="${item.start}" />
                <input type="time" data-exclude-end="${idx}" value="${item.end}" />
                <button type="button" class="chip" data-exclude-remove="${idx}"></button>
              </div>
            `
                )
                .join("")
            : `<p class="helper">  .</p>`
        }
      </div>
      <button id="addExcludeBtn" type="button" class="btn ghost"> </button>
    </div>
    <button id="saveDayConfigBtn" type="button" class="btn">  </button>
  `;
}

function renderDayBookings() {
  if (!state.master.selectedDateIso) return "";
  if (!state.master.dayBookings.length) {
    return `
      <div class="field">
        <label> </label>
        <p class="helper">    .</p>
      </div>
    `;
  }
  return `
    <div class="field">
      <label> </label>
      <div class="chips">
        ${state.master.dayBookings
          .map(
            (item) =>
              `<div class="chip">${item.timeRange}  ${item.durationMinutes}   ${item.clientName}  ${item.clientPhone}</div>`
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
        <span> </span>
        <span>${visible ? "" : ""}</span>
      </button>
      <div class="panel-body ${visible ? "" : "hidden"}">
        ${
          state.master.selectedDateIso
            ? state.master.freeSlots.length
              ? `<div class="chips">${state.master.freeSlots.map((slot) => `<span class="chip">${slot}</span>`).join("")}</div>`
              : "<p class='helper'>     .</p>"
            : "<p class='helper'> ,    .</p>"
        }
      </div>
    </article>
  `;
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
    showToast("  ");
  } catch {
    showToast("  ");
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
          status: ""
        })
      });
      showToast(" ");
    } else if (action === "reject") {
      await api("/api/master/update-booking-status", {
        method: "POST",
        body: JSON.stringify({
          user: state.actor,
          bookingId,
          status: ""
        })
      });
      showToast(" ");
    } else if (action === "cancel") {
      await api("/api/master/update-booking-status", {
        method: "POST",
        body: JSON.stringify({
          user: state.actor,
          bookingId,
          status: ""
        })
      });
      showToast("  ");
    } else if (action === "reply-send") {
      const text = ensureString(
        document.querySelector(`[data-reply-input='${bookingId}']`)?.value ||
          state.master.replyDraftByBookingId[bookingId] ||
          ""
      );
      if (!text) {
        showToast("  ");
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
      showToast("  ");
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
        showToast("     ");
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
      showToast("  ");
    }
    await loadMasterRequests();
    if (state.master.selectedDateIso) {
      await loadMasterAvailableDays();
      await loadMasterDay(state.master.selectedDateIso);
    }
    renderMaster();
  } catch (error) {
    showToast(error?.message || "  ");
  }
}

function renderMasterRequests() {
  const filters = [
    { key: "all", label: "" },
    { key: " ", label: " " },
    { key: "", label: "" },
    { key: "", label: "" },
    { key: "", label: "" },
    { key: " ", label: "" }
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
            <div class="line-compact">${item.date}  ${item.timeRange}  ${item.durationMinutes} </div>
            <div class="status">${item.clientName}  ${item.clientPhone}</div>
            <div class="status">${item.status}</div>
            <div class="btn-row">
              <button type="button" class="btn ghost" data-master-action="confirm" data-booking-id="${item.id}"></button>
              <button type="button" class="btn ghost" data-master-action="reject" data-booking-id="${item.id}"></button>
            </div>
            <div class="btn-row">
              <button type="button" class="btn ghost" data-master-action="cancel" data-booking-id="${item.id}"></button>
              <button type="button" class="btn secondary" data-master-action="reschedule-open" data-booking-id="${item.id}"></button>
              <button type="button" class="btn secondary" data-master-action="reply-open" data-booking-id="${item.id}"> </button>
            </div>
            ${
              replyOpen
                ? `
                <div class="field">
                  <label> </label>
                  <textarea data-reply-input="${item.id}">${state.master.replyDraftByBookingId[item.id] || ""}</textarea>
                </div>
                <button type="button" class="btn" data-master-action="reply-send" data-booking-id="${item.id}"> </button>
              `
                : ""
            }
            ${
              rescheduleOpen
                ? `
                <div class="field">
                  <label> </label>
                  <input type="date" data-reschedule-date="${item.id}" value="${state.master.rescheduleDraftByBookingId[item.id]?.newDate || item.dateIso}" />
                </div>
                <div class="btn-row">
                  <div class="field">
                    <label> </label>
                    <input type="time" data-reschedule-start="${item.id}" value="${state.master.rescheduleDraftByBookingId[item.id]?.newStart || item.timeRange.split("-")[0]}" />
                  </div>
                  <div class="field">
                    <label></label>
                    <input type="number" data-reschedule-duration="${item.id}" value="${state.master.rescheduleDraftByBookingId[item.id]?.newDuration || item.durationMinutes}" />
                  </div>
                </div>
                <button type="button" class="btn" data-master-action="reschedule-send" data-booking-id="${item.id}"> </button>
              `
                : ""
            }
          </div>
        `;
        })
        .join("")
    : `<p class="helper">    .</p>`;

  return `${filtersHtml}<div class="field">${listHtml}</div>`;
}

function renderMaster() {
  const scheduleBody = `
    <div class="calendar" id="masterCalendarRoot"></div>
    ${renderMasterDayConfig()}
    ${renderDayBookings()}
    ${renderMasterFreeSlots()}
  `;
  const requestsBody = renderMasterRequests();
  const schedulePanel = panel(" ", scheduleBody, false, "master-schedule");
  const requestsPanel = panel("", requestsBody, false, "master-requests");
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
  const tgUser = getTelegramUser();
  const fallbackUser = getFallbackUserFromQuery();
  state.actor = {
    telegramId: tgUser?.telegramId || fallbackUser.telegramId || "",
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
    clientRoot.classList.add("hidden");
    masterRoot.classList.remove("hidden");
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
  showToast(" ");
});
