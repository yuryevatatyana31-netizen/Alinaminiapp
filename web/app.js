const roleBadge = document.querySelector("#roleBadge");
const clientRoot = document.querySelector("#clientRoot");
const masterRoot = document.querySelector("#masterRoot");
const toastEl = document.querySelector("#toast");

const state = {
  role: "client",
  bootstrap: null
};

function showToast(message, timeout = 2600) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  window.setTimeout(() => toastEl.classList.add("hidden"), timeout);
}

function formatRole(role) {
  if (role === "master") return "Мастер / Администратор";
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
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "REQUEST_ERROR");
  }
  return data;
}

function renderClientSkeleton() {
  clientRoot.innerHTML = "";
  const newBookingPanel = panel(
    "Новая запись",
    `
      <p class="helper">Этап разработки: готовим логику выбора длительности, календаря и слотов.</p>
      <div class="field">
        <label>Длительность (минуты)</label>
        <input type="text" value="60" />
      </div>
      <button class="btn" type="button" data-action="stub">Скоро будет доступно</button>
    `,
    false,
    "new-booking"
  );
  const historyPanel = panel(
    "История",
    `<p class="helper">История заявок появится после реализации этапов 3-4.</p>`,
    false,
    "history"
  );
  clientRoot.append(newBookingPanel, historyPanel);
  clientRoot.querySelectorAll("[data-action='stub']").forEach((btn) => {
    btn.addEventListener("click", () => showToast("Раздел в разработке"));
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

async function bootstrap() {
  const url = new URL(window.location.href);
  const roleParam = (url.searchParams.get("role") || "").toLowerCase();
  const role = roleParam === "master" || roleParam === "admin" ? "master" : "client";
  state.role = role;
  state.bootstrap = await api(`/api/bootstrap?role=${role}`);
  roleBadge.textContent = formatRole(role);
  if (role === "master") {
    clientRoot.classList.add("hidden");
    masterRoot.classList.remove("hidden");
    renderMasterSkeleton();
  } else {
    masterRoot.classList.add("hidden");
    clientRoot.classList.remove("hidden");
    renderClientSkeleton();
  }
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  showToast("Ошибка загрузки");
});
