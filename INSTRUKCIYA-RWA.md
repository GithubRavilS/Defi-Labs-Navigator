# DeFi Labs Navigator — инструкция (ETH / BTC / RWA)

Одна таблица на лист: **шапка в A1**, данные со **строки 2**. Скрипт больше **не** склеивает блоки A7 + H30.

---

## 1. Google Таблица

Файл: **Defi LABS Navigator** (`1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg`)

| Лист | Формат |
|------|--------|
| `ethereum`, `bitcoin` | Таблица с **A1**: Платформа, Мин/Макс диапазона, Пара, Блокчейн, fee_tier, APR, APY, Ссылка… |
| `БИТВА ПУЛОВ RWA` | То же с **A1** |

**RWA — кошелёк Jupiter:** ячейка **Z2** (ссылка `https://jup.ag/portfolio/…` или адрес). Старый **B6** тоже читается.

**Статус синхронизации RWA:** **Z3** (кошелёк **Z2**). Не писать статус в колонку D — там дата открытия.

Если RWA ещё в старом виде (блок **H30**): в таблице меню **DeFi Navigator → Перенести RWA в A1 (из H30)**  
или локально: `node scripts/migrate-rwa-to-a1.mjs`

---

## 2. Google Apps Script

1. [script.google.com](https://script.google.com) → проект навигатора.
2. Вставь **весь** файл `DeFi-Labs-Navigator-AppsScript.js`.
3. **Развёртывание → Управление → Изменить → Новая версия → Развернуть** (обязательно, иначе сайт не увидит изменения).
4. URL `/exec` — в `index.html` → `DATA_API_URL` (если менялся проект).

**Jupiter (RWA):** опционально `JUPITER_API_KEY` в Script properties ([portal.jup.ag](https://portal.jup.ag/) Free). Без ключа при 0 LP таблица **не очищается**.

---

## 3. Меню в таблице

**DeFi Navigator**

1. **Проверить файл RWA (ID в D2)** — убедиться, что пишем в нужный файл.
2. **Перенести RWA в A1** — один раз, если остался H30.
3. **Синхронизировать RWA (Jupiter)** — ручной запуск.
4. **Авто-синх RWA каждый час** — триггер.

---

## 4. Сайт (Vercel)

1. Пуш в `main` — Vercel задеплоит `index.html` + `/api/nav-data`.
2. **Vercel → Settings → Environment Variables:**
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = содержимое `pusher-490008-bf7c384ba372.json`
   - `NAVIGATOR_JWT_SECRET` — уже должен быть
3. **Redeploy** после добавления переменной.

Данные ETH/BTC/RWA идут **напрямую из Google Sheets**, не через старый GAS/PythonAnywhere.

Проверка: F12 → Network → `/api/nav-data` → в ответе `apiVersion: 4`, RWA = 8 позиций.

---

## 5. Проверка

- Листы ETH/BTC: строка 1 = `Платформа | Мин диапазона | …`
- RWA: 8 LP (Raydium/Orca), без Kamino Lending.
- Сайт: те же карточки, пары, диапазоны, APY, ссылки.

Локально: `node scripts/test-unified-getdata.mjs`

---

## Колонки (единый формат)

`Платформа` · `Мин диапазона` · `Макс диапазон` · `Дата открытия норм` · заработки · `Пара` · `Блокчейн` · `fee_tier` · `APR` · `APY` · `Ссылка` / `Link` · (опц.) `Инвестировано USD`

Период на сайте: из колонки `period` или из **даты открытия** (сколько дней с открытия).
