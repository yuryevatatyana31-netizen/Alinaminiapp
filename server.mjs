import { createServer } from "node:http";
import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const ROOT = resolve(".");
const WEB_DIR = join(ROOT, "web");
const STORE_PATH = join(ROOT, "data", "store.json");
const MOSCOW_OFFSET_HOURS = 3;
const SLOT_STEP_MINUTES = 15;

const MASTER_TELEGRAM_USERNAME = (process.env.MASTER_TELEGRAM_USERNAME || "idushchaya_a").toLowerCase();
const ADMIN_TELEGRAM_USERNAME = (process.env.ADMIN_TELEGRAM_USERNAME || "Tatyana_Yuryeva").toLowerCase();
const MASTER_TELEGRAM_ID = process.env.MASTER_TELEGRAM_ID || "";
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || "";
const MASTER_TELEGRAM_USERNAMES = new Set([MASTER_TELEGRAM_USERNAME, "idushchaya_a"].filter(Boolean));
const ADMIN_TELEGRAM_USERNAMES = new Set([ADMIN_TELEGRAM_USERNAME, "tatyana_yuryeva", "idolzhenkow"].filter(Boolean));
const MASTER_TELEGRAM_IDS = new Set([MASTER_TELEGRAM_ID].filter(Boolean));
const ADMIN_TELEGRAM_IDS = new Set([ADMIN_TELEGRAM_ID, "256286964"].filter(Boolean));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const MINIAPP_PUBLIC_URL = process.env.MINIAPP_PUBLIC_URL || "https://electrologinyabot.fd-yureva.ru/miniapp/";
const AUTO_OPEN_MONTHS = new Set(["2026-05", "2026-06"]);

const STATUS_PENDING = "на согласовании";
const STATUS_CONFIRMED = "подтверждена";
const STATUS_COMPLETED = "завершена";
const STATUS_CANCELLED = "отменена";
const STATUS_REBOOKED_BY_MASTER = "перезаписано мастером";
const STATUS_REJECTED = "отклонена";

