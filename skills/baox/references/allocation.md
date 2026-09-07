# Allocating a combined transport invoice across segments

Reached from `baox` step 8, when the kernel returns the `allocation_required` hard block: one transport
invoice covers several segments, and its face carries a single total.

> `baox` here is the kernel entry point, as in `SKILL.md`:
> `node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs"`.


**Every segment's 价税合计 comes from the user.** You do not compute it, average it, split it by ratio, by
distance, or by duration, and you do not lift the numbers off the itinerary and call them settled. The
itinerary is reference material; its amounts are not the invoice's legal amounts.

```bash
baox allocate --dir "<材料目录>"
```

This opens a local page listing the itinerary's own rows (date, city, origin and destination, amount) as
**prefilled candidates**, each marked with where it came from. The user checks them row by row, edits, and
submits. The page shows the running difference between the segment sum and the invoice's 价税合计 live, and
**one cent apart is rejected** — the kernel checks again on receipt and returns the whole allocation if it
does not balance.

Submitting is the consent event. Nothing the user says in chat allocates anything.

Once the allocation is accepted, rerun `events`; only then does the invoice split into several expense
events. The kernel divides each segment's 价税合计 into net and tax at the invoice's own rate and checks all
three balance. When the cents do not divide evenly the remainder lands on the segment with the largest
价税合计, and the output says so in `residue` — if the user asks where that cent went, tell them.

An allocation is bound to the invoice's content hash. Replace the invoice file and the allocation is void
(`allocation_stale`) and has to be filled in again.

## Done when

`events` runs without `allocation_required`, and each segment's amount traces back to a user submission
rather than to any calculation of yours.
