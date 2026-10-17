# Closure Spec/correctness review

Base: `bb5601fd8d38817a036355304992b42a5cefb400`.
Frozen head: `c42a80e949028a4fdf024f0e8b27bedbe07a941b`.
Reviewed the complete three-dot diff in `/tmp/reimburse-dining-qa/fix` against the reconciled `/tmp/reimburse-dining-qa/design.md`, the two previous Spec reviews, and `/tmp/reimburse-dining-qa/split-fix-reconciliation.md`. HEAD matched the frozen commit and the working tree was clean at inspection.

Verdict: pass for the reconciled #370 scope. Zero unresolved concrete Spec/correctness findings.

The prior P1 is closed. `labelledAmount` now validates the complete contiguous prefix before a candidate label, including fields split across label, delimiter, digits, identifier segments, and multiple complete fields. A split `桌号:` plus `8` therefore preserves `实收:530.00` ahead of `合计:600.00`. The same boundary applies to every occurrence, so unreadable or conflicting duplicates remain present and block a paid candidate. Paid evidence excludes preceding table-field observations.

The conservative scalar restriction is explicit in the reconciliation. Arbitrary text does not establish a preceding-field boundary. The negative cases cover incomplete merchant/remark fields, textual merchant values, and complete fields followed by `累计` under different observation splits. This does not change global row/span geometry. Paid groups retain their order; a present unreadable or ambiguous group prevents lower-priority fallback. Separate aligned money blocks remain ambiguous even when their values agree.

The parent-class mapping remains anchored to the supported dining description. Whole-page orientation selects text and boxes from the same rotated read, uses that read's height, and releases both temporary Mats through `finally`. Upright detection retains the existing boxes and local crop correction. Hotel exclusions and pairing owners are unchanged. Goldens/presets change parser-version metadata only. The fourth-photo negative expectation matches the explicit #371 deferral.

Inspected execution evidence includes the 9-failure/60-pass RED log at `446ef27`, the 649-test GREEN log at `67d333fa1b169d71a95cf8118b0c81ca4f644461`, and the independent reproduction reporting expected and actual `530.00`. The final commit only removes a comment and renames the scalar-boundary constant.

This was a read-only source/evidence review. No tests, OCR, browser actions, source edits, or additional agents ran. Root owns current full-gate, private-original and browser verification; this verdict does not certify those runs or close #371.
