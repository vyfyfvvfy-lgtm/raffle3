require("dotenv").config();

const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DB_FILE = path.join(__dirname, "users.json");
const HEADLESS = process.env.HEADLESS !== "false";
const DEFAULT_INTERVAL = Number(process.env.CHECK_INTERVAL_MINUTES || 5);
const MAX_LINKS = Number(process.env.MAX_LINKS_PER_USER || 100);

const DEFAULT_URLS = [
  "https://raffles.upgrader.best/mostasd1",
  "https://raffles.upgrader.best/sistim",
  "https://raffles.upgrader.best/gaechka",
  "https://raffles.upgrader.best/d9d9",
  "https://raffles.upgrader.best/atm5",
  "https://raffles.upgrader.best/tw3",
  "https://raffles.upgrader.best/formix",
  "https://raffles.upgrader.best/d0cc",
  "https://raffles.upgrader.best/exxotgiveaway",
  "https://raffles.upgrader.best/degster",
  "https://raffles.upgrader.best/kiroki",
  "https://raffles.upgrader.best/mike4h",
  "https://raffles.upgrader.best/alex",
  "https://raffles.upgrader.best/degster",
  "https://raffles.upgrader.best/rover5",
  "https://raffles.upgrader.best/kiroki",
  "https://raffles.upgrader.best/toxaka5",
];

if (!TOKEN) {
  console.error("Заполни TELEGRAM_BOT_TOKEN в файле .env");
  process.exit(1);
}

if (!Number.isFinite(DEFAULT_INTERVAL) || DEFAULT_INTERVAL < 1) {
  console.error("CHECK_INTERVAL_MINUTES должен быть числом не меньше 1.");
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let db = { users: {} };
let browser;
let nextUpdateId = 0;
let saveQueue = Promise.resolve();

const pendingActions = new Map();
const activeChecks = new Set();

const keyboard = {
  keyboard: [
    [{ text: "📊 Статус" }, { text: "🔄 Обновить" }],
    [{ text: "🔗 Список ссылок" }],
    [{ text: "➕ Добавить ссылку" }, { text: "➖ Удалить ссылку" }],
    [{ text: "⏱ Интервал" }],
    [{ text: "⏸ Остановить" }, { text: "▶️ Возобновить" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Ошибка чтения ${file}:`, error.message);
    }
    return fallback;
  }
}

function saveDb() {
  saveQueue = saveQueue.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, DB_FILE);
  });

  return saveQueue;
}

function newUser() {
  return {
    urls: [...DEFAULT_URLS],
    intervalMinutes: DEFAULT_INTERVAL,
    enabled: true,
    state: {},
    nextCheckAt: Date.now()
  };
}

function getUser(chatId) {
  const key = String(chatId);

  if (!db.users[key]) db.users[key] = newUser();

  const user = db.users[key];

  if (!Array.isArray(user.urls)) user.urls = [...DEFAULT_URLS];
  if (!user.state || typeof user.state !== "object") user.state = {};
  if (!Number.isFinite(user.intervalMinutes) || user.intervalMinutes < 1) {
    user.intervalMinutes = DEFAULT_INTERVAL;
  }
  if (typeof user.enabled !== "boolean") user.enabled = true;
  if (!Number.isFinite(user.nextCheckAt)) user.nextCheckAt = Date.now();

  return user;
}

async function telegram(method, payload = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram HTTP ${response.status}`
    );
  }

  return result.result;
}

async function sendTelegram(chatId, message, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
    reply_markup: keyboard,
    ...extra
  });
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}


function detectStatus(rawText) {
  const text = normalizeText(rawText);

  // Проверяем количество активных розыгрышей
  const activeSection = text.match(
    /активные розыгрыши\s*:?\s*(\d+)/
  );

  if (activeSection) {
    return Number(activeSection[1]) > 0
      ? "active"
      : "inactive";
  }

  // Проверяем счётчик розыгрышей, идущих сейчас
  const activeCount = text.match(
    /(\d+)\s+идут\s+сейчас/
  );

  if (activeCount) {
    return Number(activeCount[1]) > 0
      ? "active"
      : "inactive";
  }

  if (/сейчас нет активных розыгрышей/.test(text)) {
    return "inactive";
  }

  if (/победитель уже выбран|розыгрыш завершен|розыгрыш окончен|завершенные розыгрыши/.test(text)) {
    return "inactive";
  }

  return "unknown";
}