const ACTIVE_BOOKING_STATUSES = new Set([STATUS_PENDING, STATUS_CONFIRMED]);
const STATUS_BY_ALIAS = {
  pending: STATUS_PENDING,
  confirmed: STATUS_CONFIRMED,
  completed: STATUS_COMPLETED,
  cancelled: STATUS_CANCELLED,
  canceled: STATUS_CANCELLED,
  rebooked_by_master: STATUS_REBOOKED_BY_MASTER,
  rejected: STATUS_REJECTED
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

let storeWriteLock = Promise.resolve();

function logEvent(level, message, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

function createDefaultStore() {
  return {
    meta: {
      timezone: "Europe/Moscow",
      defaultWorkStart: "08:00",
      defaultWorkEnd: "20:00",
      defaultDurationMinutes: 60,
      pendingMasterReplies: {},
      pendingClientBookings: {}
    },
    users: [],
    dayConfigs: {},
    bookings: [],
    messages: []
  };
}

async function loadStore() {
  if (!existsSync(STORE_PATH)) {
    const initial = createDefaultStore();
    await saveStore(initial);
    return initial;
  }
  const raw = await readFile(STORE_PATH, "utf-8");
  const data = JSON.parse(raw);
  if (!data.meta.pendingMasterReplies) data.meta.pendingMasterReplies = {};
  if (!data.meta.pendingClientBookings) data.meta.pendingClientBookings = {};
  return data;
}

async function saveStore(store) {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

async function withStoreMutate(mutator) {
  const mutation = async () => {
    const store = await loadStore();
    const result = await mutator(store);
    await saveStore(store);
    return result;
  };
  storeWriteLock = storeWriteLock.then(mutation, mutation);
  return storeWriteLock;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function ensureString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeUsername(username) {
  return ensureString(username).replace(/^@/, "").toLowerCase();
}

function resolveRoleFromIdentity(telegramId, username) {
  const normalizedUsername = normalizeUsername(username);
  const idString = ensureString(String(telegramId || ""));
  const isMaster = MASTER_TELEGRAM_IDS.has(idString) || MASTER_TELEGRAM_USERNAMES.has(normalizedUsername);
  const isAdmin = ADMIN_TELEGRAM_IDS.has(idString) || ADMIN_TELEGRAM_USERNAMES.has(normalizedUsername);
  if (isMaster || isAdmin) {
    return isAdmin ? "admin" : "master";
  }
  return "client";
}

function getActorFromRequest(req, url, body) {
  const queryUserId = ensureString(url.searchParams.get("telegramId") || url.searchParams.get("userId"));
  const queryUsername = ensureString(url.searchParams.get("username"));
  const queryFirstName = ensureString(url.searchParams.get("firstName"));
  const queryLastName = ensureString(url.searchParams.get("lastName"));
  const bodyUser = body?.user || {};
  const headerUserId = ensureString(req.headers["x-telegram-id"]);
  const headerUsername = ensureString(req.headers["x-telegram-username"]);

  const telegramId = ensureString(bodyUser.telegramId || bodyUser.userId || headerUserId || queryUserId);
  const username = ensureString(bodyUser.username || headerUsername || queryUsername);
  const firstName = ensureString(bodyUser.firstName || queryFirstName);
  const lastName = ensureString(bodyUser.lastName || queryLastName);
  const phone = ensureString(bodyUser.phone || "");

  return {
    telegramId,
    username,
    firstName,
    lastName,
    phone,
    role: resolveRoleFromIdentity(telegramId, username)
  };
}

function upsertUser(store, actor) {
  if (!actor.telegramId) return null;
  const now = new Date().toISOString();
  const existing = store.users.find((item) => item.telegramId === actor.telegramId);
  if (existing) {
    existing.username = actor.username || existing.username || "";
    existing.firstName = actor.firstName || existing.firstName || "";
    existing.lastName = actor.lastName || existing.lastName || "";
    existing.phone = actor.phone || existing.phone || "";
    existing.role = resolveRoleFromIdentity(existing.telegramId, existing.username);
    existing.lastSeenAt = now;
    return existing;
  }
  const record = {
    telegramId: actor.telegramId,
    username: actor.username || "",
    firstName: actor.firstName || "",
    lastName: actor.lastName || "",
    phone: actor.phone || "",
    role: actor.role,
    createdAt: now,
    lastSeenAt: now
  };
  store.users.push(record);
  return record;
}

function formatDateRu(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function nowUtcMs() {
  return Date.now();
}

function parseIsoDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return { y, m, d };
}

function parseTimeToMinutes(timeString) {
  const [h, m] = ensureString(timeString).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

function formatMinutesToTime(totalMinutes) {
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function toUtcMsForMoscowDateTime(isoDate, hhmm) {
  const { y, m, d } = parseIsoDate(isoDate);
  const minutes = parseTimeToMinutes(hhmm);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return Date.UTC(y, m - 1, d, hh - MOSCOW_OFFSET_HOURS, mm, 0, 0);
}

function getMoscowTodayIsoDate() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(now);
}

function normalizePhone(phoneRaw) {
  const value = ensureString(phoneRaw).replace(/[^\d+]/g, "");
  if (!value) return "";
  if (value.startsWith("+7") && value.length === 12) {
    const digits = value.replace(/\D/g, "");
    if (digits.length === 11) return `+7${digits.slice(1)}`;
  }
  const digitsOnly = value.replace(/\D/g, "");
  if (digitsOnly.length === 11 && (digitsOnly.startsWith("7") || digitsOnly.startsWith("8"))) {
    return `+7${digitsOnly.slice(1)}`;
  }
  return "";
}

function isValidRussianPhone(phoneRaw) {
  return normalizePhone(phoneRaw).length === 12;
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function getDayConfig(store, isoDate) {
  const custom = store.dayConfigs[isoDate];
  const defaultConfig = {
    isDayOff: !AUTO_OPEN_MONTHS.has(isoDate.slice(0, 7)),
    workStart: store.meta.defaultWorkStart || "08:00",
    workEnd: store.meta.defaultWorkEnd || "20:00",
    excludes: []
  };
  return {
    ...defaultConfig,
    ...(custom || {}),
    excludes: Array.isArray(custom?.excludes) ? custom.excludes : []
  };
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function subtractIntervals(baseIntervals, blockedIntervals) {
  const blocked = mergeIntervals(blockedIntervals);
  const result = [];
  for (const base of baseIntervals) {
    let cursor = base.start;
    for (const block of blocked) {
      if (block.end <= cursor || block.start >= base.end) {
        continue;
      }
      if (block.start > cursor) {
        result.push({ start: cursor, end: Math.min(block.start, base.end) });
      }
      cursor = Math.max(cursor, block.end);
      if (cursor >= base.end) break;
    }
    if (cursor < base.end) {
      result.push({ start: cursor, end: base.end });
    }
  }
  return result.filter((item) => item.end > item.start);
}

function getWorkingIntervalsFromConfig(dayConfig) {
  if (dayConfig.isDayOff) return [];
  const workStart = parseTimeToMinutes(dayConfig.workStart);
  const workEnd = parseTimeToMinutes(dayConfig.workEnd);
  if (Number.isNaN(workStart) || Number.isNaN(workEnd) || workEnd <= workStart) return [];
  let intervals = [{ start: workStart, end: workEnd }];
  const excludes = (dayConfig.excludes || [])
    .map((interval) => ({
      start: parseTimeToMinutes(interval.start),
      end: parseTimeToMinutes(interval.end)
    }))
    .filter((interval) => !Number.isNaN(interval.start) && !Number.isNaN(interval.end) && interval.end > interval.start);
  if (excludes.length) {
    intervals = subtractIntervals(intervals, excludes);
  }
  return intervals;
}

function getBookedIntervals(store, isoDate) {
  return store.bookings
    .filter((booking) => booking.date === isoDate && ACTIVE_BOOKING_STATUSES.has(booking.status))
    .map((booking) => ({
      start: parseTimeToMinutes(booking.start),
      end: parseTimeToMinutes(booking.end)
    }))
    .filter((interval) => !Number.isNaN(interval.start) && !Number.isNaN(interval.end) && interval.end > interval.start);
}

function getAvailableIntervals(store, isoDate) {
  const dayConfig = getDayConfig(store, isoDate);
  const workingIntervals = getWorkingIntervalsFromConfig(dayConfig);
  if (!workingIntervals.length) return [];
  const bookedIntervals = getBookedIntervals(store, isoDate);
  if (!bookedIntervals.length) return workingIntervals;
  return subtractIntervals(workingIntervals, bookedIntervals);
}

function getSlotsForDay(store, isoDate, durationMinutes) {
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const nowMs = nowUtcMs();
  const availableIntervals = getAvailableIntervals(store, isoDate);
  const slots = [];
  for (const interval of availableIntervals) {
    for (let start = interval.start; start + duration <= interval.end; start += SLOT_STEP_MINUTES) {
      const slotStart = formatMinutesToTime(start);
      const slotEnd = formatMinutesToTime(start + duration);
      const slotUtcMs = toUtcMsForMoscowDateTime(isoDate, slotStart);
      if (slotUtcMs <= nowMs) continue;
      slots.push({
        start: slotStart,
        end: slotEnd
      });
    }
  }
  return slots;
}

function listDaysInMonth(month) {
  const [yRaw, mRaw] = month.split("-");
  const y = Number(yRaw);
  const m = Number(mRaw);
  if (!y || !m || m < 1 || m > 12) return [];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let day = 1; day <= lastDay; day += 1) {
    days.push(`${y}-${pad2(m)}-${pad2(day)}`);
  }
  return days;
}

function getAvailableDaysForMonth(store, month, durationMinutes) {
  const today = getMoscowTodayIsoDate();
  return listDaysInMonth(month)
    .filter((date) => date >= today)
    .filter((date) => getSlotsForDay(store, date, durationMinutes).length > 0);
}

function sanitizeDuration(rawDuration, fallback = 60) {
  const parsed = Number(rawDuration);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.round(parsed), 5), 600);
}

function formatBookingCompact(booking) {
  return `${formatDateRu(booking.date)} · ${booking.start} · ${booking.durationMinutes} мин`;
}

function buildClientDisplayName(actor, fallback = "Клиент") {
  const fullName = `${ensureString(actor.firstName)} ${ensureString(actor.lastName)}`.trim();
  const username = normalizeUsername(actor.username);
  if (fullName) return fullName;
  if (username) return `@${username}`;
  return fallback;
}

function findStaffChatIds(store) {
  const ids = new Set([...MASTER_TELEGRAM_IDS, ...ADMIN_TELEGRAM_IDS]);
  for (const user of store.users || []) {
    const username = normalizeUsername(user.username);
    const role = resolveRoleFromIdentity(user.telegramId, user.username);
    if (
      role === "master" ||
      role === "admin" ||
      MASTER_TELEGRAM_USERNAMES.has(username) ||
      ADMIN_TELEGRAM_USERNAMES.has(username)
    ) {
      if (user.telegramId && !String(user.telegramId).startsWith("web_")) ids.add(String(user.telegramId));
    }
  }
  return [...ids].filter(Boolean);
}

async function sendTelegramMessageToStaff(store, text, options = {}) {
  const chatIds = findStaffChatIds(store);
  const results = [];
  for (const chatId of chatIds) {
    results.push(await sendTelegramMessage(chatId, text, options));
  }
  return results;
}

function getTelegramApiUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramApi(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, skipped: true };
  const response = await fetch(getTelegramApiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  return data;
}

async function sendTelegramMessage(chatId, text, options = {}) {
  if (!chatId) return { ok: false, skipped: true, reason: "MISSING_CHAT_ID" };
  const payload = {
    chat_id: chatId,
    text,
    ...options
  };
  return telegramApi("sendMessage", payload);
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!callbackQueryId) return;
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: false
  });
}

function t(base64) {
  return Buffer.from(base64, "base64").toString("utf8");
}

async function sendStartMessage(chatId) {
  const text = t("8J+RiyDQl9C00YDQsNCy0YHRgtCy0YPQudGC0LUhINCvINCx0L7Rgi3Qv9C+0LzQvtGJ0L3QuNC6INCQ0LvQuNC90Ysg0LTQu9GPINC30LDQv9C40YHQuCDQvdCwINC/0YDQvtGG0LXQtNGD0YDRiy4KCuKcje+4jyDQndCw0LbQvNC40YLQtSDQutC90L7Qv9C60YMgwqvQl9Cw0L/QuNGB0LDRgtGM0YHRj8K7LCDRh9GC0L7QsdGLINC+0YLQutGA0YvRgtGMINC80LjQvdC4LdC/0YDQuNC70L7QttC10L3QuNC1LgoK8J+Ul9CV0YHQu9C4INC60L3QvtC/0LrQsCDCq9CX0LDQv9C40YHQsNGC0YzRgdGPwrsg0L3QtSDRgdGA0LDQsdC+0YLQsNC70LAsINC90LDQttC80LjRgtC1IMKr0J7RgtC60YDRi9GC0Ywg0LIg0LHRgNCw0YPQt9C10YDQtcK7Lg==");
  const browserText = t("0J7RgtC60YDRi9GC0Ywg0LIg0LHRgNCw0YPQt9C10YDQtQ==");
  return sendTelegramMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: browserText, url: MINIAPP_PUBLIC_URL }]]
    }
  });
}

