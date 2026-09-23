# PRODUCT5: исторический дефект и повторная проверка CORE4

## Версии и область проверки

**Историческая версия PRODUCT5:** `83fe37c`, backend унаследован от `integration/checkpoint-3` (`d3dd502`). Именно к ней относятся исходный ложный `LOST`, результат `True / False` и числа исторических проверок ниже. Они не описывают поведение исправленного backend CORE4.

**Версия повторной проверки PRODUCT6:** `codex/product-6`, merge `82d6eb4` объединяет PRODUCT5 `83fe37c` с CORE4 `16eb9cf`. Изменения CORE и его самостоятельные проверки описаны в [CORE4_HANDOFF.md](CORE4_HANDOFF.md). Локальная повторная проверка PRODUCT приведена в конце отчёта: исходный repro теперь даёт `True / True` и сохраняет функцию контроля у прежнего владельца.

Историческая проверка выполнена 23.09.2026 через настоящий локальный backend на `http://127.0.0.1:8000`. Во всех запросах явно указан `mode=deterministic`: OpenAI не вызывался, ключи и документы организатора не использовались. Входы — синтетические `known-before.docx` и `known-after.docx`, созданные `scripts.smoke_known_answer`.

В PRODUCT5 три браузерных сценария добавлены в [tests/robustness.spec.ts](../tests/robustness.spec.ts): одинаковый физический DOCX с источниками и Markdown, обратное направление сравнения, повреждённый DOCX с успешной заменой файла на той же странице без Reset и перезагрузки. Они отправляли настоящие файлы в deterministic backend без перехвата ответов. Исторический полный прогон PRODUCT5: 21 браузерный тест и 79 frontend unit-тестов прошли; production build успешен. Backend и код интерфейса в PRODUCT5 не изменялись.

## Исторические HTTP-наблюдения PRODUCT5 (`83fe37c`)

| Сценарий | Наблюдаемый результат |
| --- | --- |
| Один и тот же `known-before.docx` в обоих полях, одинаковый путь и имя | HTTP 200; имена источников `BEFORE_known-before.docx` / `AFTER_known-before.docx`; 4 → 4 подразделения, 4 сохранённых преобразования и 4 сохранённых функции. Created, removed, moved, lost, duplications и conflicts равны 0. |
| Один и тот же `known-after.docx` в обоих полях | HTTP 200; 5 → 5 подразделений, 5 сохранённых преобразований и 7 сохранённых функций. Created, removed, moved и lost равны 0. Сохраняются 1 сигнал дублирования и 1 потенциальный конфликт, уже существующие внутри этого документа; это не новые изменения реорганизации. Оба вывода — `NEEDS_REVIEW`. |
| Пара переставлена: `known-after.docx` → `known-before.docx` | HTTP 200; 5 → 4 подразделения, имена и стороны источников соответствуют перестановке. Перенос отчёта о закупочных рисках корректно направлен из BEFORE `5.2.2` в AFTER `5.1.2`. Ниже зафиксировано отдельное ограничение сопоставления одинаковых функций разных владельцев. |
| Непустые повреждённые байты с именем `corrupt.docx` | HTTP 422, `error.code=invalid_document`. Следующий запрос с корректной исходной парой возвращает HTTP 200 и тот же результат, что до ошибки. |

Проверены документ, `clause_id`, номер и исходный текст всех переданных evidence: 40 вхождений для одинакового BEFORE, 70 для одинакового AFTER, 71 для обратной пары, 69 для обычной пары и повторного запроса после ошибки. Все ссылки соответствуют разобранным исходным DOCX. Пустых объяснений в этих успешных ответах нет; все findings сохраняют `NEEDS_REVIEW`.

Полные ответы и сводка находятся только в игнорируемом `artifacts/product5-review/`; они не коммитятся. Эти числа относятся к данному синтетическому примеру, а не к общей точности продукта.

## Исторический P2: ложный LOST на backend из `d3dd502`

В обратной паре один и тот же текст проверки исполнения договоров находится у двух владельцев BEFORE: у департамента снабжения в `5.1.2` и у департамента контроля в `5.2.1`. AFTER сохраняет эту функцию у департамента контроля в `5.2.1` с тем же текстом.

Алгоритм этой версии сначала сопоставлял снабжение с контролем и расходовал единственного кандидата AFTER. Затем неизменённая функция контроля получала `LOST`:

| BEFORE | Наблюдаемое сопоставление | AFTER |
| --- | --- | --- |
| Департамент снабжения, `5.1.2` | `MOVED` | Департамент контроля, `5.2.1` |
| Департамент контроля, `5.2.1` | `LOST` | Нет соответствия, хотя функция того же владельца и с тем же текстом присутствует в AFTER `5.2.1` |

