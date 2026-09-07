# Reading image materials

Reached from `baox` step 5, when `classify` reports `image_awaiting_reading`, `reading_stale`, or
`reading_awaiting_confirmation`.

> `baox` here is the kernel entry point, as in `SKILL.md`:
> `node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs"`.


Images (PNG/JPG) carry no extractable text. The kernel does no OCR — **you read them**. This is the one
place in the whole system that needs your own capability, which is why the rules here are the strictest.

```bash
baox ocr-request --dir "<材料目录>"
```

`items` is the work order. Each entry gives `absPath`, `materialId`, and `contentHash`. Entries with
`alreadyRead` true need no rereading.

**Then open every pending item's `absPath` with the `Read` tool, one call per image.** The work order is not
the work; it only says which files to open. `Read` renders PNG and JPG as pictures you can actually look at,
so this step always happens — there is no version of this flow where you go from `ocr-request` straight to
telling the user something is wrong with their images.

**「我看不到图片」 is not one of the answers.** If you have not called `Read` on the file, you do not know
whether it can be read. Only a `Read` call that came back with an **error** licenses that report, and then
you quote the error verbatim and name the file. Never ask the user to re-export, re-check, or re-supply an
image you did not open, and never let a missing look turn into `unreadable` — `unreadable` is about fields
on an image **you are looking at**, never about not having looked.

## You are a **copyist** here, not a judge

Transcribe the characters you can see, and nothing else.

- **Unreadable is an answer** — for a field on an image you have opened and are looking at. Put the field
  name in the `unreadable` array. It is completely legitimate and
  nobody will push back on it. **Guessing a value is far worse than saying you cannot read it.**
- **Transcribe, never compute.** If 不含税金额 is not printed, it is absent — never derive it from
  价税合计 − 税额.
- **Transcribe, never infer.** The filename, the directory name, the other materials beside it, what the
  user said in chat, and your own knowledge of what such an invoice usually says are all off limits. What
  is not on the image is not there.
- **Transcribe, never reconcile.** The kernel checks 不含税 + 税额 = 价税合计 itself. **A failed check is a
  normal outcome, not your failure** — it means read again, or this image genuinely cannot be read.
  Adjusting a digit so the check passes is the worst thing that can happen in this design.
- The 20-digit invoice number goes digit by digit, watching `0/O`, `1/l/I`, `5/S`, `8/B`, `2/Z`. One digit
  in doubt sends the whole field to `unreadable`.
- If the image is not an invoice (an itinerary, a hotel folio, a payment slip, something else), record what
  it actually is in `docType`. Sitting in an invoice folder does not make it an invoice.

## Reporting

Copy `references/reading-schema.json` and edit it: one entry per material read.

- `docType` is one of `invoice | ride_itinerary | hotel_folio | payment_slip | other | unreadable`.
- Beyond the fields in the template, `sellerName`, `buyerName`, `itemName`, `city`, `travelDate`, `origin`,
  and `destination` are accepted **when you can actually see them on the image**.
- **Include a field only when you read a value for it.** Omit the whole key otherwise — an empty string is
  rejected by the kernel, and so is any key it does not recognise.
- Amounts are strings with two decimals.

```bash
baox ocr-submit --dir "<材料目录>" --file /tmp/baox-readings.json
```

The kernel rehashes the file (a mismatch means the image changed and the reading is void), checks the field
formats, and checks the amounts balance. On `verdict: "rejected"`, read the image again against `reasons`.
The digits stay as you read them.

## A reading is not a fact — the confirmation is

```bash
baox confirm-readings --dir "<材料目录>"
```

This opens a local page listing the fields for the user to check against the original, tick, and submit.
**Submitting is the consent event** that turns candidates into parsed values. 「对的」「没问题」 in chat does
not, and you cannot tick on the user's behalf. Whatever they leave unticked stays as an open item — that is
their judgement, and it stands.

## Done when

Every work-order item is either submitted and accepted, or listed in `unreadable` with a reason, **and** the
user has submitted the confirmation page. Then rerun `classify`: image materials now take part in role
triage, invoice identity, and duplicate detection exactly like PDFs.
