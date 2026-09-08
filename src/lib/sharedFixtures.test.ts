import { describe, expect, it } from 'vitest'
import { estimated1RM, estimated1RMForLoad, setVolumeForLoad } from './analytics'
import {
  allowsZeroLoad,
  deriveRepBounds,
  loadConventionsComparable,
  loadSemantics,
  parseRepRangeText,
  resolveRepTarget,
} from './measurement'
import { weightValidationIssue } from '../db/repositories/sessions'
import type { LoadConvention } from '../db/types'

// TypeScript half of the shared calculation contract. The Python supervisor
// asserts the same expectations in automation/tests/test_shared_fixtures.py, so
// a divergence between the two implementations fails exactly one of them.
// Imported rather than read from disk so the file is resolved and type-checked
// by the same toolchain that builds the app.
import calculations from '../../automation/shared_fixtures/calculations.json'

interface RepBoundsFixture {
  min: number
  max: number
}

interface Fixtures {
  estimatedOneRepMax: Array<{
    name: string
    weightLbs: unknown
    reps: unknown
    expected: number | null
  }>
  repRangeParsing: Array<{
    name: string
    input: unknown
    expected: RepBoundsFixture | null
  }>
  singleNumberRepTargets: Array<{
    name: string
    input: string
    expected: RepBoundsFixture | null
  }>
  structuredRepBounds: Array<{
    name: string
    plan: { targetRepRange: string; repBounds?: RepBoundsFixture | null }
    expected: RepBoundsFixture | null
    source: string
  }>
  zeroLoad: Array<{
    name: string
    weightLbs: number
    convention: LoadConvention
    valid: boolean
  }>
  loadComparability: Array<{
    left: LoadConvention
    right: LoadConvention
    comparable: boolean
  }>
  loadSemantics: Array<{
    convention: LoadConvention
    supportsTonnage: boolean
    supportsOneRepMax: boolean
    higherIsHarder: boolean
    recorded: boolean
  }>
  estimatedOneRepMaxForLoad: Array<{
    name: string
    weightLbs: number
    reps: number
    convention: string
    expected: number | null
  }>
  setVolumeForLoad: Array<{
    name: string
    weightLbs: number
    reps: number
    convention: LoadConvention
    expected: number | null
  }>
}

const fixtures = calculations as unknown as Fixtures

// The app's estimated1RM takes numbers; the fixtures also cover the untrusted
// inputs the supervisor must survive. Reject those here the same way, so
// "no valid estimate" means the same thing in both languages.
function estimateOrNull(weightLbs: unknown, reps: unknown): number | null {
  if (
    typeof weightLbs !== 'number' ||
    typeof reps !== 'number' ||
    !Number.isFinite(weightLbs) ||
    !Number.isFinite(reps) ||
    weightLbs <= 0 ||
    reps < 1
  ) {
    return null
  }
  return estimated1RM(weightLbs, reps)
}

function closeEnough(actual: number | null, expected: number | null): boolean {
  if (actual === null || expected === null) return actual === expected
  return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected))
}