Ожидается, что точное совпадение текста и владельца контроля `5.2.1` → `5.2.1` будет сохранено прежде, чем другой владелец займёт этот кандидат. Поэтому полученные для обратной пары `moved_functions=3` и `lost_functions=4` включают артефакт сопоставления; их нельзя считать подтверждёнными изменениями ответственности.

Причина в `backend/comparison.py` **версии `d3dd502`**: строка 50 упорядочивала исходные функции по наличию точного текста без глобального приоритета того же владельца. Цикл в строке 51 выбирал кандидата, строка 64 удаляла его из оставшихся соответствий. Приоритет владельца внутри локальной сортировки строки 53 не защищал совпадение для ещё не обработанной функции. Эти номера строк относятся к исторической версии; исходник можно посмотреть командой `git show d3dd502:backend/comparison.py`.

Рекомендация PRODUCT5 для CORE была такой: резервировать точные совпадения текста и владельца по всему набору перед межподразделенческими сопоставлениями. В PRODUCT5 backend не исправлялся. Статус `NEEDS_REVIEW` и корректные цитаты сами по себе не делали ошибочный кандидат правильным.

## Исходный самодостаточный repro — без изменений

Из корня репозитория, с установленными зависимостями `.venv` и уже запущенным локальным backend, выполнить в PowerShell. Команда сама создаёт синтетическую пару в ignored-каталоге и отправляет её в обратном порядке; организаторские DOCX и ключ не нужны.

```powershell
@'
import json
from pathlib import Path
import httpx
from scripts.smoke_known_answer import generate_pair

original_before, original_after = generate_pair(Path('artifacts/product5-repro'))
with httpx.Client(base_url='http://127.0.0.1:8000', timeout=30, trust_env=False) as client:
    response = client.post('/api/analyze?mode=deterministic', files={
        'before_file': (original_after.name, original_after.read_bytes()),
        'after_file': (original_before.name, original_before.read_bytes()),
    })
response.raise_for_status()
result = response.json()
functions = {f['id']: f for unit in result['units'] for f in unit['functions']}
for match in result['function_matches']:
    left = functions[match['before_function']]
    if left['section'] not in ('5.1.2', '5.2.1'):
        continue
    right = functions.get(match['after_function'])
    print(json.dumps({
        'status': match['status'],
        'before_owner': left['unit_name'], 'before_section': left['section'],
        'before_text': left['source_text'],
        'after_owner': right['unit_name'] if right else None,
        'after_section': right['section'] if right else None,
        'after_text': right['source_text'] if right else None,
    }, ensure_ascii=False))
control_before = next(f for f in functions.values() if f['document'] == result['before_document'] and f['section'] == '5.2.1')
control_after = next(f for f in functions.values() if f['document'] == result['after_document'] and f['section'] == '5.2.1')
print('same_control_owner_and_text:', control_before['unit_name'] == control_after['unit_name'] and control_before['normalized_function'] == control_after['normalized_function'])
print('unchanged_control_preserved:', any(m['before_function'] == control_before['id'] and m['after_function'] == control_after['id'] and m['status'] == 'PRESERVED' for m in result['function_matches']))
'@ | .\.venv\Scripts\python.exe -X utf8 -
```

**Исторический результат PRODUCT5 `83fe37c` / backend `d3dd502`:** последние две строки — `same_control_owner_and_text: True` и `unchanged_control_preserved: False`. Ранее воспроизведённый ответ сохранён локально в ignored `artifacts/product5-review/reversed.json`; там же находился отдельный скрипт с проверяющим assertion, `repro-reversed-match.py`. Эти артефакты относятся к старому запуску и не подтверждают поведение CORE4.

## Повторная проверка CORE4 в PRODUCT6 (`82d6eb4`)

23.09.2026 исходный heredoc выше извлечён и выполнен **без изменений** на заново запущенном локальном CORE4 `16eb9cf`. Запрос использует синтетические DOCX и явный `mode=deterministic`; OpenAI не вызывается. Сохранённый блок также автоматически сравнен с отчётом из `83fe37c`: содержимое совпадает при нормализации переводов строк.

| Проверка | PRODUCT5 `83fe37c`, backend `d3dd502` | PRODUCT6 `82d6eb4`, CORE4 `16eb9cf` |
| --- | --- | --- |
| `same_control_owner_and_text` | `True` | `True` |
| `unchanged_control_preserved` | `False` | `True` |
| Контроль BEFORE `5.2.1` | `LOST`, без соответствия | `PRESERVED / VERIFIED` → контроль AFTER `5.2.1`, тот же исходный текст |
| Снабжение BEFORE `5.1.2` | `MOVED` → контроль AFTER `5.2.1` | `LOST`, без соответствия AFTER |

