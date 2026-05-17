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
  });
  return el;
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "x-telegram-id": state.actor.telegramId || "",
    "x-telegram-username": state.actor.username || "",
    ...(options.headers || {})
  };
  const response = await fetch(path, { ...options, headers });
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
  if (!state.actor.telegramId) {
    state.history = [];
    return;
  }
  const data = await api(`/api/client/history?telegramId=${state.actor.telegramId}`);
  state.history = data.items || [];
}

function renderHistoryPreview() {
  if (!state.history.length) {
    return `<p class="helper">История пока пуста.</p>`;
  }
  return state.history
    .slice(0, 4)
    .map(
      (item) => `
        <div class="history-item">
          <div class="line-compact">${item.line}</div>
          <div class="status">${item.status}</div>
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
    false,
    "new-booking"
  );

  const panelHistory = panel("История", renderHistoryPreview(), false, "history");
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
}

function renderMasterSkeleton() {
  masterRoot.innerHTML = "";
  const schedule = panel(
    "Рабочий график",
    `<p class="helper">Раздел управления графиком будет реализован на этапе 5.</p>`,
    false,
    "schedule"
  );
  const requests = panel(
    "Заявки",
    `<p class="helper">Фильтры и действия по заявкам будут добавлены на этапе 5.</p>`,
    false,
    "requests"
  );
  masterRoot.append(schedule, requests);
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
    renderMasterSkeleton();
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
