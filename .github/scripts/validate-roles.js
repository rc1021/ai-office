#!/usr/bin/env node
// Validates all role template YAML files against role-template.schema.json
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const schemaPath = join(projectRoot, 'roles', 'schemas', 'role-template.schema.json');
const templatesDir = join(projectRoot, 'roles', 'templates');

if (!existsSync(schemaPath)) {
  console.error('Schema not found:', schemaPath);
  process.exit(1);
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const files = readdirSync(templatesDir).filter(f => f.endsWith('.yaml'));
let errors = 0;

for (const file of files) {
  const filePath = join(templatesDir, file);
  try {
    const data = yaml.load(readFileSync(filePath, 'utf8'));
    if (!validate(data)) {
      console.error(`❌ ${file}:`);
      validate.errors.forEach(e => console.error(`   ${e.instancePath} ${e.message}`));
      errors++;
    } else {
      console.log(`✅ ${file}`);
    }
  } catch (e) {
    console.error(`❌ ${file}: ${e.message}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n${errors} file(s) failed validation.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} role templates are valid.`);
