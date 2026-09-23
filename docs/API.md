# Контракт backend API v0.1

Base URL: `http://127.0.0.1:8000`. Схемы Pydantic: `backend/schemas.py`. OpenAPI: `GET /openapi.json`.

## Эндпоинты

| Метод | URL | Результат |
| --- | --- | --- |
| GET | `/api/health` | `{"ok":true}` |
| POST | `/api/analyze` | Живой `AnalysisResult` для двух загруженных DOCX |
| GET | `/api/demo` | Живой детерминированный анализ локальных редакций 8/9; 404 без файлов |

`POST /api/analyze` принимает `multipart/form-data`: обязательные поля `before_file` и `after_file`. Query `mode=deterministic|semantic` опционален; по умолчанию используется `ANALYSIS_MODE` или `deterministic`. Имена загруженных файлов очищаются от пути. Совпадающие имена получают префиксы `BEFORE_`/`AFTER_` для однозначности evidence.

```powershell
$before = (Get-ChildItem data -Filter '*_8_*.docx').FullName
$after = (Get-ChildItem data -Filter '*_9_*.docx').FullName
curl.exe --fail-with-body -X POST 'http://127.0.0.1:8000/api/analyze?mode=deterministic' `
  -F "before_file=@$before" -F "after_file=@$after" --output artifacts\api-comparison.json
```

## AnalysisResult

| Поле | Содержание |
| --- | --- |
| `analysis_id` | Идентификатор входов, режима и версии pipeline; это не ID сохранённой задачи |
| `before_document`, `after_document` | Имена источников |
| `units` | Все подразделения обеих сторон; различать по `document` |
| `transformations` | Рёбра между ID подразделений: `PRESERVED`, `CREATED`, `REMOVED`, `RENAMED`, `SPLIT`, `MERGED` |
| `function_matches` | ID функций и статусы `PRESERVED`, `MOVED`, `CHANGED`, `LOST` |
| `findings` | Кандидаты `LOST`, `MOVED`, `DUPLICATED`, `OVERLAP`, `CONFLICT`, `CREATED` с источниками и рекомендациями |
| `summary` | Числа кандидатов, проверяемое сводное заключение; в semantic также `analytical_note`, `note_evidence`, `note_verification_status` |
| `analysis_mode` | Фактически выполненный режим |
| `agent_trace` | Безопасные статусы выполненных стадий, без скрытых рассуждений |
| `warnings` | Ограничения извлечения и проверки |
| `clauses_before`, `clauses_after` | Количество извлечённых фрагментов, включая заголовки и текст без номера |

`before_unit`, `after_unit`, `before_function`, `after_function` — **ID**, не названия. Функции находятся в `units[].functions`. Отсутствующая сторона — `null`. Разделение/объединение представлено несколькими рёбрами; подразделения следует считать по уникальным ID. Числа 0 в summary не доказывают отсутствие рисков вне покрытия извлечения.

Каждая функция содержит оригинальный `source_text`, `section`, `document`, `clause_id`, `kind` и `ownership_evidence`. Источник назначения функции иногда находится в родительском пункте. `normalized_function` предназначен для сопоставления, а не для показа как цитаты.

Evidence:

```json
{
  "document": "before.docx",
  "section": "5.1.1",
  "text": "5.1.1. Организует закупки оборудования.",
  "clause_id": "<ID исходного фрагмента>"
}
```

Это синтетический пример. В живом ответе текст и ID берутся из загруженного документа. `section` может быть `null`, если в источнике нет номера.

`confidence` — оценка алгоритма или модели, не калиброванная вероятность. Не используйте её вместо `verification_status`. Все `findings` и `summary.analytical_note` в MVP требуют проверки. `VERIFIED` доступен только для строго проверенных наблюдений сохранения названия/функции. Интерфейсу следует показывать статус рядом с каждым выводом и предоставлять его evidence.

## Ошибки

При ошибках документа/модели:

```json
{"error":{"code":"semantic_not_configured","message":"Semantic analysis requires OPENAI_API_KEY and OPENAI_MODEL environment variables."}}
```

| HTTP | code | Причина |
| --- | --- | --- |
| 422 | `invalid_document` | Не DOCX, повреждённый/пустой документ или превышение ограничения файла |
| 404 | `demo_not_available` | Контрольные DOCX отсутствуют или неоднозначны |
| 503 | `semantic_not_configured` | Не настроен ключ или ID модели |
| 503 | `semantic_invalid_configuration` | Недопустимые символы или пробелы в ключе/ID модели |
| 503 | `semantic_authentication_failed` | OpenAI отклонил ключ |
| 503 | `semantic_model_unavailable` | Модель недоступна API-проекту |
| 503 | `semantic_rate_limited` | Ограничение частоты запросов или квоты |
| 503 | `semantic_unavailable` | Прочая ошибка OpenAI API или соединения |
| 504 | `semantic_timeout` | OpenAI не ответил в пределах таймаута 120 секунд |
| 503 | `invalid_configuration` | Неверный `ANALYSIS_MODE` на сервере |
| 502 | `semantic_invalid_output` | Незавершённый ответ, отказ модели, некорректный JSON или нарушение схемы |
| 413 | `semantic_input_too_large` | Слишком большой payload для семантического MVP |

Ошибки параметров запроса (нет файла, неверный query `mode`) возвращаются в стандартном формате FastAPI `{"detail":[...]}`, HTTP 422. Ответ не содержит секретов, сырого тела ошибки провайдера или трассировки.

Семантический запрос не повторяется автоматически. Ошибка модели не заменяется успешным детерминированным ответом. Клиенту для семантического режима нужен таймаут больше 120 секунд; HTTP smoke использует 150 секунд.

CORS по умолчанию допускает `http://localhost:3000` и `http://localhost:5173`. Другие origin задаются через `CORS_ORIGINS` (через запятую).