Новый вывод исходного repro:

```text
same_control_owner_and_text: True
unchanged_control_preserved: True
```

Конкретный ложный `LOST` неизменённого назначения контроля больше не воспроизводится. Оставшийся `LOST` назначения снабжения не доказывает исчезновение функции из организации: она сохраняется у контроля, а изменение распределения ответственности требует экспертной проверки. Исправление этого случая не является оценкой общей точности сопоставления.

### Повторные HTTP-проверки и типы полномочий

Через настоящий deterministic backend отправлены обратная known-answer пара и три отдельные синтетические пары с одинаковым документом в BEFORE/AFTER. Все четыре запроса вернули HTTP 200. Сверены `source_text` с текстом разобранного пункта и каждое evidence по документу, ID, номеру и точному тексту.

| Сценарий PRODUCT6 | Наблюдаемый результат CORE4 |
| --- | --- |
| Обратная known-answer пара | 5 → 4 подразделения; created 1, removed 2, moved 2, lost 4. Контроль `5.2.1` сохранён; 7 findings со статусом `NEEDS_REVIEW`. Все 67 вхождений evidence соответствуют источникам. Исторические PRODUCT5 moved 3 и 71 источник больше не описывают этот ответ. |
| Право + обычная функция | В обеих редакциях `5.1.1` — `RIGHT`, `5.1.2` — `FUNCTION`; 3 → 3 подразделения, 2 сопоставления `PRESERVED / VERIFIED`, 0 findings и кандидатов `CONFLICT`; 24 вхождения evidence проверены. |
| Запрет + обычная функция | В обеих редакциях `5.1.1` — `PROHIBITION`, `5.1.2` — `FUNCTION`; 3 → 3 подразделения, 2 сопоставления `PRESERVED / VERIFIED`, 0 findings и кандидатов `CONFLICT`; 24 вхождения evidence проверены. |
| Право + запрет + обычная функция в одном списке | В обеих редакциях последовательно `RIGHT`, `PROHIBITION`, `FUNCTION`; 3 → 3 подразделения, 3 сопоставления `PRESERVED / VERIFIED`, 0 кандидатов `CONFLICT`; 30 вхождений evidence проверены. |

В проверенных списках локальное право или запрет не меняет тип следующей обычной функции: соседняя запись остаётся `FUNCTION`. Нулевое число конфликтов относится только к этим синтетическим формулировкам и не доказывает отсутствие реального конфликта в произвольном документе. Это проверка конкретных случаев, не универсального разбора русской грамматики, прав и отрицаний. Полные ответы и сводка сохранены локально в ignored `artifacts/product6-review/`, включая `http-proof-summary.json`.

### Проверки сборки и тестов PRODUCT6

Подтверждённые локальные проверки повторной версии:

| Проверка | Результат PRODUCT6 |
| --- | --- |
| Backend `pytest` | 87 passed, 3 skipped: локальные DOCX организатора отсутствуют |
| Frontend unit | 79 passed |
| Production build | PASS |
| Точный исходный PRODUCT5 repro | `True / True`, неизменённая функция контроля сохранена |
| Полный `npm run test:e2e` | 23 passed, около 1,2 минуты; `LIVE_SEMANTIC_SMOKE=0`, без вызова OpenAI |

В [tests/robustness.spec.ts](../tests/robustness.spec.ts) усилен регрессионный сценарий обратной пары: проверены владелец «Департамент контроля», `5.2.1` → `5.2.1`, `PRESERVED / VERIFIED`, статус «Сохранена» в UI, оба владельца и точные основания. Добавлены два браузерных сценария «право + функция» и «запрет + функция»: настоящий HTTP-ответ сохраняет `kind` обеих редакций, обе записи сопоставлены как `PRESERVED`, ложный `CONFLICT` отсутствует. В UI проверены нулевые счётчики, полный текст и исходные цитаты с пунктами и документами. В этих сценариях запросы и ответы API не подменяются.

Существующие мобильные проверки, восстановление после HTTP 422 на той же странице и скачивание Markdown также прошли в полном прогоне. Визуально проверены новые панели источников сохранённой функции контроля, права и запрета; дефектов в этих проверках не обнаружено. Снимки сохранены в ignored `test-results/` с именами `swapped-preserved-control-sources.png`, `right-right-sources.png`, `prohibition-prohibition-sources.png`.

Это отдельный прогон PRODUCT6. Его результаты не подменяются числами из исторического PRODUCT5 или самостоятельного CORE4 handoff. Вывод точного repro сохранён локально в ignored `artifacts/product6-review/product5-exact-repro-output.txt`; артефакт не коммитится. Повторные локальные проверки не использовали документы организатора или настоящий Astra и не оценивают общую точность модели.
