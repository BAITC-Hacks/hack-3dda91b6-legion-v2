# PRODUCT5: одинаковые, переставленные и повреждённые DOCX

Проверено 23.09.2026 через настоящий локальный backend на `http://127.0.0.1:8000`. Во всех запросах явно указан `mode=deterministic`: OpenAI не вызывался, ключи и документы организатора не использовались. Входы — синтетические `known-before.docx` и `known-after.docx`, созданные `scripts.smoke_known_answer`.

Три браузерных сценария добавлены в [tests/robustness.spec.ts](../tests/robustness.spec.ts): одинаковый физический DOCX с источниками и Markdown, обратное направление сравнения, повреждённый DOCX с успешной заменой файла на той же странице без Reset и перезагрузки. Они отправляют настоящие файлы в deterministic backend без перехвата ответов. Полный прогон: 21 браузерный тест и 79 frontend unit-тестов прошли; production build успешен. Ниже отдельно приведены HTTP-наблюдения и обнаруженная ошибка сопоставления CORE. Backend и код интерфейса в этой работе не изменены.

## Результаты HTTP-проверок

| Сценарий | Наблюдаемый результат |
| --- | --- |
| Один и тот же `known-before.docx` в обоих полях, одинаковый путь и имя | HTTP 200; имена источников `BEFORE_known-before.docx` / `AFTER_known-before.docx`; 4 → 4 подразделения, 4 сохранённых преобразования и 4 сохранённых функции. Created, removed, moved, lost, duplications и conflicts равны 0. |
| Один и тот же `known-after.docx` в обоих полях | HTTP 200; 5 → 5 подразделений, 5 сохранённых преобразований и 7 сохранённых функций. Created, removed, moved и lost равны 0. Сохраняются 1 сигнал дублирования и 1 потенциальный конфликт, уже существующие внутри этого документа; это не новые изменения реорганизации. Оба вывода — `NEEDS_REVIEW`. |
| Пара переставлена: `known-after.docx` → `known-before.docx` | HTTP 200; 5 → 4 подразделения, имена и стороны источников соответствуют перестановке. Перенос отчёта о закупочных рисках корректно направлен из BEFORE `5.2.2` в AFTER `5.1.2`. Ниже зафиксировано отдельное ограничение сопоставления одинаковых функций разных владельцев. |
| Непустые повреждённые байты с именем `corrupt.docx` | HTTP 422, `error.code=invalid_document`. Следующий запрос с корректной исходной парой возвращает HTTP 200 и тот же результат, что до ошибки. |

Проверены документ, `clause_id`, номер и исходный текст всех переданных evidence: 40 вхождений для одинакового BEFORE, 70 для одинакового AFTER, 71 для обратной пары, 69 для обычной пары и повторного запроса после ошибки. Все ссылки соответствуют разобранным исходным DOCX. Пустых объяснений в этих успешных ответах нет; все findings сохраняют `NEEDS_REVIEW`.

Полные ответы и сводка находятся только в игнорируемом `artifacts/product5-review/`; они не коммитятся. Эти числа относятся к данному синтетическому примеру, а не к общей точности продукта.

## P2: ложный кандидат LOST при обратном сопоставлении

В обратной паре один и тот же текст проверки исполнения договоров находится у двух владельцев BEFORE: у департамента снабжения в `5.1.2` и у департамента контроля в `5.2.1`. AFTER сохраняет эту функцию у департамента контроля в `5.2.1` с тем же текстом.

Текущий алгоритм сначала сопоставляет снабжение с контролем и расходует единственного кандидата AFTER. Затем неизменённая функция контроля получает `LOST`:

| BEFORE | Наблюдаемое сопоставление | AFTER |
| --- | --- | --- |
| Департамент снабжения, `5.1.2` | `MOVED` | Департамент контроля, `5.2.1` |
| Департамент контроля, `5.2.1` | `LOST` | Нет соответствия, хотя функция того же владельца и с тем же текстом присутствует в AFTER `5.2.1` |

Ожидается, что точное совпадение текста и владельца контроля `5.2.1` → `5.2.1` будет сохранено прежде, чем другой владелец займёт этот кандидат. Поэтому полученные для обратной пары `moved_functions=3` и `lost_functions=4` включают артефакт сопоставления; их нельзя считать подтверждёнными изменениями ответственности.

Причина: [backend/comparison.py:50](../backend/comparison.py#L50) упорядочивает исходные функции по наличию точного текста без глобального приоритета того же владельца. Цикл в строке 51 выбирает кандидата, а [строка 64](../backend/comparison.py#L64) удаляет его из оставшихся соответствий. Приоритет владельца внутри локальной сортировки строки 53 не защищает совпадение для ещё не обработанной функции.

Последующий шаг для CORE: рассмотреть резервирование точных совпадений текста и владельца по всему набору перед межподразделенческими сопоставлениями. В PRODUCT5 backend не исправляется. Статус `NEEDS_REVIEW` и корректные цитаты сохранены, но сами по себе не делают этот кандидат правильным.

## Самодостаточное воспроизведение ограничения

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

На проверенной версии последние две строки: `same_control_owner_and_text: True` и `unchanged_control_preserved: False`. Ранее воспроизведённый ответ сохранён в `artifacts/product5-review/reversed.json`; там же находится отдельный скрипт с проверяющим assertion, `repro-reversed-match.py`.
