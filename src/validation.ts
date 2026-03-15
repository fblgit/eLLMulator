/**
 * Register deviation validation — Point 3 of Protocol V2.
 *
 * Server auto-fix model: normalizes what it can, returns diagnostics.
 * Agent registers once, no re-registration needed.
 *
 * 7 checks (finite, enumerated — see PROTOCOL_V2_PLAN.md Part 2):
 *   1. Class without className.methodName entries
 *   2. Function/method without params
 *   3. Function/method without return_type
 *   4. Unknown kind (auto-fix: type_alias → type, arrow_function → function)
 *   5. start_line > end_line
 *   6. start_line or end_line ≤ 0
 *   7. Duplicate declaration names (auto-fix: keep last)
 */

export interface Deviation {
  field: string;
  issue: string;
  sop: string;
}

/** Valid kind values in DeclarationSchema */
const VALID_KINDS = new Set([
  'class', 'method', 'function', 'type', 'struct',
  'interface', 'const', 'schema', 'enum',
]);

/** Kind aliases that get auto-fixed */
const KIND_ALIASES: Record<string, string> = {
  type_alias: 'type',
  arrow_function: 'function',
  typealias: 'type',
  arrow: 'function',
  lambda: 'function',
};

/**
 * Auto-fix declarations in-place and collect deviations.
 *
 * Mutates the `owns` and `exports` arrays directly.
 * Returns deviations found (including auto-fixed ones for transparency).
 */
export function validateAndFixDeclarations(declarations: {
  owns: any[];
  exports?: any[];
  imports?: any[];
  dependencies?: any[];
  summary?: string;
}): Deviation[] {
  const deviations: Deviation[] = [];

  // --- Auto-fix pass (mutates declarations) ---

  // Check 4: Kind normalization (auto-fix)
  for (let i = 0; i < declarations.owns.length; i++) {
    const decl = declarations.owns[i];
    if (decl.kind && !VALID_KINDS.has(decl.kind)) {
      const fixed = KIND_ALIASES[decl.kind];
      if (fixed) {
        deviations.push({
          field: `owns[${i}].kind`,
          issue: `kind '${decl.kind}' auto-fixed to '${fixed}'`,
          sop: `Use one of: ${[...VALID_KINDS].join(', ')}`,
        });
        decl.kind = fixed;
      } else {
        deviations.push({
          field: `owns[${i}].kind`,
          issue: `kind '${decl.kind}' not recognized`,
          sop: `Use one of: ${[...VALID_KINDS].join(', ')}`,
        });
      }
    }
  }

  // Also fix exports
  if (declarations.exports) {
    for (let i = 0; i < declarations.exports.length; i++) {
      const decl = declarations.exports[i];
      if (decl.kind && !VALID_KINDS.has(decl.kind)) {
        const fixed = KIND_ALIASES[decl.kind];
        if (fixed) {
          decl.kind = fixed;
          // Don't double-log — owns already caught it
        }
      }
    }
  }

  // Check 7: Duplicate names (auto-fix: keep last)
  const seen = new Map<string, number>();
  for (let i = 0; i < declarations.owns.length; i++) {
    const name = declarations.owns[i].name;
    if (seen.has(name)) {
      deviations.push({
        field: `owns[${seen.get(name)}]`,
        issue: `duplicate declaration '${name}' — keeping last occurrence at owns[${i}]`,
        sop: 'Each symbol name must be unique within a file',
      });
    }
    seen.set(name, i);
  }
  // Deduplicate: keep last occurrence of each name
  if (deviations.some(d => d.issue.startsWith('duplicate'))) {
    const deduped = new Map<string, any>();
    for (const decl of declarations.owns) {
      deduped.set(decl.name, decl);
    }
    declarations.owns = [...deduped.values()];
  }

  // --- Validation pass (deviations only, no mutation) ---

  // Check 5 & 6: Line number validation
  for (let i = 0; i < declarations.owns.length; i++) {
    const decl = declarations.owns[i];

    if (typeof decl.start_line === 'number' && typeof decl.end_line === 'number') {
      if (decl.start_line > decl.end_line) {
        deviations.push({
          field: `owns[${i}]`,
          issue: `start_line (${decl.start_line}) > end_line (${decl.end_line}) for '${decl.name}'`,
          sop: 'Verify line numbers with cat -n',
        });
      }
    }

    if (typeof decl.start_line === 'number' && decl.start_line <= 0) {
      deviations.push({
        field: `owns[${i}].start_line`,
        issue: `start_line is ${decl.start_line} for '${decl.name}'`,
        sop: 'Line numbers must be positive integers',
      });
    }

    if (typeof decl.end_line === 'number' && decl.end_line <= 0) {
      deviations.push({
        field: `owns[${i}].end_line`,
        issue: `end_line is ${decl.end_line} for '${decl.name}'`,
        sop: 'Line numbers must be positive integers',
      });
    }
  }

  // Check 1: Class without className.methodName entries
  const classes = declarations.owns.filter((d: any) => d.kind === 'class');
  for (const cls of classes) {
    const prefix = `${cls.name}.`;
    const hasMethods = declarations.owns.some((d: any) =>
      d.kind === 'method' && d.name.startsWith(prefix)
    );
    if (!hasMethods) {
      deviations.push({
        field: `owns`,
        issue: `class '${cls.name}' registered without className.methodName entries`,
        sop: `Register methods as ${cls.name}.methodName (e.g. ${cls.name}.constructor, ${cls.name}.process)`,
      });
    }
  }

  // Check 2 & 3: Function/method without params or return_type
  for (let i = 0; i < declarations.owns.length; i++) {
    const decl = declarations.owns[i];
    if (decl.kind === 'function' || decl.kind === 'method') {
      if (!decl.params || !Array.isArray(decl.params) || decl.params.length === 0) {
        deviations.push({
          field: `owns[${i}]`,
          issue: `${decl.kind} '${decl.name}' missing params`,
          sop: 'Add params array with name + type for each parameter',
        });
      }
      if (!decl.return_type) {
        deviations.push({
          field: `owns[${i}]`,
          issue: `${decl.kind} '${decl.name}' missing return_type`,
          sop: 'Add return_type string (e.g. "void", "Promise<string>")',
        });
      }
    }
  }

  return deviations;
}
