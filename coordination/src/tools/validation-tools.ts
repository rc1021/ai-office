import { appendAudit, publishEvent, generateId } from "../database.js";

// ── Safe math evaluator (no eval!) ──

function safeEvaluate(formula: string, values: Record<string, number>): number {
  // Replace variable names with their values
  let expression = formula;
  for (const [key, val] of Object.entries(values)) {
    expression = expression.replaceAll(key, String(val));
  }

  // Only allow digits, decimal points, spaces, and basic operators
  if (!/^[\d\s+\-*/().]+$/.test(expression)) {
    throw new Error(`Unsafe expression: ${expression}`);
  }

  // Tokenize and evaluate with shunting-yard algorithm
  return shuntingYard(expression);
}

function shuntingYard(expr: string): number {
  const tokens = expr.match(/(\d+\.?\d*|[+\-*/()])/g);
  if (!tokens) throw new Error("Empty expression");

  const output: number[] = [];
  const ops: string[] = [];
  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };

  const applyOp = () => {
    const op = ops.pop()!;
    const b = output.pop()!;
    const a = output.pop()!;
    switch (op) {
      case "+": output.push(a + b); break;
      case "-": output.push(a - b); break;
      case "*": output.push(a * b); break;
      case "/":
        if (b === 0) throw new Error("Division by zero");
        output.push(a / b);
        break;
    }
  };

  for (const token of tokens) {
    if (/^\d/.test(token)) {
      output.push(parseFloat(token));
    } else if (token === "(") {
      ops.push(token);
    } else if (token === ")") {
      while (ops.length > 0 && ops[ops.length - 1] !== "(") applyOp();
      ops.pop(); // remove "("
    } else {
      while (
        ops.length > 0 &&
        ops[ops.length - 1] !== "(" &&
        (precedence[ops[ops.length - 1]] ?? 0) >= (precedence[token] ?? 0)
      ) {
        applyOp();
      }
      ops.push(token);
    }
  }

  while (ops.length > 0) applyOp();
  return output[0];
}

// ── validate_numeric (#14/#15) ──

export function validateNumeric(params: {
  agent_id: string;
  trace_id: string;
  value: number;
  field_name: string;
  expected_range?: { min: number; max: number };
  cross_check_formula?: string;
  cross_check_values?: Record<string, number>;
  tolerance_pct?: number;
  baseline?: number;
}): {
  valid: boolean;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
} {
  const checks: Array<{ check: string; passed: boolean; detail: string }> = [];

  // Range check
  if (params.expected_range) {
    const { min, max } = params.expected_range;
    const inRange = params.value >= min && params.value <= max;
    checks.push({
      check: "range",
      passed: inRange,
      detail: inRange
        ? `${params.value} is within [${min}, ${max}]`
        : `${params.value} is OUTSIDE [${min}, ${max}]`,
    });
  }

  // Cross-check formula
  if (params.cross_check_formula && params.cross_check_values) {
    try {
      const expected = safeEvaluate(params.cross_check_formula, params.cross_check_values);
      const diff = Math.abs(params.value - expected);
      const tolerance = Math.abs(expected) * 0.0001; // 0.01% default
      const passed = diff <= tolerance;
      checks.push({
        check: "cross_check",
        passed,
        detail: passed
          ? `${params.field_name} = ${params.value} matches formula result ${expected}`
          : `${params.field_name} = ${params.value} != formula result ${expected} (diff: ${diff})`,
      });
    } catch (err) {
      checks.push({
        check: "cross_check",
        passed: false,
        detail: `Formula evaluation failed: ${(err as Error).message}`,
      });
    }
  }

  // Tolerance vs baseline
  if (params.baseline !== undefined && params.tolerance_pct !== undefined) {
    const deviation = params.baseline !== 0
      ? Math.abs((params.value - params.baseline) / params.baseline) * 100
      : params.value === 0 ? 0 : 100;
    const passed = deviation <= params.tolerance_pct;
    checks.push({
      check: "baseline_tolerance",
      passed,
      detail: passed
        ? `${deviation.toFixed(2)}% deviation from baseline ${params.baseline} (within ${params.tolerance_pct}%)`
        : `${deviation.toFixed(2)}% deviation from baseline ${params.baseline} EXCEEDS ${params.tolerance_pct}% tolerance`,
    });
  }

  const allPassed = checks.every((c) => c.passed);

  if (!allPassed) {
    appendAudit(params.agent_id, params.trace_id, "validation.failed",
      `Numeric validation failed for ${params.field_name}: ${checks.filter(c => !c.passed).map(c => c.detail).join("; ")}`);
  }

  return { valid: allPassed, checks };
}

