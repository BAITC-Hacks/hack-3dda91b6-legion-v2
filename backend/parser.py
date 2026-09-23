"""Deterministic DOCX extraction. Source text is never normalized or rewritten."""

from dataclasses import dataclass, field
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import re
from zipfile import BadZipFile, ZipFile

from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph
from lxml.etree import XMLSyntaxError, XPath


MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_XML_BYTES = 40 * 1024 * 1024
NUMBER = re.compile(r"^\s*(\d+(?:\.\d+)*)(?:[.)](?=\s|[A-Za-zА-Яа-яЁё])|\s+(?=\S))")
LETTER = re.compile(r"^\s*([а-яёa-z])[.)]\s+", re.I)
INLINE_NUMBER = re.compile(r"(?<=[.!?])\s+(\d+\.\d+(?:\.\d+)*)\.(?=\s|[A-Za-zА-Яа-яЁё])")


class DocumentError(ValueError):
    pass


@dataclass(frozen=True)
class Clause:
    id: str
    section: str | None
    text: str
    paragraph_index: int
    heading: bool = False


@dataclass
class ParsedDocument:
    name: str
    sha256: str
    clauses: list[Clause]
    paragraph_count: int
    warnings: list[str] = field(default_factory=list)


def _xpath(element, path):
    # Some numbering children are plain lxml elements, without python-docx's
    # automatic namespace injection.
    return XPath(path, namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"})(element)


def _value(element, path, default=None):
    nodes = _xpath(element, path)
    return nodes[0].get(qn("w:val"), default) if nodes else default


class WordNumbering:
    """Resolve explicit/style numbering and common Word multilevel counters."""

    def __init__(self, doc):
        try:
            self.root = doc.part.numbering_part.element
        except KeyError:
            self.root = None
        self.counters = {}
        self.warnings = set()

    def label(self, paragraph):
        if self.root is None:
            return None
        sources = [paragraph._p]
        style = paragraph.style
        seen = set()
        while style is not None and style.style_id not in seen:
            seen.add(style.style_id)
            sources.append(style.element)
            style = style.base_style
        num_id = level = None
        for source in sources:
            num_id = num_id if num_id is not None else _value(source, "./w:pPr/w:numPr/w:numId")
            level = level if level is not None else _value(source, "./w:pPr/w:numPr/w:ilvl")
        if num_id in (None, "0"):
            return None
        level = int(level or 0)
        nums = _xpath(self.root, f'./w:num[@w:numId="{int(num_id)}"]')
        if not nums:
            self.warnings.add("Unresolved Word numbering; affected sections remain unknown.")
            return None
        num = nums[0]
        abstract_id = _value(num, "./w:abstractNumId")
        abstracts = _xpath(self.root, f'./w:abstractNum[@w:abstractNumId="{int(abstract_id)}"]')
        if not abstracts:
            self.warnings.add("Unresolved Word numbering definition.")
            return None
        levels = {}
        for index in range(9):
            override = _xpath(num, f'./w:lvlOverride[@w:ilvl="{index}"]')
            items = _xpath(override[0], "./w:lvl") if override else []
            items = items or _xpath(abstracts[0], f'./w:lvl[@w:ilvl="{index}"]')
            if items:
                item = items[0]
                start = int(_value(item, "./w:start", "1"))
                if override:
                    start = int(_value(override[0], "./w:startOverride", str(start)))
                levels[index] = (item, start)
        if level not in levels:
            self.warnings.add("Unsupported Word numbering level.")
            return None
        counters = self.counters.setdefault(num_id, {})
        counters[level] = counters.get(level, levels[level][1] - 1) + 1
        for deeper in list(counters):
            if deeper > level and deeper in levels:
                restart = int(_value(levels[deeper][0], "./w:lvlRestart", str(deeper)))
                if restart and level <= restart - 1:
                    del counters[deeper]
        template = _value(levels[level][0], "./w:lvlText", "")
        if _value(levels[level][0], "./w:numFmt") == "bullet":
            return None
        try:
            def substitute(match):
                index = int(match[1]) - 1
                item, start = levels[index]
                value = counters.get(index, start)
                fmt = _value(item, "./w:numFmt", "decimal")
                if fmt == "decimal":
                    return str(value)
                if fmt in ("lowerLetter", "upperLetter") and 1 <= value <= 26:
                    return chr((97 if fmt == "lowerLetter" else 65) + value - 1)
                raise ValueError("unsupported numbering")
            return re.sub(r"%([1-9])", substitute, template).strip().rstrip(".)") or None
        except (KeyError, ValueError):
            self.warnings.add("Unsupported Word numbering format; section inherited from its parent.")
            return None


def extract_clauses(doc, digest: str) -> tuple[list[Clause], int, list[str]]:
    numbering = WordNumbering(doc)
    clauses = []
    section = None
    count = 0
    in_contents = False
    for index, node in enumerate(doc.element.body.iter(qn("w:p"))):
        # Paragraphs in table cells occur in this same XML/document order.
        if any(a.tag == qn("w:p") for a in node.iterancestors()):
            continue
        paragraph = Paragraph(node, doc._body)
        text = paragraph.text
        if not text.strip():
            continue
        count += 1
        style_name = paragraph.style.name.lower() if paragraph.style is not None else ""
        if text.strip().casefold() in ("содержание", "оглавление", "table of contents"):
            in_contents = True
            continue
        if style_name.startswith("toc"):
            continue
        if in_contents:
            # A TOC entry ends with a page number, including flattened DOCX TOCs.
            if re.search(r"\s\d+\s*$", text):
                continue
            in_contents = False
        word_label = numbering.label(paragraph)
        starts = [0]
        if NUMBER.match(text):
            starts += [m.start(1) for m in INLINE_NUMBER.finditer(text)]
        starts.append(len(text))
        for left, right in zip(starts, starts[1:]):
            fragment = text[left:right]
            numeric = NUMBER.match(fragment)
            letter = LETTER.match(fragment)
            if numeric:
                section = numeric[1]
                fragment_section = section
            elif word_label:
                fragment_section = word_label
                if word_label[0].isdigit():
                    section = word_label
                elif section:
                    fragment_section = f"{section}.{word_label}"
            elif letter and section:
                fragment_section = f"{section}.{letter[1]}"
            else:
                fragment_section = section
            clauses.append(Clause(
                id=f"{digest[:12]}:p{index}:o{left}",
                section=fragment_section,
                text=fragment,
                paragraph_index=index,
                heading="heading" in style_name,
            ))
    return clauses, count, sorted(numbering.warnings)


def parse_document(source: str | Path | bytes, name: str | None = None) -> ParsedDocument:
    if isinstance(source, (str, Path)):
        path = Path(source)
        if path.stat().st_size > MAX_FILE_BYTES:
            raise DocumentError("DOCX exceeds the 10 MiB limit.")
        raw = path.read_bytes()
        name = name or path.name
    else:
        raw = source
    name = (name or "document.docx").replace("\\", "/").rsplit("/", 1)[-1]
    if not name.lower().endswith(".docx"):
        raise DocumentError("Only DOCX documents are supported.")
    if len(raw) > MAX_FILE_BYTES:
        raise DocumentError("DOCX exceeds the 10 MiB limit.")
    try:
        with ZipFile(BytesIO(raw)) as archive:
            if sum(i.file_size for i in archive.infolist()) > MAX_XML_BYTES:
                raise DocumentError("Uncompressed DOCX exceeds the 40 MiB limit.")
            if "word/document.xml" not in archive.namelist():
                raise DocumentError("The upload is not a Word DOCX document.")
        doc = Document(BytesIO(raw))
        digest = sha256(raw).hexdigest()
        clauses, count, warnings = extract_clauses(doc, digest)
    except (BadZipFile, KeyError, XMLSyntaxError, ValueError, TypeError) as exc:
        if isinstance(exc, DocumentError):
            raise
        raise DocumentError("Cannot read DOCX content; check that the file is a valid Word document.") from exc
    if not clauses:
        raise DocumentError("DOCX contains no readable paragraph or table text.")
    return ParsedDocument(name, digest, clauses, count, warnings)
