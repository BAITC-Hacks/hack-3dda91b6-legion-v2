export type VerificationStatus = 'VERIFIED' | 'NEEDS_REVIEW'
export type TransformationType = 'PRESERVED' | 'CREATED' | 'REMOVED' | 'RENAMED' | 'SPLIT' | 'MERGED'
export type FunctionStatus = 'PRESERVED' | 'MOVED' | 'CHANGED' | 'LOST' | 'DUPLICATED'
export type FindingType = 'LOST' | 'MOVED' | 'DUPLICATED' | 'CONFLICT' | 'CREATED'
export type Severity = 'INFO' | 'MEDIUM' | 'HIGH'

export interface Evidence {
  document: string
  section: string
  text: string
}

export interface Unit {
  id: string
  name: string
  revision: 'before' | 'after'
  functions_count: number
}

export interface Transformation {
  id: string
  before_unit: string | null
  after_unit: string | null
  type: TransformationType
  confidence: number
  before_evidence: Evidence[]
  after_evidence: Evidence[]
  explanation: string
  verification_status: VerificationStatus
}

export interface FunctionMatch {
  id: string
  name: string
  before_owner: string[]
  after_owner: string[]
  status: FunctionStatus
  confidence: number
  before_evidence: Evidence[]
  after_evidence: Evidence[]
  explanation: string
  recommendation: string
  verification_status: VerificationStatus
}

export interface Finding {
  id: string
  type: FindingType
  severity: Severity
  title: string
  explanation: string
  confidence: number
  verification_status: VerificationStatus
  before_evidence: Evidence[]
  after_evidence: Evidence[]
  recommendation: string
  function_ids: string[]
}

export interface AnalysisSummary {
  units_before: number
  units_after: number
  created_units: number
  removed_units: number
  moved_functions: number
  lost_functions: number
  duplications: number
  potential_conflicts: number
}

export interface AnalysisResult {
  analysis_id: string
  before_document: string
  after_document: string
  units: Unit[]
  transformations: Transformation[]
  function_matches: FunctionMatch[]
  findings: Finding[]
  summary: AnalysisSummary
}