describe('shared calculation fixtures', () => {
  it('loads a non-empty fixture set', () => {
    expect(fixtures.estimatedOneRepMax.length).toBeGreaterThan(0)
    expect(fixtures.repRangeParsing.length).toBeGreaterThan(0)
    expect(fixtures.loadComparability.length).toBeGreaterThan(0)
    expect(fixtures.loadSemantics.length).toBeGreaterThan(0)
  })

  it('matches every estimated one-rep-max expectation', () => {
    for (const testCase of fixtures.estimatedOneRepMax) {
      const actual = estimateOrNull(testCase.weightLbs, testCase.reps)
      expect(
        closeEnough(actual, testCase.expected),
        `${testCase.name}: ${actual} !== ${testCase.expected}`,
      ).toBe(true)
    }
  })

  it('returns a one-rep set exactly rather than inflating it', () => {
    // The concrete divergence this fixture set exists to prevent.
    expect(estimated1RM(100, 1)).toBe(100)
    expect(estimated1RM(100, 2)).toBeCloseTo(106.66666666666667, 10)
  })

  it('matches every rep-range parsing expectation', () => {
    for (const testCase of fixtures.repRangeParsing) {
      const actual = parseRepRangeText(testCase.input)
      expect(actual, testCase.name).toEqual(testCase.expected)
    }
  })

  it('derives bounds from a bare single-number target', () => {
    // Both implementations agree: a bare "10" means exactly ten reps.
    for (const testCase of fixtures.singleNumberRepTargets) {
      expect(parseRepRangeText(testCase.input), testCase.name).toEqual(
        testCase.expected,
      )
      expect(deriveRepBounds(testCase.input), testCase.name).toEqual(
        testCase.expected ?? undefined,
      )
    }
  })

  it('resolves structured rep bounds the same way the supervisor does', () => {
    for (const testCase of fixtures.structuredRepBounds) {
      const resolved = resolveRepTarget(
        testCase.plan as Parameters<typeof resolveRepTarget>[0],
      )
      expect(resolved.bounds, testCase.name).toEqual(testCase.expected)
      expect(resolved.source, testCase.name).toBe(testCase.source)
    }
  })

  it('accepts a zero load only for bodyweight and assistance', () => {
    for (const testCase of fixtures.zeroLoad) {
      const issue = weightValidationIssue(
        testCase.weightLbs,
        testCase.convention,
      )
      expect(issue === null, testCase.name).toBe(testCase.valid)
      expect(allowsZeroLoad(testCase.convention), testCase.name).toBe(
        testCase.convention === 'bodyweight' ||
          testCase.convention === 'assistance',
      )
    }
    // Non-finite is rejected for every convention.
    expect(weightValidationIssue(Number.NaN, 'bodyweight')).not.toBeNull()
    expect(weightValidationIssue(Number.POSITIVE_INFINITY, 'total')).not.toBeNull()
  })

  it('matches every load comparability expectation', () => {
    for (const testCase of fixtures.loadComparability) {
      expect(
        loadConventionsComparable(testCase.left, testCase.right),
        `${testCase.left}/${testCase.right}`,
      ).toBe(testCase.comparable)
    }
  })

  it('matches every load semantics expectation', () => {
    for (const testCase of fixtures.loadSemantics) {
      const semantics = loadSemantics(testCase.convention)
      expect(semantics.convention, testCase.convention).toBe(
        testCase.convention,
      )
      expect(semantics.supportsTonnage, testCase.convention).toBe(
        testCase.supportsTonnage,
      )
      expect(semantics.supportsOneRepMax, testCase.convention).toBe(
        testCase.supportsOneRepMax,
      )
      expect(semantics.higherIsHarder, testCase.convention).toBe(
        testCase.higherIsHarder,
      )
      expect(semantics.recorded, testCase.convention).toBe(testCase.recorded)
    }
  })

  it('matches every convention-aware one-rep-max expectation', () => {
    for (const testCase of fixtures.estimatedOneRepMaxForLoad) {
      // An unrecognised convention string must fall back to `unknown` rather
      // than throwing, exactly as the supervisor's coercion does.
      const convention = testCase.convention as LoadConvention
      const actual = estimated1RMForLoad(
        testCase.weightLbs,
        testCase.reps,
        (loadSemantics(
          fixtures.loadSemantics.some((s) => s.convention === convention)
            ? convention
            : 'unknown',
        ).convention),
      )
      expect(
        closeEnough(actual, testCase.expected),
        `${testCase.name}: ${actual} !== ${testCase.expected}`,
      ).toBe(true)
    }
  })

  it('matches every convention-aware tonnage expectation', () => {
    for (const testCase of fixtures.setVolumeForLoad) {
      const actual = setVolumeForLoad(
        testCase.weightLbs,
        testCase.reps,
        testCase.convention,
      )
      expect(
        closeEnough(actual, testCase.expected),
        `${testCase.name}: ${actual} !== ${testCase.expected}`,
      ).toBe(true)
    }
  })
})