function extractDetails(rawText, url) {
  const lines = rawText
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const title = lines.find(line =>
    line.length >= 4 &&
    line.length <= 90 &&
    !/участвовать|поделиться|как это работает|идет сейчас|организатор/i.test(line)
  );

  return {
    title: title || "Активный розыгрыш",
    url
  };
}

async function inspectPage(url) {
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  });

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    if (!response || !response.ok()) {
      throw new Error(
        `Статус страницы: ${response?.status() ?? "unknown"}`
      );
    }

    await page.waitForTimeout(1800);

    const rawText = await page.locator("body").innerText({
      timeout: 10000
    });

    return {
      status: detectStatus(rawText),
      details: extractDetails(rawText, url)
    };
  } finally {
    await page.close();
  }
}
async function checkOne(chatId, user, url) {
  try {
    const result = await inspectPage(url);
    const previous = user.state[url];

    console.log(
      `[${new Date().toLocaleString("ru-RU")}] user=${chatId} ${result.status}: ${url}`
    );

    if (result.status === "unknown") {
      return { status: "unknown" };
    }

    if (previous === "inactive" && result.status === "active") {
      await sendTelegram(
        chatId,
        `🎉 РОЗЫГРЫШ АКТИВИРОВАН!\n\n📌 ${result.details.title}\n🔗 ${url}\n\nМониторинг Upgrader`
      );
    }

    user.state[url] = result.status;
    await saveDb();

    return { status: result.status };
  } catch (error) {
    console.error(
      `Ошибка проверки ${url} для ${chatId}: ${error.message}`
    );

    return {
      status: "error",
      error: error.message
    };
  }
}

async function checkAll(chatId, manual = false) {
  const key = String(chatId);

  if (activeChecks.has(key)) {
    if (manual) {
      await sendTelegram(
        chatId,
        "⏳ Твоя проверка уже выполняется. Дождись её завершения."
      );
    }
    return;
  }

  const user = getUser(chatId);
  activeChecks.add(key);

  if (manual) {
    await sendTelegram(
      chatId,
      `🔄 Внеплановая проверка ${user.urls.length} ссылок началась.`
    );
  }

  const counts = {
    active: 0,
    inactive: 0,
    unknown: 0,
    error: 0
  };

  try {
    for (const url of [...user.urls]) {
      const result = await checkOne(chatId, user, url);

      counts[result.status] = (counts[result.status] || 0) + 1;

      await sleep(1000);
    }

    user.nextCheckAt =
      Date.now() + user.intervalMinutes * 60_000;

    await saveDb();

    if (manual) {
      await sendTelegram(
        chatId,
        `✅ Проверка завершена.\n\n🟢 Активных: ${counts.active}\n⚪ Неактивных: ${counts.inactive}\n❔ Не определено: ${counts.unknown}\n🔴 Ошибок: ${counts.error}`
      );
    }
  } finally {
    activeChecks.delete(key);
  }
}

function statusLabel(status) {
  return status === "active"
    ? "🟢 Активен"
    : status === "inactive"
      ? "⚪ Неактивен"
      : "❔ Не проверен";
}

async function showStatus(chatId, user) {
  const active = user.urls.filter(
    url => user.state[url] === "active"
  );

  const inactive = user.urls.filter(
    url => user.state[url] === "inactive"
  );

  const unknown =
    user.urls.length - active.length - inactive.length;

  await sendTelegram(
    chatId,
    `📊 Твой мониторинг\n\n${user.enabled ? "🟢 Мониторинг включён" : "⏸ Мониторинг остановлен"}\n🔗 Всего ссылок: ${user.urls.length}\n🟢 Активных: ${active.length}\n⚪ Неактивных: ${inactive.length}\n❔ Без результата: ${unknown}\n⏱ Твой интервал: ${user.intervalMinutes} мин.`
  );
}

async function showLinks(chatId, user) {
  if (!user.urls.length) {
    return sendTelegram(
      chatId,
      "Список ссылок пуст. Нажми «➕ Добавить ссылку»."
    );
  }

  const lines = user.urls.map(
    (url, i) =>
      `${i + 1}. ${statusLabel(user.state[url])}\n${url}`
  );

  await sendTelegram(
    chatId,
    `🔗 Твои отслеживаемые ссылки (${user.urls.length}):\n\n${lines.join("\n\n")}`
  );
}