function assertMasterRole(actor) {
  return actor.role === "master" || actor.role === "admin";
}

function checkRequiredNamePhone(name, phone) {
  const safeName = ensureString(name);
  const normalizedPhone = normalizePhone(phone);
  if (!safeName || !normalizedPhone) return null;
  return { name: safeName, phone: normalizedPhone };
}

function normalizeStatusInput(statusInput) {
  const source = ensureString(statusInput);
  if (!source) return "";
  const lowered = source.toLowerCase();
  if (STATUS_BY_ALIAS[lowered]) return STATUS_BY_ALIAS[lowered];
  const canonical = [
    STATUS_PENDING,
    STATUS_CONFIRMED,
    STATUS_COMPLETED,
    STATUS_CANCELLED,
    STATUS_REBOOKED_BY_MASTER,
    STATUS_REJECTED
  ];
  const matched = canonical.find((item) => item.toLowerCase() === lowered);
  return matched || "";
}

async function notifyMasterAboutBooking(store, booking, actor, type = "new_booking") {
  const header = type === "cancelled" ? "Отмена записи" : type === "rescheduled" ? "Перезапись мастером" : "Новая заявка";
  const message = [
    `${header}`,
    `Имя: ${booking.clientName}`,
    `Телефон: ${booking.clientPhone}`,
    `Дата: ${formatDateRu(booking.date)}`,
    `Время: ${booking.start}-${booking.end}`,
    `Длительность: ${booking.durationMinutes} мин`,
    `Статус: ${booking.status}`
  ].join("\n");
  const inlineKeyboard =
    type === "new_booking"
      ? [
          [{ text: "Согласовать", callback_data: `approve_booking:${booking.id}` }],
          [{ text: "Ответить клиенту", callback_data: `reply_client:${booking.id}:${booking.clientTelegramId}` }]
        ]
      : [[{ text: "Ответить клиенту", callback_data: `reply_client:${booking.id}:${booking.clientTelegramId}` }]];
  return sendTelegramMessageToStaff(store, message, {
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  });
}

async function notifyClientWithReminder(store, booking, beforeHours) {
  const clientChatId = booking.clientTelegramId;
  if (!clientChatId) return;
  const firstLine =
    beforeHours === 24
      ? `Здравствуйте! Напоминаю, что вы записаны на ${formatDateRu(booking.date)} в ${booking.start} (${booking.durationMinutes} мин). Жду вас!`
      : `Здравствуйте! Напоминаю, ваша запись уже через 2 часа — в ${booking.start} (${booking.durationMinutes} мин). Жду вас!`;
  const secondLine = "Если у вас изменились планы, обязательно напишите.";
  await sendTelegramMessage(clientChatId, `${firstLine}\n${secondLine}`, {
    reply_markup: {
      inline_keyboard: [[{ text: "Написать мастеру", callback_data: `contact_master:${booking.id}` }]]
    }
  });
}

async function notifyClientBookingConfirmed(booking) {
  if (!booking.clientTelegramId || booking.clientTelegramId.startsWith("web_")) return;
  await sendTelegramMessage(
    booking.clientTelegramId,
    `Ваша заявка согласована.\nДата: ${formatDateRu(booking.date)}\nВремя: ${booking.start}-${booking.end}\nДлительность: ${booking.durationMinutes} мин.`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: "Написать мастеру", callback_data: `contact_master:${booking.id}` }]]
      }
    }
  );
}

async function handleClientContactMasterCallback(store, callbackQuery) {
  const callbackData = ensureString(callbackQuery.data);
  const [, bookingId] = callbackData.split(":");
  const booking = store.bookings.find((item) => item.id === bookingId);
  if (!booking) {
    await answerCallbackQuery(callbackQuery.id, "Запись не найдена");
    return;
  }
  const message = [
    "Клиент написал через кнопку из напоминания.",
    `Имя: ${booking.clientName}`,
    `Телефон: ${booking.clientPhone}`,
    `Дата: ${formatDateRu(booking.date)}`,
    `Время: ${booking.start}-${booking.end}`,
    `Текущий статус: ${booking.status}`
  ].join("\n");
  await sendTelegramMessageToStaff(store, message, {
    reply_markup: {
      inline_keyboard: [[{ text: "Ответить клиенту", callback_data: `reply_client:${booking.id}:${booking.clientTelegramId}` }]]
    }
  });
  await answerCallbackQuery(callbackQuery.id, "Сообщение мастеру отправлено");
  await sendTelegramMessage(callbackQuery.from.id, "Передала мастеру. Спасибо за сообщение.");
}

async function handleMasterReplyStart(store, callbackQuery) {
  const callbackData = ensureString(callbackQuery.data);
  const [, bookingId, clientTelegramId] = callbackData.split(":");
  const masterChatId = String(callbackQuery.from.id);
  store.meta.pendingMasterReplies[masterChatId] = {
    bookingId,
    clientTelegramId,
    createdAt: new Date().toISOString()
  };
  await answerCallbackQuery(callbackQuery.id, "Напишите ответ клиенту");
  await sendTelegramMessage(masterChatId, "Введите текст сообщения клиенту одним следующим сообщением.");
}

