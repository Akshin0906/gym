export type CoachReasoningEffort = 'medium' | 'xhigh'

export type CoachMessageRole = 'user' | 'assistant'

export interface CoachMessage {
  id: string
  sequence: number
  role: CoachMessageRole
  text: string
  createdAt: number
  reasoningEffort: CoachReasoningEffort | null
  model: string | null
  jobId: string | null
  jobStatus: string | null
}

export type CoachProposalStatus =
  | 'proposed'
  | 'applied'
  | 'failed'
  | 'dismissed'

export interface CoachProposal {
  id: string
  messageId: string
  jobId: string
  status: CoachProposalStatus
  actionPlan: unknown
  createdAt: number
  updatedAt: number
  result: unknown | null
}

export interface CoachBridgeState {
  online: boolean
  lastSeenAt: number
  status: string
  bridgeVersion: string
  model: string
  activeJobId: string | null
}

export interface CoachQueueCounts {
  queued: number
  processing: number
  proposed: number
}

export interface CoachConversationState {
  conversation: {
    id: string
    createdAt: number
    updatedAt: number
  } | null
  bridge: CoachBridgeState | null
  counts: CoachQueueCounts
  latestMessageSequence: number
}

export interface CoachTranscriptPage {
  messages: CoachMessage[]
  proposals: CoachProposal[]
  nextCursor: number
  hasMore: boolean
}

export interface PlannedExercise {
  exerciseId: string
  targetSets: number
  repRange: string
}

export type CoachAction =
  | {
      type: 'swap_active_exercise'
      sessionId: string
      fromExerciseId: string
      toExerciseId: string
      targetSets: number
      repRange: string
    }
  | {
      type: 'add_active_exercise'
      sessionId: string
      exerciseId: string
      position: number
      targetSets: number
      repRange: string
    }
  | {
      type: 'update_active_exercise_targets'
      sessionId: string
      exerciseId: string
      targetSets: number
      repRange: string
    }
  | {
      type: 'create_one_time_workout'
      name: string
      exercises: PlannedExercise[]
    }
  | {
      type: 'create_session_template'
      programId: string
      name: string
      exercises: PlannedExercise[]
    }
  | {
      type: 'create_program'
      name: string
      sessions: Array<{
        name: string
        exercises: PlannedExercise[]
      }>
    }

export type CoachActionScope =
  | 'active_workout'
  | 'one_time_workout'
  | 'program'

export interface CoachActionPlan {
  title: string
  summary: string
  scope: CoachActionScope
  sourceStateHash: string
  actions: CoachAction[]
}

export interface CoachActionChange {
  type: CoachAction['type']
  label: string
  entityId?: string
}

export interface CoachActionResult {
  proposalId: string
  appliedAt: number
  sourceStateHash: string
  replayed: boolean
  changes: CoachActionChange[]
  activeSessionId?: string
  programId?: string
  sessionTemplateId?: string
}
