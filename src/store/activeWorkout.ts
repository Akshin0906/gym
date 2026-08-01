import { create } from 'zustand'

interface ActiveWorkoutState {
  sessionId: string | null
  setActiveSession: (id: string | null) => void
}

export const useActiveWorkout = create<ActiveWorkoutState>((set) => ({
  sessionId: null,
  setActiveSession: (id) => set({ sessionId: id }),
}))
