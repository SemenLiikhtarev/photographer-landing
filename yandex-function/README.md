# Функция приёма заявок

Node.js-функция для Yandex Cloud Functions: принимает заявку с сайта и дописывает строку в Excel-файл на Яндекс Диске.

Зависимостей нет — файл `index.js` можно вставить в редактор кода Yandex Cloud как есть.

## Переменные окружения

| Переменная | Обязательно | Пример | Назначение |
| --- | --- | --- | --- |
| `YANDEX_DISK_TOKEN` | да | `y0_Ag...` | OAuth-токен с правами `cloud_api:disk.read` и `cloud_api:disk.write` |
| `YANDEX_DISK_FOLDER` | нет | `disk:/Заявки` | Путь к существующей папке на Диске |
| `YANDEX_DISK_FILE` | нет | `Заявки.xlsx` | Имя файла |
| `ALLOWED_ORIGINS` | нет | `https://semenliikhtarev.github.io,http://localhost:8000` | Origins через запятую; по умолчанию `*` |

## Параметры версии функции

- Среда выполнения: Node.js 20 (подойдёт и 18)
- Точка входа: `index.handler`
- Таймаут: 20 секунд
- Память: 256 МБ
- Публичный доступ: включён

## Проверка

`GET https://functions.yandexcloud.net/<id>` возвращает:

```json
{ "ok": true, "service": "wedding-requests", "file": "Заявки.xlsx" }
```

`POST` с JSON-телом заявки возвращает `{ "ok": true, "row": 2 }`.

## Формат заявки

```json
{
  "name": "Анна",
  "phone": "+7 999 123-45-67",
  "email": "anna@example.com",
  "date": "2026-08-15",
  "type": "wedding",
  "typeLabel": "Свадьба",
  "message": "Хотим свадьбу в Москве",
  "consent": true,
  "company": "",
  "page": "https://semenliikhtarev.github.io/photographer-landing/"
}
```

`company` — honeypot: если поле заполнено, функция отвечает успехом, но ничего не записывает.

## Локальная проверка

Функцию можно запустить локально с mock-сервером Яндекс Диска, подменив `YANDEX_DISK_API_BASE`. В облаке эта переменная не нужна.

Подробная инструкция по токену, папке и деплою — в корневом `README.md`, раздел «Сбор заявок в Excel на Яндекс Диске».
