// マニフェストの見本の検査（FR-016・FR-017、research.md R4）。
//  - valid/ の見本は全部スキーマに合格する。
//  - invalid/ の見本は全部、expected.json のキーワードで不合格になる。
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../../", import.meta.url);
const schemaUrl = new URL(
  "crates/extensions/schema/unnotator-plugin.schema.json",
  root,
);
const fixturesUrl = new URL(
  "crates/extensions/tests/fixtures/manifests/",
  root,
);

const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));
const jsonFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

/** 見本を検査して、問題の文のリストを返す。 */
export function checkManifests({ schema, valid, invalid, expected }) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const problems = [];

  for (const [name, manifest] of Object.entries(valid)) {
    if (!validate(manifest)) {
      const keywords = (validate.errors ?? []).map(
        (e) => `${e.keyword}(${e.instancePath || "/"})`,
      );
      problems.push(
        `valid/${name}: 合格するはずが不合格: ${keywords.join(", ")}`,
      );
    }
  }
  for (const [name, manifest] of Object.entries(invalid)) {
    const want = expected[name];
    if (want === undefined) {
      problems.push(
        `invalid/${name}: expected.json に期待するキーワードが無い`,
      );
      continue;
    }
    if (validate(manifest)) {
      problems.push(`invalid/${name}: 不合格になるはずが合格してしまった`);
      continue;
    }
    const keywords = new Set((validate.errors ?? []).map((e) => e.keyword));
    if (!keywords.has(want)) {
      problems.push(
        `invalid/${name}: 期待は ${want} だが、実際の理由は ${[...keywords].join(", ")}`,
      );
    }
  }
  for (const name of Object.keys(expected)) {
    if (!(name in invalid))
      problems.push(`expected.json の ${name} に対応する見本が無い`);
  }
  return problems;
}

function loadDir(name) {
  const dir = new URL(`${name}/`, fixturesUrl);
  return Object.fromEntries(
    jsonFiles(dir)
      .filter((f) => f !== "expected.json")
      .map((f) => [f, readJson(new URL(f, dir))]),
  );
}

function main() {
  const problems = checkManifests({
    schema: readJson(schemaUrl),
    valid: loadDir("valid"),
    invalid: loadDir("invalid"),
    expected: readJson(new URL("invalid/expected.json", fixturesUrl)),
  });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log("マニフェストの見本: すべて期待どおり");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