async function handleMasterApproveBooking(store, callbackQuery) {
  const callbackData = ensureString(callbackQuery.data);
  const [, bookingId] = callbackData.split(":");
  const booking = store.bookings.find((item) => item.id === bookingId);
  if (!booking) {
    await answerCallbackQuery(callbackQuery.id, "Заявка не найдена");
    return;
  }
  if (booking.status !== STATUS_PENDING) {
    await answerCallbackQuery(callbackQuery.id, "Заявка уже обработана");
    return;
  }
  booking.status = STATUS_CONFIRMED;
  booking.updatedAt = new Date().toISOString();
  await answerCallbackQuery(callbackQuery.id, "Заявка согласована");
  await notifyClientBookingConfirmed(booking);
}

function getBotBookingState(store, chatId) {
  if (!store.meta.pendingClientBookings) store.meta.pendingClientBookings = {};
  return store.meta.pendingClientBookings[chatId] || null;
}

function setBotBookingState(store, chatId, state) {
  if (!store.meta.pendingClientBookings) store.meta.pendingClientBookings = {};
  store.meta.pendingClientBookings[chatId] = {
    ...state,
    updatedAt: new Date().toISOString()
  };
}

function clearBotBookingState(store, chatId) {
  if (!store.meta.pendingClientBookings) store.meta.pendingClientBookings = {};
  delete store.meta.pendingClientBookings[chatId];
}

