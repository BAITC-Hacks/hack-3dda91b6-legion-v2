"""Conservative rule extraction from structural lists and responsibility contexts."""

from hashlib import sha256
import re

from .parser import Clause, ParsedDocument, NUMBER, LETTER
from .schemas import Evidence, FunctionItem, OrganizationalUnit


UNIT_START = re.compile(r"^(?:Департамент|Отдел|Управление|Служба|Блок|Бюро|Центр|Department|Division|Unit)\b", re.I)
ALIAS = re.compile(r"\((?:далее\s*[-–—]?\s*)?([А-ЯЁA-Z][А-ЯЁA-Z0-9-]{1,14})\)")
STRUCTURE = re.compile(r"состоит из|включает следующие.*подразделени|структур[ауы].*подразделени|consists of", re.I)
ACTION = re.compile(r"обеспеч|осуществ|провод|проведен|разраб|организ|контрол|провер|оценк|анализ|мониторинг|согласов|утвержд|подготавли|подготовк|взаимодейств|формир|участи|аудит|рассматр|запраш|manage|review|audit|monitor|approve|report", re.I)


def stable_id(*parts: str) -> str:
    return sha256("\x00".join(parts).encode()).hexdigest()[:20]


def content(text: str) -> str:
    return LETTER.sub("", NUMBER.sub("", text, count=1), count=1).strip()


def normalize(text: str) -> str:
    # Keep negation and all meaningful words. Numbering alone does not define identity.
    return re.sub(r"[^\w]+", " ", content(text).casefold().replace("ё", "е")).strip()


def evidence(doc: ParsedDocument, clause: Clause) -> Evidence:
    return Evidence(document=doc.name, section=clause.section, text=clause.text, clause_id=clause.id)


def extract_org_units(doc: ParsedDocument) -> list[OrganizationalUnit]:
    units = {}
    parent = None
    in_structure = False

    def add(name, clause, parent_name=None, aliases=None):
        key = normalize(name)
        if key not in units:
            units[key] = OrganizationalUnit(
                id=stable_id(doc.name, doc.sha256, key), name=name,
                document=doc.name, section=clause.section, parent=parent_name,
                aliases=aliases or [], evidence=[evidence(doc, clause)],
            )
        return units[key]

    # Short self-definition, not every mention of an external department or job title.
    for clause in doc.clauses:
        body = content(clause.text)
        definition = re.match(r"([А-ЯЁA-Z][А-ЯЁA-Z0-9-]{1,14})\s+является\s+(?:функциональным\s+)?(?:блоком|подразделением|департаментом|службой)", body)
        if definition:
            parent = add(definition[1], clause, aliases=[definition[1]])
        if STRUCTURE.search(body) and body.endswith(":"):
            in_structure = True
            # A structural list may itself define its parent without a self-definition.
            owner = re.match(r"([А-ЯЁA-Z][А-ЯЁA-Z0-9-]{1,14})\s+состоит из", body)
            if owner:
                parent = add(owner[1], clause, aliases=[owner[1]])
            continue
        if in_structure and UNIT_START.match(body):
            aliases = ALIAS.findall(body)
            name = ALIAS.sub("", body).strip().rstrip(".;:").strip()
            add(name, clause, parent.name if parent else None, aliases)
            continue
        if in_structure:
            in_structure = False
        # Explicit department headings can define units in other regulations.
        if clause.heading and UNIT_START.match(body) and len(body) < 180:
            aliases = ALIAS.findall(body)
            add(ALIAS.sub("", body).strip().rstrip(".;:"), clause, aliases=aliases)
    return list(units.values())


def _mentioned_units(text: str, units: list[OrganizationalUnit]):
    folded = text.casefold().replace("ё", "е")
    found = []
    for unit in units:
        aliases = [a.casefold() for a in unit.aliases]
        if any(re.search(rf"(?<!\w){re.escape(a)}(?!\w)", folded) for a in aliases):
            found.append(unit)
            continue
        # Compare the descriptive part to handle департамент/департамента inflection.
        name = unit.name.casefold().replace("ё", "е")
        tail = name.split(" ", 1)[-1]
        if len(tail) > 8 and tail in folded:
            found.append(unit)
    children = [u for u in found if u.parent is not None]
    return children or found


def extract_functions(doc: ParsedDocument, units: list[OrganizationalUnit]) -> list[FunctionItem]:
    functions = []
    contexts = {}
    top_heading = None
    roots = [u for u in units if u.parent is None]
    structural_parents = {e.section.rsplit(".", 1)[0] for u in units if u.parent for e in u.evidence if e.section}
    for clause in doc.clauses:
        if clause.section is None:
            continue
        body = content(clause.text)
        numeric_parts = clause.section.split(".")
        if clause.heading:
            top_heading = clause
            if UNIT_START.match(body):
                matched = [u for u in units if any(e.clause_id == clause.id for e in u.evidence)]
                if matched:
                    contexts[clause.section] = (matched, clause, "FUNCTION", True)
            continue
        is_context = body.endswith(":") and len(numeric_parts) <= 3
        if is_context:
            ancestors = [key for key in contexts if clause.section.startswith(key + ".")]
            inherited = contexts[max(ancestors, key=len)] if ancestors else None
            owners = _mentioned_units(body, units)
            explicit = bool(owners)
            if not owners and re.search(r"директор[ыа]? департамент|руководители подразделени", body, re.I):
                owners = [u for u in units if u.parent is not None]
                # Collective scope is deliberately tentative.
                explicit = False
            if not owners and inherited:
                owners, _, _, explicit = inherited
            kind = "PROHIBITION" if re.search(r"не имеют права|запрещ|не вправе", body, re.I) else "RIGHT" if "имеют право" in body or "имеет право" in body else inherited[2] if inherited else "FUNCTION"
            contexts[clause.section] = (owners or roots, clause, kind, explicit)
            continue
        if clause.section in structural_parents:
            continue
        parents = [key for key in contexts if clause.section.startswith(key + ".")]
        context = contexts[max(parents, key=len)] if parents else None
        if context is None and top_heading and re.search(r"задач|функци|обязанност|responsibilit", top_heading.text, re.I):
            context = (roots, top_heading, "FUNCTION", False)
        if context is None or not ACTION.search(body) or UNIT_START.match(body):
            continue
        owners, owner_clause, kind, explicit = context
        if STRUCTURE.search(owner_clause.text) or re.search(r"подчиняются|составе следующих должностей", owner_clause.text, re.I):
            continue
        if len(body) < 12:
            continue
        for unit in owners:
            function = FunctionItem(
                id=stable_id(unit.id, clause.id), unit_name=unit.name,
                normalized_function=normalize(clause.text), source_text=clause.text,
                section=clause.section, document=doc.name, clause_id=clause.id, kind=kind,
                ownership_evidence=[evidence(doc, contexts[key][1]) for key in sorted(parents, key=len)] or [evidence(doc, owner_clause)],
                ownership_status="VERIFIED" if explicit else "NEEDS_REVIEW",
            )
            unit.functions.append(function)
            functions.append(function)
    return functions
