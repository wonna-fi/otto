# Writing the narration and annotations

The viewer has not seen the code, may not know the page, and watches once at normal speed. Write for that person.

## Narration

- **Say where we are, then what happens.** "This is the task list. We open the form for a new task." The narration leads the action by a beat; it never describes something that has already disappeared.
- **One idea per line**, 1–2 short sentences (under ~25 words). Long lines crowd the caption and run past the action.
- **Plain words.** Say "the new Delivery method field", not "the `#delivery-method` select". No test jargon ("assert", "selector", "DOM").
- **Explain why when it isn't obvious**: "The summary lists every row before sending, so mistakes are caught early."
- **Don't read the screen word for word.** The callouts carry the exact labels; the voice adds context.
- **Don't repeat the chapter.** `chapter()` already reads "Acceptance criterion 2. …" aloud (the AC text when it is 14 words or fewer, otherwise just the number while the banner shows the text; give an AC a `say` for a custom spoken version). The next line should move on: "Let's leave the title empty and try to save."
- **End each chapter on the result**, with a `verify()` callout: "Saving is blocked, and the form says why."
- **Numbers and codes: give the voice words, keep digits in the caption.** Write `{written|spoken}`: the caption shows the first part, the voice says the second. In English, digits are fine ("customer 1001"). In Finnish they are not: digits carry no case, so the voice reads them in the base form ("kaksitoista laatikon lähetys" ✗). Write every number the voice says in words, inflected for the sentence: `{12|kahdentoista} laatikon lähetys`, `Tavarat pakataan {35|kolmeenkymmeneenviiteen} laatikkoon`. Codes and abbreviations get a spoken form too: `{AB-104|aa bee sataneljä}`.
- **Test data is never "real".** Videos are recorded in a test environment. Naming the people and cases in the test data is fine ("This is Maija Meikäläinen's customer page"), but never present them as real customers, orders or cases ("a real customer", "an actual order", "oikea asiakas"). When the data needs a word, it is test data: "a test customer", "testiasiakas", "a test order".
- **Say only what holds for your own data.** On a shared database other people's rows come and go, so "It lists all 48 tasks" or "Now 7 of 48" can be wrong by the time anyone watches, and fails the run if you check it. Say what the change does ("Now only high-priority tasks are listed") and name the test data you created. Counts about your own record are fine ("Our new task is at the top"). Avoid putting numbers read at run time into narration: a line that differs from the dry run is synthesized during the recording, and in Finnish a number needs its case written out.
- **Title card**: key and the change in one sentence. **Outro**: one short line, e.g. "All three acceptance criteria are covered."

### Finnish

Write natural spoken Finnish, not translated English. Short sentences, active voice, "me" form for actions ("Avataan asiakkaan yhteystiedot." / "Valitaan toimitustavaksi rahti.") or neutral description ("Tullausvaihe näkyy vain, kun lähetys menee EU:n ulkopuolelle.").

**English UI labels in Finnish narration**: name them as they read on screen, never as a Finnish adaptation ("kustomsi" is not Finnish). Keep the English word on its own: the voice says "Painetaan Next" and "Send order" in English, but gives a word with a Finnish ending or compound a Finnish pronunciation ("Customs-vaihe" comes out as "kustomsivaihe"). Either put the label apart (`{Customs-vaihe|uusi vaihe, Customs,}`) or say the Finnish word for it ("tullausvaihe") and let the callout show the label. The listening check fails a line where an English word (one with c, q, w, x or z) is heard Finnicized.

| Instead of | Write |
|---|---|
| Lähetys lähtee 14. marraskuuta. | Lähetys lähtee {14.\|neljäntenätoista} marraskuuta. |
| Tavarat pakataan 35 laatikkoon. | Tavarat pakataan {35\|kolmeenkymmeneenviiteen} laatikkoon. |
| Korjataan määräksi 180 kappaletta. | Korjataan määräksi {180\|satakahdeksankymmentä} kappaletta. |
| Vaiheisiin tulee Customs-vaihe. | Vaiheisiin tulee {Customs-vaihe\|uusi vaihe, Customs,}. |
| "Tässä videossa näytämme, että toiminnallisuus toimii hyväksymiskriteerin mukaisesti." | "Yritetään tallentaa ilman otsikkoa." |
| "Klikkaamme nyt elementtiä, joka avaa dialogin." | "Avataan uusi tilaus." |

## Annotations

- **What to annotate**: every element in `changedUi`, the first time it appears; the place where the result shows (with `verify`). Not every click.
- **Title** = the element's name or the result in a few words ("Priority", "Title is now required"). **Text** = one line: what it does or the rule ("Low, Normal or High."). Skip text when the title says it all.
- **Badges**: NEW for new elements, CHANGED for changed behaviour or labels (add `previously`), REMOVED rarely (annotate where it used to be, or say it).
- **Spotlight** only for the one element the story is about; dimming everything for every callout gets tiring.
- **Several related elements**: annotate them in sequence (each replaces the previous), or together with `keep: true` and `number: 1, 2…` when the relationship matters.
- **verify titles** state the outcome the AC promises: "Only high-priority tasks", "Saved with priority High". Use `contains` to make the check strict.

## Pace and length

- About 20–40 s per acceptance criterion, 1–3 minutes total. If an AC needs more, it probably needs fewer words, not more seconds.
- `normal` pace suits most viewers. `calm` for stakeholder demos, `brisk` for reviewers who know the app.
- Let results breathe: every slip stays on screen for its reading time, counted from when it is in place, and review fails a video where one leaves too soon. That counts most at the end of a chapter, where the next banner clears the screen. After a save or a validation message, the `verify` callout holds for its reading time. Don't add `pause()` unless something animates.
