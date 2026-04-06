#!/usr/bin/env node
/**
 * review-role-template.js
 *
 * Validates role template YAML files against the JSON schema and
 * enforces default_behaviors rules. Designed to run in GitHub Actions
 * on PRs that touch roles/templates/ or roles/schemas/.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const Ajv = Ajv2020.default || Ajv2020;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = path.resolve('roles/templates');
const SCHEMA_PATH = path.resolve('roles/schemas/role-template.schema.json');

const results = { pass: [], warn: [], fail: [] };

function fail(file, msg) {
  results.fail.push({ file, msg });
  console.log(`::error file=roles/templates/${file}::${msg}`);
}

function warn(file, msg) {
  results.warn.push({ file, msg });
  console.log(`::warning file=roles/templates/${file}::${msg}`);
}

function pass(file) {
  results.pass.push(file);
}

// ---------------------------------------------------------------------------
// Collect files to validate
// ---------------------------------------------------------------------------

function getTemplateFiles() {
  // In CI with a PR, we could diff only changed files.
  // For robustness we validate ALL templates so that schema changes are
  // checked against the full set.
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.yaml'));
  return files;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function loadSchema() {
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
  return JSON.parse(raw);
}

function buildValidator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

// ---------------------------------------------------------------------------
// default_behaviors checks
// ---------------------------------------------------------------------------

function checkBehaviors(file, doc) {
  const db = doc.default_behaviors;

  if (!db) {
    fail(file, 'missing default_behaviors');
    return;
  }

  const validTypes = ['pioneering', 'steady', 'execution', 'coordination'];
  if (!validTypes.includes(db.type)) {
    fail(file, `default_behaviors.type "${db.type}" is not one of: ${validTypes.join(', ')}`);
  }

  if (!Array.isArray(db.rules) || db.rules.length === 0) {
    fail(file, 'default_behaviors.rules must be a non-empty array');
    return;
  }

  const ruleMap = {};
  for (const r of db.rules) {
    ruleMap[r.id] = r;
  }

  // must_flag_risks (overridable: false) is mandatory for ALL roles
  if (!ruleMap['must_flag_risks']) {
    fail(file, 'missing default_behaviors.rules entry for must_flag_risks (overridable: false)');
  } else if (ruleMap['must_flag_risks'].overridable !== false) {
    fail(file, 'must_flag_risks must have overridable: false');
  }

  // reject_suspicious_patterns (overridable: false) is mandatory for ALL roles
  if (!ruleMap['reject_suspicious_patterns']) {
    fail(file, 'missing default_behaviors.rules entry for reject_suspicious_patterns (overridable: false)');
  } else if (ruleMap['reject_suspicious_patterns'].overridable !== false) {
    fail(file, 'reject_suspicious_patterns must have overridable: false');
  }

  // Type-specific checks
  if (db.type === 'steady') {
    const hasMcpRule = db.rules.some(r => r.enforce === 'mcp');
    if (!hasMcpRule) {
      warn(file, 'steady type should include at least one enforce:mcp rule');
    }
  }

  if (db.type === 'coordination') {
    if (!ruleMap['must_escalate_risks']) {
      fail(file, 'coordination type must include must_escalate_risks (overridable: false)');
    } else if (ruleMap['must_escalate_risks'].overridable !== false) {
      fail(file, 'must_escalate_risks must have overridable: false for coordination type');
    }
  }
}

// ---------------------------------------------------------------------------
// Required field checks
// ---------------------------------------------------------------------------

function checkRequiredFields(file, doc) {
  if (!doc.persona || !doc.persona.role_description) {
    fail(file, 'missing persona.role_description');
  }
  if (!doc.persona || !doc.persona.expertise_areas || doc.persona.expertise_areas.length === 0) {
    fail(file, 'missing persona.expertise_areas');
  }
  if (!doc.capabilities || !doc.capabilities.primary_tasks || doc.capabilities.primary_tasks.length === 0) {
    fail(file, 'missing capabilities.primary_tasks (persona.primary_tasks)');
  }
  if (!doc.security || !doc.security.scopes || doc.security.scopes.length === 0) {
    fail(file, 'missing security.scopes');
  }
  if (!doc.security || doc.security.clearance_level === undefined) {
    fail(file, 'missing security.clearance_level');
  }
  if (!doc.department) {
    fail(file, 'missing department');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const schema = loadSchema();
  const validate = buildValidator(schema);
  const files = getTemplateFiles();

  console.log(`\nValidating ${files.length} role templates...\n`);

  for (const file of files) {
    const filepath = path.join(TEMPLATES_DIR, file);
    let content;
    let doc;

    // 1. YAML syntax check
    try {
      content = fs.readFileSync(filepath, 'utf8');
      doc = yaml.load(content);
    } catch (e) {
      fail(file, `YAML parse error: ${e.message}`);
      continue;
    }

    if (!doc || typeof doc !== 'object') {
      fail(file, 'YAML did not parse to an object');
      continue;
    }

    // 2. JSON Schema validation (warnings only — existing templates may not fully conform)
    const valid = validate(doc);
    if (!valid) {
      for (const err of validate.errors) {
        warn(file, `schema: ${err.instancePath} ${err.message}`);
      }
    }

    // 3. Required fields
    checkRequiredFields(file, doc);

    // 4. default_behaviors
    checkBehaviors(file, doc);

    // If no failures were recorded for this file, mark it passed
    const hasFailure = results.fail.some(r => r.file === file);
    const hasWarning = results.warn.some(r => r.file === file);
    if (!hasFailure && !hasWarning) {
      pass(file);
    } else if (!hasFailure) {
      // Only warnings, still counts as pass
      pass(file);
    }
  }

  // Summary
  console.log('\n========== REVIEW SUMMARY ==========\n');

  for (const f of results.fail) {
    console.log(`\u274C ${f.file}: ${f.msg}`);
  }
  for (const w of results.warn) {
    console.log(`\u26A0\uFE0F  ${w.file}: ${w.msg}`);
  }
  for (const p of results.pass) {
    console.log(`\u2705 ${p}: all checks passed`);
  }

  console.log(`\nTotal: ${files.length} files | ${results.pass.length} passed | ${results.warn.length} warnings | ${results.fail.length} errors\n`);

  if (results.fail.length > 0) {
    process.exit(1);
  }
}

main();