function validUrl(value) {
  try {
    const u = new URL(value);

    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.hostname.length > 0
    );
  } catch {
    return false;
  }
}

async function handleText(chatId, text) {
  const user = getUser(chatId);
  const key = String(chatId);
  const action = pendingActions.get(key);

  if (action) {
    pendingActions.delete(key);

    if (action === "add") {
      const url = text.trim();

      if (!validUrl(url)) {
        return sendTelegram(
          chatId,
          "❌ Некорректная ссылка. Отправь полный адрес, начинающийся с https://"
        );
      }

      if (user.urls.includes(url)) {
        return sendTelegram(
          chatId,
          "ℹ️ Эта ссылка уже есть в твоём списке."
        );
      }

      if (user.urls.length >= MAX_LINKS) {
        return sendTelegram(
          chatId,
          `❌ Достигнут лимит: ${MAX_LINKS} ссылок на пользователя.`
        );
      }

      user.urls.push(url);
      await saveDb();

      return sendTelegram(
        chatId,
        `✅ Ссылка добавлена в твой список:\n${url}`
      );
    }

    if (action === "remove") {
      const index = Number(text.trim()) - 1;

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= user.urls.length
      ) {
        return sendTelegram(
          chatId,
          "❌ Неверный номер. Открой свой список ссылок и попробуй снова."
        );
      }

      const [removed] = user.urls.splice(index, 1);
      delete user.state[removed];

      await saveDb();

      return sendTelegram(
        chatId,
        `✅ Ссылка удалена из твоего списка:\n${removed}`
      );
    }

    if (action === "interval") {
      const minutes = Number(text.trim());

      if (
        !Number.isFinite(minutes) ||
        minutes < 1 ||
        minutes > 1440
      ) {
        return sendTelegram(
          chatId,
          "❌ Укажи число от 1 до 1440 минут."
        );
      }

      user.intervalMinutes = minutes;
      user.nextCheckAt = Date.now();

      await saveDb();

      return sendTelegram(
        chatId,
        `✅ Твой интервал изменён: каждые ${minutes} мин.`
      );
    }
  }

  switch (text.trim()) {
    case "/start":
    case "/menu":
      await saveDb();

      return sendTelegram(
        chatId,
        "🤖 Добро пожаловать в публичный мониторинг розыгрышей!\n\nУ тебя будет собственный список ссылок, интервал и личные уведомления. Настройки других пользователей тебе недоступны.\n\nВыбери действие в меню:"
      );

    case "/help":
      return sendTelegram(
        chatId,
        "Команды:\n/start — меню\n/status — статус\n/refresh — проверить сейчас\n/links — список ссылок\n/add — добавить ссылку\n/remove — удалить ссылку\n/interval — изменить интервал\n/stop — остановить проверки\n/resume — возобновить проверки"
      );

    case "📊 Статус":
    case "/status":
      return showStatus(chatId, user);

    case "🔄 Обновить":
    case "/refresh":
      return checkAll(chatId, true);

    case "🔗 Список ссылок":
    case "/links":
      return showLinks(chatId, user);

    case "➕ Добавить ссылку":
    case "/add":
      pendingActions.set(key, "add");

      return sendTelegram(
        chatId,
        `➕ Отправь ссылку для добавления.\nЛимит: ${MAX_LINKS} ссылок на пользователя.\n/cancel — отмена.`
      );

    case "➖ Удалить ссылку":
    case "/remove":
      if (!user.urls.length) {
        return sendTelegram(
          chatId,
          "Твой список ссылок пуст."
        );
      }

      pendingActions.set(key, "remove");

      return sendTelegram(
        chatId,
        `➖ Отправь номер ссылки для удаления:\n\n${user.urls.map((u, i) => `${i + 1}. ${u}`).join("\n")}\n\n/cancel — отмена.`
      );

    case "⏱ Интервал":
    case "/interval":
      pendingActions.set(key, "interval");

      return sendTelegram(
        chatId,
        `⏱ Твой текущий интервал: ${user.intervalMinutes} мин.\nОтправь новый интервал от 1 до 1440 минут.\n/cancel — отмена.`
      );

    case "⏸ Остановить":
    case "/stop":
      user.enabled = false;
      await saveDb();

      return sendTelegram(
        chatId,
        "⏸ Твой мониторинг остановлен. Другие пользователи продолжают получать уведомления. Для запуска нажми /resume."
      );

    case "▶️ Возобновить":
    case "/resume":
      user.enabled = true;
      user.nextCheckAt = Date.now();
      await saveDb();

      return sendTelegram(
        chatId,
        "▶️ Твой мониторинг возобновлён."
      );

    case "/cancel":
      pendingActions.delete(key);

      return sendTelegram(
        chatId,
        "Действие отменено."
      );

    default:
      return sendTelegram(
        chatId,
        "Не понял команду. Используй кнопки меню или /help."
      );
  }
}
async function pollTelegram() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: nextUpdateId,
        timeout: 30,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        nextUpdateId = update.update_id + 1;

        const message = update.message;

        if (!message?.text || !message.chat?.id) continue;

        if (message.chat.type !== "private") {
          await sendTelegram(
            message.chat.id,
            "Для личных списков и уведомлений открой бота в личных сообщениях и отправь /start."
          );
          continue;
        }

        await handleText(
          message.chat.id,
          message.text
        ).catch(error => {
          console.error(
            `Ошибка обработки команды пользователя ${message.chat.id}:`,
            error.message
          );

          sendTelegram(
            message.chat.id,
            `❌ Ошибка: ${error.message}`
          ).catch(() => {});
        });
      }
    } catch (error) {
      console.error(
        "Ошибка Telegram polling:",
        error.message
      );

      await sleep(3000);
    }
  }
}

