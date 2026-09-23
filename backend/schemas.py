from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


VerificationStatus = Literal["VERIFIED", "NEEDS_REVIEW"]
Confidence = Annotated[float, Field(ge=0, le=1)]
TransformationType = Literal["PRESERVED", "CREATED", "REMOVED", "RENAMED", "SPLIT", "MERGED"]
FunctionStatus = Literal["PRESERVED", "MOVED", "CHANGED", "LOST"]
FindingType = Literal["LOST", "MOVED", "DUPLICATED", "OVERLAP", "CONFLICT", "CREATED"]


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Evidence(Schema):
    document: str
    section: str | None
    text: str
    clause_id: str


class FunctionItem(Schema):
    id: str
    unit_name: str
    normalized_function: str
    source_text: str
    section: str | None
    document: str
    clause_id: str
    kind: Literal["FUNCTION", "RIGHT", "PROHIBITION"] = "FUNCTION"
    ownership_evidence: list[Evidence] = Field(default_factory=list)
    ownership_status: VerificationStatus = "NEEDS_REVIEW"


class OrganizationalUnit(Schema):
    id: str
    name: str
    document: str
    section: str | None
    parent: str | None = None
    aliases: list[str] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    functions: list[FunctionItem] = Field(default_factory=list)


class Transformation(Schema):
    before_unit: str | None
    after_unit: str | None
    type: TransformationType
    confidence: Confidence
    evidence: list[Evidence] = Field(default_factory=list)
    verification_status: VerificationStatus = "NEEDS_REVIEW"
    explanation: str = ""


class FunctionMatch(Schema):
    before_function: str
    after_function: str | None
    status: FunctionStatus
    confidence: Confidence
    before_evidence: list[Evidence] = Field(default_factory=list)
    after_evidence: list[Evidence] = Field(default_factory=list)
    verification_status: VerificationStatus = "NEEDS_REVIEW"
    explanation: str = ""


class Finding(Schema):
    id: str
    type: FindingType
    severity: Literal["INFO", "MEDIUM", "HIGH"]
    title: str
    explanation: str
    confidence: Confidence
    verification_status: VerificationStatus = "NEEDS_REVIEW"
    before_evidence: list[Evidence] = Field(default_factory=list)
    after_evidence: list[Evidence] = Field(default_factory=list)
    recommendation: str


class Summary(Schema):
    units_before: int = 0
    units_after: int = 0
    created_units: int = 0
    removed_units: int = 0
    moved_functions: int = 0
    lost_functions: int = 0
    duplications: int = 0
    overlaps: int = 0
    potential_conflicts: int = 0
    verified_findings: int = 0
    needs_review_findings: int = 0
    conclusion: str = ""
    analytical_note: str | None = None
    note_evidence: list[Evidence] = Field(default_factory=list)
    note_verification_status: VerificationStatus = "NEEDS_REVIEW"


class AnalysisResult(Schema):
    analysis_id: str
    before_document: str
    after_document: str
    units: list[OrganizationalUnit]
    transformations: list[Transformation]
    function_matches: list[FunctionMatch]
    findings: list[Finding]
    summary: Summary
    analysis_mode: Literal["deterministic", "semantic"]
    agent_trace: list[str]
    warnings: list[str]
    clauses_before: int
    clauses_after: int
