import { eslintCompatPlugin } from "@oxlint/plugins";

import { noArrayFilterMapRule } from "./rules/no-array-filter-map.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.ts";

export default eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-array-filter-map": noArrayFilterMapRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-reflect-get": noReflectGetRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "require-readable-spacing": requireReadableSpacingRule
  }
});