function buildBotCalendarKeyboard(store, month, duration) {
  const availableDates = new Set(getAvailableDaysForMonth(store, month, duration));
  const days = listDaysInMonth(month);
  const rows = [
    [
      { text: t("0J/QvQ=="), callback_data: "noop" },
      { text: t("0JLRgg=="), callback_data: "noop" },
      { text: t("0KHRgA=="), callback_data: "noop" },
      { text: t("0KfRgg=="), callback_data: "noop" },
      { text: t("0J/Rgg=="), callback_data: "noop" },
      { text: t("0KHQsQ=="), callback_data: "noop" },
      { text: t("0JLRgQ=="), callback_data: "noop" }
    ]
  ];
  let currentRow = [];
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekDay = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  for (let i = 0; i < firstWeekDay; i += 1) {
    currentRow.push({ text: " ", callback_data: "noop" });
  }
  for (const date of days) {
    const day = Number(date.slice(-2));
    const isAvailable = availableDates.has(date);
    currentRow.push({
      text: isAvailable ? String(day) : "·",
      callback_data: isAvailable ? `bot_day:${date}:${duration}` : "noop"
    });
    if (currentRow.length === 7) {
      rows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length) {
    while (currentRow.length < 7) currentRow.push({ text: " ", callback_data: "noop" });
    rows.push(currentRow);
  }
  rows.push([
    { text: t("4peA77iP"), callback_data: `bot_month:${addMonths(month, -1)}:${duration}` },
    { text: t("0J7RgtC80LXQvdCw"), callback_data: "bot_cancel" },
    { text: t("4pa277iP"), callback_data: `bot_month:${addMonths(month, 1)}:${duration}` }
  ]);
  return rows;
}

async function sendBotBookingCalendar(store, chatId, month, duration) {
  const [year, monthNumber] = month.split("-").map(Number);
  const title = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "Europe/Moscow"
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  await sendTelegramMessage(
    chatId,
    `${t("0JLRi9Cx0LXRgNC40YLQtSDQtNCw0YLRgw==")} (${title}):\n${t("0J/QvtC60LDQt9Cw0L3RiyDRgtC+0LvRjNC60L4g0LTQvtGB0YLRg9C/0L3Ri9C1INC00LDRgtGLLg==")}`,
    {
    reply_markup: {
      inline_keyboard: buildBotCalendarKeyboard(store, month, duration)
    }
  });
}

async function startBotBooking(store, chatId) {
  setBotBookingState(store, chatId, { step: "duration" });
  await sendTelegramMessage(chatId, t("0JLQstC10LTQuNGC0LUg0LTQu9C40YLQtdC70YzQvdC+0YHRgtGMINC/0YDQvtGG0LXQtNGD0YDRiyDQsiDQvNC40L3Rg9GC0LDRhTo="));
}

async function handleBotBookingCallback(store, callbackQuery) {
  const chatId = String(callbackQuery.from.id);
  const data = ensureString(callbackQuery.data);
  if (data === "noop") {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }
  if (data === "bot_cancel") {
    clearBotBookingState(store, chatId);
    await answerCallbackQuery(callbackQuery.id, t("0JfQsNC/0LjRgdGMINC+0YLQvNC10L3QtdC90LA="));
    await sendTelegramMessage(chatId, t("0JfQsNC/0LjRgdGMINGH0LXRgNC10Lcg0LHQvtGCINC+0YLQvNC10L3QtdC90LAu"));
    return;
  }
  if (data.startsWith("bot_month:")) {
    const [, month, durationRaw] = data.split(":");
    const duration = sanitizeDuration(durationRaw, 60);
    setBotBookingState(store, chatId, { step: "date", duration, month });
    await answerCallbackQuery(callbackQuery.id);
    await sendBotBookingCalendar(store, chatId, month, duration);
    return;
  }
  if (data.startsWith("bot_day:")) {
    const [, date, durationRaw] = data.split(":");
    const duration = sanitizeDuration(durationRaw, 60);
    const slots = getSlotsForDay(store, date, duration);
    if (!slots.length) {
      await answerCallbackQuery(callbackQuery.id, t("0J3QsCDRjdGC0L7RgiDQtNC10L3RjCDRg9C20LUg0L3QtdGCINGB0LLQvtCx0L7QtNC90YvRhSDQvtC60L7QvQ=="));
      return;
    }
    setBotBookingState(store, chatId, { step: "slot", duration, date });
    await answerCallbackQuery(callbackQuery.id);
    const rows = slots.slice(0, 80).map((slot) => [
      {
        text: `${formatDateRu(date)} ${slot.start}`,
        callback_data: `bot_slot:${date}:${slot.start.replace(":", "")}:${duration}`
      }
    ]);
    rows.push([{ text: t("0J7RgtC80LXQvdCw"), callback_data: "bot_cancel" }]);
    await sendTelegramMessage(chatId, t("0JLRi9Cx0LXRgNC40YLQtSDRgdCy0L7QsdC+0LTQvdGL0Lkg0YHQu9C+0YI6"), {
      reply_markup: {
        inline_keyboard: rows
      }
    });
    return;
  }
  if (data.startsWith("bot_slot:")) {
    const [, date, startRaw, durationRaw] = data.split(":");
    const start = `${startRaw.slice(0, 2)}:${startRaw.slice(2, 4)}`;
    const duration = sanitizeDuration(durationRaw, 60);
    const slot = getSlotsForDay(store, date, duration).find((item) => item.start === start);
    if (!slot) {
      await answerCallbackQuery(callbackQuery.id, t("0J3QsCDRjdGC0L4g0LLRgNC10LzRjyDRg9C20LUg0L7RgtC/0YDQsNCy0LvQtdC90LAg0LfQsNGP0LLQutCw"));
      return;
    }
    setBotBookingState(store, chatId, { step: "contact", duration, date, start, end: slot.end });
    await answerCallbackQuery(callbackQuery.id);
    await sendTelegramMessage(chatId, `${t("0JLRiyDQstGL0LHRgNCw0LvQuA==")} ${formatDateRu(date)} ${slot.start}-${slot.end}.\n${t("0JLQstC10LTQuNGC0LUg0LjQvNGPINC4INGC0LXQu9C10YTQvtC9INC+0LTQvdC40Lwg0YHQvtC+0LHRidC10L3QuNC10Lw6")}`);
  }
}

function parseNamePhoneFromMessage(messageText, actor) {
  const phoneMatch = ensureString(messageText).match(/(?:\+7|8|7)[\d\s\-()]{9,}/);
  const phone = normalizePhone(phoneMatch?.[0] || "");
  const name = ensureString(messageText.replace(phoneMatch?.[0] || "", "").replace(/[,;]+/g, " "));
  return {
    name: name || buildClientDisplayName(actor, ""),
    phone
  };
}

async function handleBotBookingMessage(store, chatId, messageText, actor) {
  const lower = messageText.toLowerCase();
  if (lower === t("0LfQsNC/0LjRgdCw0YLRjNGB0Y8=") || lower === "/book") {
    await startBotBooking(store, chatId);
    return true;
  }
  if (lower === t("0L7RgtC80LXQvdCw") || lower === "/cancel") {
    clearBotBookingState(store, chatId);
    await sendTelegramMessage(chatId, t("0JfQsNC/0LjRgdGMINGH0LXRgNC10Lcg0LHQvtGCINC+0YLQvNC10L3QtdC90LAu"));
    return true;
  }
  const pending = getBotBookingState(store, chatId);
  if (!pending) return false;
  if (pending.step === "duration") {
    const duration = sanitizeDuration(messageText, 0);
    if (!duration) {
      await sendTelegramMessage(chatId, t("0JLQstC10LTQuNGC0LUg0LTQu9C40YLQtdC70YzQvdC+0YHRgtGMINGH0LjRgdC70L7QvCwg0L3QsNC/0YDQuNC80LXRgCA2MC4="));
      return true;
    }
    const month = getMoscowTodayIsoDate().slice(0, 7);
    setBotBookingState(store, chatId, { step: "date", duration, month });
    await sendBotBookingCalendar(store, chatId, month, duration);
    return true;
  }
  if (pending.step === "contact") {
    const contact = parseNamePhoneFromMessage(messageText, actor);
    const safe = checkRequiredNamePhone(contact.name, contact.phone);
    if (!safe) {
      await sendTelegramMessage(chatId, t("0JLQstC10LTQuNGC0LUg0LjQvNGPINC4INGC0LXQu9C10YTQvtC9INC+0LTQvdC40Lwg0YHQvtC+0LHRidC10L3QuNC10LwuINCd0LDQv9GA0LjQvNC10YA6INCi0LDRgtGM0Y/QvdCwICs3OTAxMjM0NTY3OA=="));
      return true;
    }
    const slots = getSlotsForDay(store, pending.date, pending.duration);
    const slot = slots.find((item) => item.start === pending.start);
    if (!slot) {
      clearBotBookingState(store, chatId);
      await sendTelegramMessage(chatId, t("0J3QsCDRjdGC0L4g0LLRgNC10LzRjyDRg9C20LUg0L7RgtC/0YDQsNCy0LvQtdC90LAg0LfQsNGP0LLQutCwLiDQndCw0LbQvNC40YLQtSDCq9CX0LDQv9C40YHQsNGC0YzRgdGPwrssINGH0YLQvtCx0Ysg0LLRi9Cx0YDQsNGC0Ywg0LTRgNGD0LPQvtC1INCy0YDQtdC80Y8u"));
      return true;
    }
    const booking = {
      id: generateId("booking"),
      clientTelegramId: chatId,
      clientUsername: actor.username,
      clientName: safe.name,
      clientPhone: safe.phone,
      date: pending.date,
      start: slot.start,
      end: slot.end,
      durationMinutes: pending.duration,
      status: STATUS_PENDING,
      reminders: { h24SentAt: null, h2SentAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.bookings.push(booking);
    upsertUser(store, { ...actor, phone: safe.phone, role: actor.role });
    clearBotBookingState(store, chatId);
    await notifyMasterAboutBooking(store, booking, actor);
    await sendTelegramMessage(chatId, t("0JLQsNGI0LAg0LfQsNGP0LLQutCwINC90LAg0YDQsNGB0YHQvNC+0YLRgNC10L3QuNC4INGDINC80LDRgdGC0LXRgNCwLg=="));
    return true;
  }
  return true;
}

function serializeBookingForClient(booking) {
  return {
    id: booking.id,
    line: formatBookingCompact(booking),
    date: formatDateRu(booking.date),
    dateIso: booking.date,
    start: booking.start,
    end: booking.end,
    durationMinutes: booking.durationMinutes,
    status: booking.status
  };
}

function parseMonthOrCurrent(monthParam) {
  const month = ensureString(monthParam);
  if (/^\d{4}-\d{2}$/.test(month)) return month;
  const today = getMoscowTodayIsoDate();
  return today.slice(0, 7);
}

function validateMonthString(month) {
  return /^\d{4}-\d{2}$/.test(ensureString(month));
}

function addMonths(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function validateIsoDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(ensureString(date));
}

function validateTimeString(time) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(ensureString(time));
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "electrologinya-miniapp" });
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const store = await loadStore();
    const actor = getActorFromRequest(req, url, {});
    const roleParam = ensureString(url.searchParams.get("role"));
    const localRole = roleParam === "master" || roleParam === "admin" ? "master" : "client";
    const role = actor.telegramId || actor.username ? actor.role : localRole;
    const effectiveActor = { ...actor, role };
    upsertUser(store, effectiveActor);
    await saveStore(store);
    return sendJson(res, 200, {
      ok: true,
      actor: effectiveActor,
      meta: store.meta,
      statuses: [STATUS_PENDING, STATUS_CONFIRMED, STATUS_COMPLETED, STATUS_CANCELLED, STATUS_REBOOKED_BY_MASTER, STATUS_REJECTED],
      now: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/client/available-days") {
    const store = await loadStore();
    const month = parseMonthOrCurrent(url.searchParams.get("month"));
    const duration = sanitizeDuration(url.searchParams.get("duration"), store.meta.defaultDurationMinutes || 60);
    const availableDaysIso = getAvailableDaysForMonth(store, month, duration);
    const availableDays = availableDaysIso.map((isoDate) => Number(isoDate.slice(-2)));
    return sendJson(res, 200, {
      ok: true,
      month,
      duration,
      availableDays,
      availableDatesIso: availableDaysIso,
      hasAny: availableDays.length > 0
    });
  }

  if (req.method === "GET" && url.pathname === "/api/client/day-slots") {
    const store = await loadStore();
    const date = ensureString(url.searchParams.get("date"));
    if (!validateIsoDate(date)) {
      return sendJson(res, 400, { ok: false, error: "INVALID_DATE" });
    }
    const duration = sanitizeDuration(url.searchParams.get("duration"), store.meta.defaultDurationMinutes || 60);
    const slots = getSlotsForDay(store, date, duration);
    return sendJson(res, 200, { ok: true, date, duration, slots });
  }

  if (req.method === "GET" && url.pathname === "/api/client/history") {
    const store = await loadStore();
    const telegramId = ensureString(url.searchParams.get("telegramId"));
    const phone = normalizePhone(url.searchParams.get("phone"));
    const items = store.bookings
      .filter((booking) => {
        const sameTelegram = telegramId && booking.clientTelegramId === telegramId;
        const samePhone = phone && normalizePhone(booking.clientPhone) === phone;
        return sameTelegram || samePhone;
      })
      .sort((a, b) => {
        if (a.date === b.date) return a.start.localeCompare(b.start);
        return a.date.localeCompare(b.date);
      })
      .reverse()
      .map(serializeBookingForClient);
    return sendJson(res, 200, { ok: true, items });
  }

  if (req.method === "POST" && url.pathname === "/api/client/send-master-message") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    const safe = checkRequiredNamePhone(body.name, body.phone);
    if (!safe) {
      return sendJson(res, 422, {
        ok: false,
        error: "NAME_PHONE_REQUIRED",
        message: "Введите имя и номер телефона и нажмите \"Отправить заявку\"."
      });
    }
    const duration = sanitizeDuration(body.duration, 60);
    const text = ensureString(body.message);
    const type = ensureString(body.type) || "general";
    const messageTitle =
      type === "cancel_booking"
        ? "Отмена записи"
        : type === "no_slots"
          ? "Сообщение клиентки мастеру"
          : "Сообщение клиентки мастеру";

    const result = await withStoreMutate(async (store) => {
      upsertUser(store, { ...actor, phone: safe.phone, role: actor.role });
      const composed = [
        messageTitle,
        `Имя: ${safe.name}`,
        `Телефон: ${safe.phone}`,
        `Telegram: ${buildClientDisplayName(actor)}`,
        `Длительность: ${duration} мин`,
        "",
        text
      ].join("\n");
      await sendTelegramMessageToStaff(store, composed);
      store.messages.push({
        id: generateId("msg"),
        type,
        fromTelegramId: actor.telegramId || "",
        to: "master",
        name: safe.name,
        phone: safe.phone,
        duration,
        text,
        createdAt: new Date().toISOString()
      });
      return { ok: true };
    });

    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/client/create-booking") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    if (!actor.telegramId) {
      return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED" });
    }
    const safe = checkRequiredNamePhone(body.name, body.phone);
    if (!safe) {
      return sendJson(res, 422, {
        ok: false,
        error: "NAME_PHONE_REQUIRED",
        message: "Введите имя и номер телефона и нажмите \"Отправить заявку\"."
      });
    }
    const date = ensureString(body.date);
    const start = ensureString(body.start);
    if (!validateIsoDate(date) || !validateTimeString(start)) {
      return sendJson(res, 400, { ok: false, error: "INVALID_DATETIME" });
    }
    const duration = sanitizeDuration(body.duration, 60);

    const result = await withStoreMutate(async (store) => {
      upsertUser(store, { ...actor, phone: safe.phone, role: actor.role });
      const freshSlots = getSlotsForDay(store, date, duration);
      const selectedSlot = freshSlots.find((slot) => slot.start === start);
      if (!selectedSlot) {
        return {
          ok: false,
          status: 409,
          error: "SLOT_ALREADY_REQUESTED",
          message: "На это время уже отправлена заявка."
        };
      }

      const booking = {
        id: generateId("booking"),
        clientTelegramId: actor.telegramId,
        clientUsername: normalizeUsername(actor.username),
        clientName: safe.name,
        clientPhone: safe.phone,
        date,
        start: selectedSlot.start,
        end: selectedSlot.end,
        durationMinutes: duration,
        status: STATUS_PENDING,
        reminders: {
          h24SentAt: null,
          h2SentAt: null
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      store.bookings.push(booking);
      await notifyMasterAboutBooking(store, booking, actor, "new_booking");
      return {
        ok: true,
        booking: serializeBookingForClient(booking)
      };
    });

    if (!result.ok) {
      return sendJson(res, result.status || 400, result);
    }
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/client/cancel-booking") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    const bookingId = ensureString(body.bookingId);
    const phone = normalizePhone(body.phone || actor.phone);
    if (!bookingId) return sendJson(res, 400, { ok: false, error: "BOOKING_ID_REQUIRED" });

    const result = await withStoreMutate(async (store) => {
      const booking = store.bookings.find((item) => item.id === bookingId);
      if (!booking) return { ok: false, status: 404, error: "BOOKING_NOT_FOUND" };
      const sameTelegram = actor.telegramId && booking.clientTelegramId === actor.telegramId;
      const samePhone = phone && normalizePhone(booking.clientPhone) === phone;
      if (!sameTelegram && !samePhone) {
        return { ok: false, status: 403, error: "FORBIDDEN" };
      }
      const startUtcMs = toUtcMsForMoscowDateTime(booking.date, booking.start);
      const diffMs = startUtcMs - nowUtcMs();
      if (diffMs < 24 * 60 * 60 * 1000) {
        return {
          ok: false,
          status: 422,
          error: "CANCEL_WINDOW_CLOSED",
          message: "Отменить запись можно не позднее, чем за 24 часа до начала. Напишите мастеру для уточнения."
        };
      }
      booking.status = STATUS_CANCELLED;
      booking.updatedAt = new Date().toISOString();
      await notifyMasterAboutBooking(store, booking, actor, "cancelled");
      return { ok: true, booking: serializeBookingForClient(booking) };
    });

    return sendJson(res, result.status || 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/master/day-config") {
    const body = {};
    const actor = getActorFromRequest(req, url, body);
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const date = ensureString(url.searchParams.get("date"));
    if (!validateIsoDate(date)) return sendJson(res, 400, { ok: false, error: "INVALID_DATE" });
    const store = await loadStore();
    const config = getDayConfig(store, date);
    return sendJson(res, 200, { ok: true, date, config });
  }

  if (req.method === "POST" && url.pathname === "/api/master/day-config") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const date = ensureString(body.date);
    if (!validateIsoDate(date)) return sendJson(res, 400, { ok: false, error: "INVALID_DATE" });

    const result = await withStoreMutate(async (store) => {
      const workStart = ensureString(body.workStart || store.meta.defaultWorkStart);
      const workEnd = ensureString(body.workEnd || store.meta.defaultWorkEnd);
      const isDayOff = Boolean(body.isDayOff);
      const excludes = Array.isArray(body.excludes)
        ? body.excludes
            .map((item) => ({
              start: ensureString(item.start),
              end: ensureString(item.end)
            }))
            .filter((item) => validateTimeString(item.start) && validateTimeString(item.end))
        : [];
      store.dayConfigs[date] = { workStart, workEnd, isDayOff, excludes };
      return { ok: true, date, config: store.dayConfigs[date] };
    });

    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/master/month-config") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const month = ensureString(body.month);
    if (!validateMonthString(month)) return sendJson(res, 400, { ok: false, error: "INVALID_MONTH" });

    const result = await withStoreMutate(async (store) => {
      const workStart = ensureString(body.workStart || store.meta.defaultWorkStart || "08:00");
      const workEnd = ensureString(body.workEnd || store.meta.defaultWorkEnd || "20:00");
      if (!validateTimeString(workStart) || !validateTimeString(workEnd)) {
        return { ok: false, status: 400, error: "INVALID_TIME" };
      }
      const dates = listDaysInMonth(month);
      for (const date of dates) {
        store.dayConfigs[date] = {
          workStart,
          workEnd,
          isDayOff: false,
          excludes: []
        };
      }
      return { ok: true, month, updatedDays: dates.length };
    });

    return sendJson(res, result.status || 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/master/day-bookings") {
    const actor = getActorFromRequest(req, url, {});
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const date = ensureString(url.searchParams.get("date"));
    if (!validateIsoDate(date)) return sendJson(res, 400, { ok: false, error: "INVALID_DATE" });
    const store = await loadStore();
    const items = store.bookings
      .filter((booking) => booking.date === date)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((booking) => ({
        id: booking.id,
        timeRange: `${booking.start}-${booking.end}`,
        durationMinutes: booking.durationMinutes,
        clientName: booking.clientName,
        clientPhone: booking.clientPhone,
        status: booking.status
      }));
    return sendJson(res, 200, { ok: true, items });
  }

  if (req.method === "GET" && url.pathname === "/api/master/free-days") {
    const actor = getActorFromRequest(req, url, {});
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const store = await loadStore();
    const month = parseMonthOrCurrent(url.searchParams.get("month"));
    const duration = sanitizeDuration(url.searchParams.get("duration"), store.meta.defaultDurationMinutes || 60);
    const availableDatesIso = getAvailableDaysForMonth(store, month, duration);
    return sendJson(res, 200, {
      ok: true,
      month,
      duration,
      availableDatesIso,
      availableDays: availableDatesIso.map((item) => Number(item.slice(-2)))
    });
  }

  if (req.method === "GET" && url.pathname === "/api/master/free-slots") {
    const actor = getActorFromRequest(req, url, {});
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const store = await loadStore();
    const date = ensureString(url.searchParams.get("date"));
    if (!validateIsoDate(date)) return sendJson(res, 400, { ok: false, error: "INVALID_DATE" });
    const duration = sanitizeDuration(url.searchParams.get("duration"), store.meta.defaultDurationMinutes || 60);
    const slots = getSlotsForDay(store, date, duration).map((slot) => `${slot.start}-${slot.end}`);
    return sendJson(res, 200, { ok: true, date, duration, slots });
  }

  if (req.method === "GET" && url.pathname === "/api/master/bookings") {
    const actor = getActorFromRequest(req, url, {});
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const statusRaw = ensureString(url.searchParams.get("status"));
    const status = normalizeStatusInput(statusRaw);
    const store = await loadStore();
    let items = [...store.bookings];
    if (statusRaw && statusRaw.toLowerCase() !== "all") {
      items = status
        ? items.filter((booking) => booking.status === status)
        : [];
    }
    items.sort((a, b) => {
      if (a.date === b.date) return a.start.localeCompare(b.start);
      return a.date.localeCompare(b.date);
    });
    items.reverse();
    return sendJson(res, 200, {
      ok: true,
      items: items.map((booking) => ({
        id: booking.id,
        date: formatDateRu(booking.date),
        dateIso: booking.date,
        timeRange: `${booking.start}-${booking.end}`,
        durationMinutes: booking.durationMinutes,
        clientName: booking.clientName,
        clientPhone: booking.clientPhone,
        status: booking.status
      }))
    });
  }

  if (req.method === "POST" && url.pathname === "/api/master/update-booking-status") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const bookingId = ensureString(body.bookingId);
    const nextStatus = normalizeStatusInput(body.status);
    if (!bookingId || !nextStatus) return sendJson(res, 400, { ok: false, error: "INVALID_INPUT" });
    const allowedStatuses = [STATUS_PENDING, STATUS_CONFIRMED, STATUS_COMPLETED, STATUS_CANCELLED, STATUS_REBOOKED_BY_MASTER, STATUS_REJECTED];
    if (!allowedStatuses.includes(nextStatus)) {
      return sendJson(res, 400, { ok: false, error: "INVALID_STATUS" });
    }
    const result = await withStoreMutate(async (store) => {
      const booking = store.bookings.find((item) => item.id === bookingId);
      if (!booking) return { ok: false, status: 404, error: "BOOKING_NOT_FOUND" };
      booking.status = nextStatus;
      booking.updatedAt = new Date().toISOString();
      if (nextStatus === STATUS_CONFIRMED) {
        await notifyClientBookingConfirmed(booking);
      } else if (booking.clientTelegramId) {
        await sendTelegramMessage(
          booking.clientTelegramId,
          `Статус вашей записи обновлен: ${formatBookingCompact(booking)}\nНовый статус: ${booking.status}`
        );
      }
      return { ok: true, booking };
    });
    return sendJson(res, result.status || 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/master/reschedule-booking") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const bookingId = ensureString(body.bookingId);
    const newDate = ensureString(body.newDate);
    const newStart = ensureString(body.newStart);
    const newDuration = sanitizeDuration(body.newDuration || body.duration, 60);
    if (!bookingId || !validateIsoDate(newDate) || !validateTimeString(newStart)) {
      return sendJson(res, 400, { ok: false, error: "INVALID_INPUT" });
    }

    const result = await withStoreMutate(async (store) => {
      const current = store.bookings.find((item) => item.id === bookingId);
      if (!current) return { ok: false, status: 404, error: "BOOKING_NOT_FOUND" };
      const slots = getSlotsForDay(store, newDate, newDuration);
      const slot = slots.find((item) => item.start === newStart);
      if (!slot) {
        return {
          ok: false,
          status: 409,
          error: "SLOT_ALREADY_REQUESTED",
          message: "На это время уже отправлена заявка."
        };
      }
      current.status = STATUS_REBOOKED_BY_MASTER;
      current.updatedAt = new Date().toISOString();

      const newBooking = {
        id: generateId("booking"),
        clientTelegramId: current.clientTelegramId,
        clientUsername: current.clientUsername,
        clientName: current.clientName,
        clientPhone: current.clientPhone,
        date: newDate,
        start: slot.start,
        end: slot.end,
        durationMinutes: newDuration,
        status: STATUS_CONFIRMED,
        reminders: { h24SentAt: null, h2SentAt: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rescheduledByMasterFromBookingId: current.id
      };
      store.bookings.push(newBooking);
      if (newBooking.clientTelegramId) {
        await sendTelegramMessage(
          newBooking.clientTelegramId,
          `Ваша запись перезаписана мастером.\nНовая запись: ${formatBookingCompact(newBooking)}\nСтатус: ${newBooking.status}`
        );
      }
      return {
        ok: true,
        previousBooking: serializeBookingForClient(current),
        newBooking: serializeBookingForClient(newBooking)
      };
    });

    return sendJson(res, result.status || 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/master/reply-client") {
    const body = await parseBody(req);
    const actor = getActorFromRequest(req, url, body);
    if (!assertMasterRole(actor)) return sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    const bookingId = ensureString(body.bookingId);
    const text = ensureString(body.text);
    if (!bookingId || !text) return sendJson(res, 400, { ok: false, error: "INVALID_INPUT" });
    const result = await withStoreMutate(async (store) => {
      const booking = store.bookings.find((item) => item.id === bookingId);
      if (!booking) return { ok: false, status: 404, error: "BOOKING_NOT_FOUND" };
      if (!booking.clientTelegramId || booking.clientTelegramId.startsWith("web_")) {
        return {
          ok: false,
          status: 422,
          error: "CLIENT_TELEGRAM_UNAVAILABLE",
          message: "Клиент отправил заявку из веб-режима без Telegram-чата."
        };
      }
      await sendTelegramMessage(booking.clientTelegramId, `Сообщение от мастера:\n${text}`);
      return { ok: true };
    });
    return sendJson(res, result.status || 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/telegram/webhook") {
    const body = await parseBody(req);
    await withStoreMutate(async (store) => {
      const callbackQuery = body.callback_query;
      const message = body.message;

      if (callbackQuery?.data?.startsWith("contact_master:")) {
        await handleClientContactMasterCallback(store, callbackQuery);
      } else if (callbackQuery?.data?.startsWith("approve_booking:")) {
        await handleMasterApproveBooking(store, callbackQuery);
      } else if (callbackQuery?.data?.startsWith("reply_client:")) {
        await handleMasterReplyStart(store, callbackQuery);
      } else if (callbackQuery?.data?.startsWith("bot_") || callbackQuery?.data === "noop") {
        await handleBotBookingCallback(store, callbackQuery);
      } else if (message?.chat?.id) {
        const chatId = String(message.chat.id);
        const messageText = ensureString(message.text);
        const actor = {
          telegramId: chatId,
          username: ensureString(message.from?.username),
          firstName: ensureString(message.from?.first_name),
          lastName: ensureString(message.from?.last_name),
          role: resolveRoleFromIdentity(chatId, message.from?.username)
        };
        upsertUser(store, actor);
        if (messageText.toLowerCase().startsWith("/start")) {
          await sendStartMessage(chatId);
          return { ok: true };
        }
        const pending = store.meta.pendingMasterReplies[chatId];
        if (pending && messageText) {
          if (!pending.clientTelegramId || pending.clientTelegramId.startsWith("web_")) {
            delete store.meta.pendingMasterReplies[chatId];
            await sendTelegramMessage(chatId, "Клиент в веб-режиме: прямой ответ в Telegram недоступен.");
            return { ok: true };
          }
          await sendTelegramMessage(pending.clientTelegramId, `Сообщение от мастера:\n${messageText}`);
          delete store.meta.pendingMasterReplies[chatId];
          await sendTelegramMessage(chatId, "Ответ клиенту отправлен.");
        }
        if (messageText) {
          await handleBotBookingMessage(store, chatId, messageText, actor);
        }
      }
      return { ok: true };
    });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/dev/reset") {
    const body = await parseBody(req);
    if (body?.confirm !== "RESET") {
      return sendJson(res, 400, { ok: false, error: "RESET_CONFIRM_REQUIRED" });
    }
    const baseline = createDefaultStore();
    await saveStore(baseline);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/dev/run-jobs") {
    await runPeriodicJobs();
    return sendJson(res, 200, { ok: true, ran: "periodic_jobs" });
  }

  return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(WEB_DIR, safePath);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }
  if (!existsSync(filePath)) return false;
  const info = await stat(filePath);
  if (!info.isFile()) return false;
  const extension = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[extension] || "application/octet-stream";
  const content = await readFile(filePath);
  res.writeHead(200, { "Content-Type": mimeType });
  res.end(content);
  return true;
}

async function runPeriodicJobs() {
  await withStoreMutate(async (store) => {
    const nowMs = nowUtcMs();
    for (const booking of store.bookings) {
      const startMs = toUtcMsForMoscowDateTime(booking.date, booking.start);
      if (booking.status === STATUS_CONFIRMED) {
        const diff = startMs - nowMs;
        if (diff <= 0) {
          booking.status = STATUS_COMPLETED;
          booking.updatedAt = new Date().toISOString();
          continue;
        }
        if (!booking.reminders) booking.reminders = { h24SentAt: null, h2SentAt: null };
        if (!booking.reminders.h24SentAt && diff <= 24 * 60 * 60 * 1000 && diff > 23 * 60 * 60 * 1000) {
          await notifyClientWithReminder(store, booking, 24);
          booking.reminders.h24SentAt = new Date().toISOString();
          booking.updatedAt = new Date().toISOString();
        }
        if (!booking.reminders.h2SentAt && diff <= 2 * 60 * 60 * 1000 && diff > 1 * 60 * 60 * 1000) {
          await notifyClientWithReminder(store, booking, 2);
          booking.reminders.h2SentAt = new Date().toISOString();
          booking.updatedAt = new Date().toISOString();
        }
      }
    }
    return { ok: true };
  });
}

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const method = req.method || "GET";
  const host = req.headers.host || "localhost";
  const rawUrl = req.url || "/";
  let pathForLog = rawUrl;
  res.on("finish", () => {
    logEvent("info", "http_request", {
      requestId,
      method,
      path: pathForLog,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  try {
    const url = new URL(rawUrl, `http://${host}`);
    pathForLog = url.pathname;
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }
    const served = await serveStatic(res, url.pathname);
    if (!served) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  } catch (error) {
    logEvent("error", "request_failed", {
      requestId,
      method,
      path: pathForLog,
      error: String(error)
    });
    sendJson(res, 500, { ok: false, error: "INTERNAL_ERROR", detail: String(error) });
  }
});

server.listen(PORT, () => {
  logEvent("info", "server_started", { port: PORT });
});

setInterval(() => {
  runPeriodicJobs().catch((error) => {
    logEvent("error", "periodic_job_error", { error: String(error) });
  });
}, 60 * 1000);

process.on("unhandledRejection", (reason) => {
  logEvent("error", "unhandled_rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  logEvent("error", "uncaught_exception", { error: String(error) });
});