async function monitorLoop() {
  while (true) {
    const now = Date.now();

    for (const [chatId, user] of Object.entries(db.users)) {
      if (
        user.enabled &&
        user.nextCheckAt <= now &&
        !activeChecks.has(chatId)
      ) {
        checkAll(chatId, false).catch(error => {
          console.error(
            `Ошибка цикла ${chatId}:`,
            error.message
          );
        });
      }
    }

    await sleep(5000);
  }
}

// Автоматическая установка Chromium
async function launchBrowser() {
  try {
    console.log("Проверяю наличие Chromium...");

    return await chromium.launch({
      headless: HEADLESS
    });

  } catch (error) {
    const browserMissing =
      error.code === "ENOENT" ||
      /chrome-headless-shell|Executable doesn't exist/i.test(
        error.message || ""
      );

    if (!browserMissing) {
      if (/\.so|shared librar|lib.*not found/i.test(error.message || "")) {
        console.error(
          "Не найдены системные библиотеки Chromium."
        );

        console.error(
          "Выполни: npx playwright install-deps chromium"
        );
      }

      throw error;
    }

    console.log(
      "Chromium отсутствует. Начинаю автоматическую установку..."
    );

    const playwrightCli = path.join(
      path.dirname(require.resolve("playwright")),
      "cli.js"
    );

    try {
      execFileSync(
        process.execPath,
        [playwrightCli, "install", "chromium"],
        {
          stdio: "inherit"
        }
      );
    } catch (installError) {
      throw new Error(
        `Не удалось установить Chromium. Выполни вручную: npx playwright install chromium. Причина: ${installError.message}`
      );
    }

    console.log(
      "Chromium установлен. Повторяю запуск..."
    );

    return await chromium.launch({
      headless: HEADLESS
    });
  }
}

// Запуск бота
async function run() {
  db = await readJson(
    DB_FILE,
    { users: {} }
  );

  if (
    !db ||
    typeof db !== "object" ||
    !db.users ||
    typeof db.users !== "object"
  ) {
    db = { users: {} };
  }

  browser = await launchBrowser();

  console.log("Chromium успешно запущен!");

  const me = await telegram("getMe");

  console.log(
    `Бот @${me.username} запущен. Пользовательских профилей: ${Object.keys(db.users).length}`
  );

  console.log(
    "Пользователи начинают работу самостоятельно командой /start."
  );

  await Promise.all([
    pollTelegram(),
    monitorLoop()
  ]);
}

run().catch(error => {
  console.error(
    "Критическая ошибка:",
    error
  );

  if (browser) {
    browser.close().catch(() => {});
  }

  process.exit(1);
});
