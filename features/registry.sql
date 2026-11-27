CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated','removed')),
  source TEXT NOT NULL DEFAULT 'manual',
  adr_ref TEXT,
  removal_reason TEXT
);

CREATE TABLE IF NOT EXISTS feature_tests (
  feature_id TEXT NOT NULL REFERENCES features(id),
  test_path TEXT NOT NULL,
  test_pattern TEXT NOT NULL,
  rung TEXT NOT NULL DEFAULT 'R2',
  PRIMARY KEY (feature_id, test_path, test_pattern)
);

CREATE TABLE IF NOT EXISTS invariants (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL,
  guard_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated','removed'))
);

CREATE TABLE IF NOT EXISTS feature_audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('added','improved','invariant_added','deprecated','removed')),
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  commit_sha TEXT
);

CREATE TRIGGER IF NOT EXISTS guard_prevent_feature_delete
BEFORE DELETE ON features
WHEN OLD.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'FEATLOCK_TRIGGER_BLOCK: Cannot DELETE active feature directly; mark status=removed with adr_ref and removal_reason.');
END;

CREATE TRIGGER IF NOT EXISTS guard_prevent_feature_test_delete
BEFORE DELETE ON feature_tests
WHEN EXISTS (SELECT 1 FROM features WHERE id = OLD.feature_id AND status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'FEATLOCK_TRIGGER_BLOCK: Cannot unlink test from an active feature without replacing coverage.');
END;

CREATE TRIGGER IF NOT EXISTS guard_prevent_invariant_delete
BEFORE DELETE ON invariants
WHEN OLD.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'FEATLOCK_TRIGGER_BLOCK: Cannot DELETE active invariant directly; mark status=removed with explicit ADR justification.');
END;

INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.core', 'core', 'core capability', 'Extracted from 6 source file(s) exporting REGISTRY_SQL_REL, REGISTRY_DB_REL, serializeRegistrySql, loadSnapshotFromSql, readSnapshotFromDb, materializeRegistryDb.', 'Exports and behaviors in core remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.examples', 'examples', 'examples capability', 'Retired non-production examples directory entry', 'Non-production fixtures excluded from active feature registry.', 'removed', 'ast', 'ADR-001', 'Exclude non-production examples/ fixtures from production feature extraction');
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin', 'plugin', 'plugin capability', 'Extracted from 2 source file(s) exporting FeatlockPlugin, definePlugin, isFeatlockPlugin, Plugin, FeatureStatus, InvariantSource.', 'Exports and behaviors in plugin remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-anti-deletion-guard', 'plugin:anti-deletion-guard', 'plugin:anti-deletion-guard capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:anti-deletion-guard remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-ast-scanner', 'plugin:ast-scanner', 'plugin:ast-scanner capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:ast-scanner remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-config', 'plugin:config', 'plugin:config capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:config remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-harnesses', 'plugin:harnesses', 'plugin:harnesses capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:harnesses remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-invariant-passes', 'plugin:invariant-passes', 'plugin:invariant-passes capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:invariant-passes remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-registry-cli', 'plugin:registry-cli', 'plugin:registry-cli capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:registry-cli remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-repospec-bridge', 'plugin:repospec-bridge', 'plugin:repospec-bridge capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:repospec-bridge remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.plugin-veristack-bridge', 'plugin:veristack-bridge', 'plugin:veristack-bridge capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in plugin:veristack-bridge remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO features (id, area, name, summary, acceptance_criteria, status, source, adr_ref, removal_reason) VALUES ('feat.src', 'src', 'src capability', 'Extracted from 1 source file(s).', 'Exports and behaviors in src remain covered by linked tests and preserve extracted invariants.', 'active', 'ast', NULL, NULL);
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.core', 'tests/plugin-architecture/runtime.test.ts', 'FeatLock Plugin Runtime, Fault Isolation, Guarded Policy & Demo Toggle ON/OFF', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.core', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.core', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.core', 'tests/registry-and-guards.test.ts', 'SQLite Anti-Deletion Triggers, Git Diff Guards, Dup Detection & Agent Passes [REQ-FLK-GUARD-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-anti-deletion-guard', 'tests/plugin-architecture/runtime.test.ts', 'FeatLock Plugin Runtime, Fault Isolation, Guarded Policy & Demo Toggle ON/OFF', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-anti-deletion-guard', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-anti-deletion-guard', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-anti-deletion-guard', 'tests/registry-and-guards.test.ts', 'SQLite Anti-Deletion Triggers, Git Diff Guards, Dup Detection & Agent Passes [REQ-FLK-GUARD-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-ast-scanner', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-ast-scanner', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-config', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-config', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-config', 'tests/registry-and-guards.test.ts', 'SQLite Anti-Deletion Triggers, Git Diff Guards, Dup Detection & Agent Passes [REQ-FLK-GUARD-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-harnesses', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-harnesses', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-invariant-passes', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-invariant-passes', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-invariant-passes', 'tests/registry-and-guards.test.ts', 'SQLite Anti-Deletion Triggers, Git Diff Guards, Dup Detection & Agent Passes [REQ-FLK-GUARD-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-registry-cli', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-registry-cli', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-repospec-bridge', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-repospec-bridge', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-veristack-bridge', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin-veristack-bridge', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin', 'tests/plugin-architecture/runtime.test.ts', 'FeatLock Plugin Runtime, Fault Isolation, Guarded Policy & Demo Toggle ON/OFF', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.plugin', 'tests/registry-and-guards.test.ts', 'SQLite Anti-Deletion Triggers, Git Diff Guards, Dup Detection & Agent Passes [REQ-FLK-GUARD-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.src', 'tests/plugin-architecture/runtime.test.ts', 'FeatLock Plugin Runtime, Fault Isolation, Guarded Policy & Demo Toggle ON/OFF', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.src', 'tests/plugin-architecture/structural.test.ts', 'FeatLock Tight-Core & Dogfooded-Plugin Structural Laws [REQ-FLK-PLUGINS-01]', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.src', 'tests/plugins-and-bridges.test.ts', 'Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard', 'R2');
INSERT OR REPLACE INTO feature_tests (feature_id, test_path, test_pattern, rung) VALUES ('feat.src', 'tests/registry-and-guards.test.ts', 'SQLite Anti-Deletion Triggers, Git Diff Guards, Dup Detection & Agent Passes [REQ-FLK-GUARD-01]', 'R2');
INSERT OR REPLACE INTO invariants (id, feature_id, kind, statement, file, line, confidence, source, guard_ref, status) VALUES ('inv:ast:sql-trigger:packages-core-src-db-registry-ts:64', 'feat.core', 'db-trigger-guard', 'SQLite trigger aborts disallowed mutation at packages/core/src/db/registry.ts:64', 'packages/core/src/db/registry.ts', 64, 0.95, 'ast', NULL, 'active');
INSERT OR REPLACE INTO invariants (id, feature_id, kind, statement, file, line, confidence, source, guard_ref, status) VALUES ('inv:ast:sql-trigger:packages-core-src-db-registry-ts:71', 'feat.core', 'db-trigger-guard', 'SQLite trigger aborts disallowed mutation at packages/core/src/db/registry.ts:71', 'packages/core/src/db/registry.ts', 71, 0.95, 'ast', NULL, 'active');
INSERT OR REPLACE INTO invariants (id, feature_id, kind, statement, file, line, confidence, source, guard_ref, status) VALUES ('inv:ast:sql-trigger:packages-core-src-db-registry-ts:78', 'feat.core', 'db-trigger-guard', 'SQLite trigger aborts disallowed mutation at packages/core/src/db/registry.ts:78', 'packages/core/src/db/registry.ts', 78, 0.95, 'ast', NULL, 'active');
INSERT OR REPLACE INTO invariants (id, feature_id, kind, statement, file, line, confidence, source, guard_ref, status) VALUES ('inv:veristack:cp:flk-cp-001', 'feat.core', 'veristack-control-plan', 'tight-core plugin boundary and dogfooding: prevent Built-in plugins bypass @featlock/plugin or core imports feature plugins directly', 'tests/plugin-architecture/structural.test.ts', 1, 0.98, 'veristack', 'REQ-FLK-PLUGINS-01', 'active');
INSERT OR REPLACE INTO invariants (id, feature_id, kind, statement, file, line, confidence, source, guard_ref, status) VALUES ('inv:veristack:cp:flk-cp-002', 'feat.core', 'veristack-control-plan', 'SQLite anti-deletion triggers and git-diff removal guard: prevent Agents silently delete active features, unlink tests, or drop invariants', 'tests/registry-and-guards.test.ts', 1, 0.98, 'veristack', 'REQ-FLK-GUARD-01', 'active');
INSERT INTO feature_audit_log (feature_id, action, actor, summary, commit_sha) VALUES ('registry', 'added', 'featlock-extract', 'Extracted 11 feature(s), 32 test link(s), 5 invariant(s).', NULL);
INSERT INTO feature_audit_log (feature_id, action, actor, summary, commit_sha) VALUES ('feat.examples', 'removed', 'featlock-dogfood', 'ADR-001: Exclude non-production examples/ fixtures from feature extraction', NULL);