// ── cross_verify (#15: dual-agent independent verification) ──

export function crossVerify(params: {
  task_id: string;
  trace_id: string;
  field_name: string;
  agent_a: string;
  value_a: number;
  agent_b: string;
  value_b: number;
  tolerance_pct?: number;
}): {
  match: boolean;
  difference_pct: number;
  detail: string;
} {
  const tolerance = params.tolerance_pct ?? 0.01;
  const avg = (Math.abs(params.value_a) + Math.abs(params.value_b)) / 2;
  const diff = Math.abs(params.value_a - params.value_b);
  const diffPct = avg !== 0 ? (diff / avg) * 100 : (diff === 0 ? 0 : 100);
  const match = diffPct <= tolerance;

  const detail = match
    ? `${params.field_name}: ${params.agent_a}=${params.value_a}, ${params.agent_b}=${params.value_b} — match (${diffPct.toFixed(4)}% diff)`
    : `${params.field_name}: ${params.agent_a}=${params.value_a}, ${params.agent_b}=${params.value_b} — MISMATCH (${diffPct.toFixed(4)}% diff, tolerance ${tolerance}%)`;

  appendAudit("system", params.trace_id, "cross_verify",
    `${params.field_name}: ${match ? "MATCH" : "MISMATCH"} — ${params.agent_a}=${params.value_a} vs ${params.agent_b}=${params.value_b}`);

  if (!match) {
    publishEvent(generateId("evt"), "verification.failed", "system", "role:_leader", {
      task_id: params.task_id,
      field_name: params.field_name,
      agent_a: params.agent_a,
      value_a: params.value_a,
      agent_b: params.agent_b,
      value_b: params.value_b,
      difference_pct: diffPct,
    }, params.trace_id);
  }

  return { match, difference_pct: diffPct, detail };
}

// ── report_anomaly (#15) ──

export function reportAnomaly(params: {
  agent_id: string;
  trace_id: string;
  task_id?: string;
  severity: "warning" | "error" | "critical";
  description: string;
  data?: object;
}): { event_id: string; message: string } {
  const id = generateId("evt");
  publishEvent(id, "anomaly.reported", params.agent_id, "role:_leader", {
    task_id: params.task_id,
    severity: params.severity,
    description: params.description,
    data: params.data,
  }, params.trace_id);

  appendAudit(params.agent_id, params.trace_id, `anomaly.${params.severity}`, params.description);

  return { event_id: id, message: `Anomaly reported to leader: ${params.description}` };
}

// ── pipeline_gate (#14: step validation gate) ──

export function pipelineGate(params: {
  agent_id: string;
  trace_id: string;
  task_id: string;
  step_index: number;
  checks: Array<{
    name: string;
    condition: boolean;
    detail?: string;
  }>;
}): { passed: boolean; failed_checks: string[] } {
  const failed = params.checks.filter((c) => !c.condition);
  const passed = failed.length === 0;

  if (!passed) {
    const failedNames = failed.map((f) => f.name);
    appendAudit(params.agent_id, params.trace_id, "pipeline_gate.failed",
      `Task ${params.task_id} step ${params.step_index} gate failed: ${failedNames.join(", ")}`);

    publishEvent(generateId("evt"), "anomaly.reported", params.agent_id, "role:_leader", {
      task_id: params.task_id,
      step_index: params.step_index,
      severity: "error",
      description: `Pipeline gate failed: ${failedNames.join(", ")}`,
      failed_checks: failed,
    }, params.trace_id);
  } else {
    appendAudit(params.agent_id, params.trace_id, "pipeline_gate.passed",
      `Task ${params.task_id} step ${params.step_index} gate passed (${params.checks.length} checks)`);
  }

  return { passed, failed_checks: failed.map((f) => `${f.name}: ${f.detail ?? "failed"}`) };
}
