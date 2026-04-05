import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestDb, TestDbContext } from "./helpers/db-setup.js";
import { validateNumeric, crossVerify, pipelineGate, reportAnomaly } from "../src/tools/validation-tools.js";

describe("validateNumeric", () => {
  let ctx: TestDbContext;
  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  // -- Range checks --

  it("passes when value is within range", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 50, field_name: "revenue",
      expected_range: { min: 0, max: 100 },
    });
    expect(result.valid).toBe(true);
    expect(result.checks[0].passed).toBe(true);
  });

  it("fails when value exceeds range max", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 150, field_name: "revenue",
      expected_range: { min: 0, max: 100 },
    });
    expect(result.valid).toBe(false);
    expect(result.checks[0].detail).toContain("OUTSIDE");
  });

  it("fails when value is below range min", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: -5, field_name: "count",
      expected_range: { min: 0, max: 100 },
    });
    expect(result.valid).toBe(false);
  });

  it("passes at range boundary (inclusive)", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 100, field_name: "pct",
      expected_range: { min: 0, max: 100 },
    });
    expect(result.valid).toBe(true);
  });

  // -- Cross-check formula --

  it("passes with correct cross-check formula (simple addition)", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 5, field_name: "total",
      cross_check_formula: "a+b", cross_check_values: { a: 2, b: 3 },
    });
    expect(result.valid).toBe(true);
  });

  it("respects operator precedence in formula", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 14, field_name: "total",
      cross_check_formula: "a+b*c", cross_check_values: { a: 2, b: 3, c: 4 },
    });
    expect(result.valid).toBe(true);
  });

  it("handles parentheses in formula", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 20, field_name: "total",
      cross_check_formula: "(a+b)*c", cross_check_values: { a: 2, b: 3, c: 4 },
    });
    expect(result.valid).toBe(true);
  });

  it("fails on division by zero in formula", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 0, field_name: "ratio",
      cross_check_formula: "a/b", cross_check_values: { a: 10, b: 0 },
    });
    expect(result.valid).toBe(false);
    expect(result.checks[0].detail).toContain("Division by zero");
  });

  it("rejects unsafe expressions", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 0, field_name: "x",
      cross_check_formula: "a;process", cross_check_values: { a: 1 },
    });
    expect(result.valid).toBe(false);
    expect(result.checks[0].detail).toContain("Unsafe expression");
  });

  // -- Baseline tolerance --

  it("passes when deviation is within tolerance", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 102, field_name: "revenue",
      baseline: 100, tolerance_pct: 5,
    });
    expect(result.valid).toBe(true);
    expect(result.checks[0].detail).toContain("2.00%");
  });

  it("fails when deviation exceeds tolerance", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 120, field_name: "revenue",
      baseline: 100, tolerance_pct: 5,
    });
    expect(result.valid).toBe(false);
    expect(result.checks[0].detail).toContain("EXCEEDS");
  });

  it("handles zero baseline correctly", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 0, field_name: "delta",
      baseline: 0, tolerance_pct: 5,
    });
    expect(result.valid).toBe(true);
  });

  // -- Combined checks --

  it("fails when one of multiple checks fails", () => {
    const result = validateNumeric({
      agent_id: "test", trace_id: "t1", value: 150, field_name: "total",
      expected_range: { min: 0, max: 100 },
      baseline: 100, tolerance_pct: 100, // tolerance passes
    });
    expect(result.valid).toBe(false);
    expect(result.checks.length).toBe(2);
    expect(result.checks[0].passed).toBe(false); // range fails
    expect(result.checks[1].passed).toBe(true);   // tolerance passes
  });
});

describe("crossVerify", () => {
  let ctx: TestDbContext;
  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("matches when values are identical", () => {
    const result = crossVerify({
      task_id: "t1", trace_id: "tr1", field_name: "revenue",
      agent_a: "a1", value_a: 100, agent_b: "a2", value_b: 100,
    });
    expect(result.match).toBe(true);
    expect(result.difference_pct).toBe(0);
  });

  it("matches within tolerance", () => {
    const result = crossVerify({
      task_id: "t1", trace_id: "tr1", field_name: "revenue",
      agent_a: "a1", value_a: 100, agent_b: "a2", value_b: 100.005,
      tolerance_pct: 0.01,
    });
    expect(result.match).toBe(true);
  });

  it("mismatches when exceeding tolerance", () => {
    const result = crossVerify({
      task_id: "t1", trace_id: "tr1", field_name: "revenue",
      agent_a: "a1", value_a: 100, agent_b: "a2", value_b: 105,
      tolerance_pct: 0.01,
    });
    expect(result.match).toBe(false);
    expect(result.detail).toContain("MISMATCH");
  });

  it("handles both zero values", () => {
    const result = crossVerify({
      task_id: "t1", trace_id: "tr1", field_name: "delta",
      agent_a: "a1", value_a: 0, agent_b: "a2", value_b: 0,
    });
    expect(result.match).toBe(true);
    expect(result.difference_pct).toBe(0);
  });
});

describe("pipelineGate", () => {
  let ctx: TestDbContext;
  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("passes when all checks pass", () => {
    const result = pipelineGate({
      agent_id: "test", trace_id: "t1", task_id: "task-1", step_index: 0,
      checks: [
        { name: "format", condition: true },
        { name: "length", condition: true },
        { name: "schema", condition: true },
      ],
    });
    expect(result.passed).toBe(true);
    expect(result.failed_checks).toHaveLength(0);
  });

  it("fails when some checks fail", () => {
    const result = pipelineGate({
      agent_id: "test", trace_id: "t1", task_id: "task-1", step_index: 0,
      checks: [
        { name: "format", condition: true },
        { name: "length", condition: false, detail: "too short" },
        { name: "schema", condition: true },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.failed_checks).toHaveLength(1);
    expect(result.failed_checks[0]).toContain("length");
  });
});

describe("reportAnomaly", () => {
  let ctx: TestDbContext;
  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("returns event_id and message", () => {
    const result = reportAnomaly({
      agent_id: "test", trace_id: "t1", severity: "warning",
      description: "Unexpected value detected",
    });
    expect(result.event_id).toMatch(/^evt-/);
    expect(result.message).toContain("Unexpected value detected");
  });
});
