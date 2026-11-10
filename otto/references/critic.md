# Critic review (proposed, not wired into the toolkit yet)

A second agent with fresh context reviews the work twice, the way a reviewer or tester would, because it did not write the storyboard:

1. **Script critic**: after the dry run, before anything is recorded. Cheap, and it catches most problems: what the video will show, say and highlight.
2. **Video critic**: after record, render and lint. It replaces the author looking at their own contact sheets, and judges only what the recording itself shows.

The automatic lint (`review.ts`) still runs after every render. The aim is no human gate: the critics are what make the videos trustworthy, and when the video critic approves, the video goes to its audience automatically. If a critic still says `revise` after 3 rounds, nothing is published and the open findings are reported, like a failing check.

## Script critic

**Gets:** the story (from the issue tracker or the story file), the diff summary (`git diff <base>...HEAD --stat` plus `changed-ui.ts` output), `videos/<KEY>/storyboard.ts`, and the dry run's output and `work/narration.json`.

**Judges:**
1. **Each acceptance criterion gets a chapter that proves it.** The steps make the criterion happen, and the `verify()` targets the element and state that prove it (with `contains` where the text matters). A verify that proves something else is a blocker.
2. **Changed UI is pointed out.** Every element in `story.changedUi`, and anything the diff adds that a viewer must notice, gets an `annotate` with a title a non-developer understands. NEW/CHANGED badges are right; `previously` is used for changed behaviour.
3. **Test data shows the change.** The data starts in the state the story is about (e.g. a task without the new field set). On a shared database, `setup` creates it under a unique name and there is no `reset`. A storyboard that states or checks a fact about data it didn't create ("all 48 customers", "7 of 48", the first row of a list) would break when someone else adds a row: that's a major finding.
4. **Narration reads well aloud:** in the story's language, one idea per line, leading the action rather than describing what already happened, no jargon or selectors. Finnish is natural spoken Finnish, and every number the voice says is written in words in the right case via `{written|spoken}` (`{12|kahdentoista} laatikon lähetys`, not digits); codes have spoken forms. English UI labels stay as on screen, never Finnicized, and stand apart from Finnish endings in the spoken form (`{Customs-vaihe|uusi vaihe, Customs,}`), because the voice gives an English word with a Finnish ending a Finnish pronunciation. Test data is never presented as real ("a real customer", "oikea asiakas"); naming test customers is fine. A wrong case, a Finnicized label or test data called real is a major finding.
5. **Focus and length:** steps unrelated to the story are in `setup` or `offCamera`; about 20–40 s per criterion (estimate from the narration lines).
6. **Predictable screen problems:** annotations on elements larger than the screen, a click right after a callout placed where it would cover the target, a long narration line over a fast sequence of actions.

## Video critic

**Gets:** the story, `storyboard.ts`, and from `videos/<KEY>/`: `review/review.md` (lint findings and the keyframe list with times), `review/sheet-*.jpg` (and `review/frame-NNN.jpg` for details), `captions.vtt` (narration with times), `chapters.md`, and the script critic's last verdict.

**Judges** only what the recording shows. Script-level points are already settled, unless the recording proves the script wrong.
1. **The proof is on screen:** each verify callout sits on the element that proves the criterion, in the promised state.
2. **Narration matches the screen at its time** (compare `captions.vtt` times with keyframe times).
3. **Readable and followable:** every callout stays long enough to read at normal speed; callouts don't cover what is explained or clicked next; captions don't hide the action; nothing important happens off screen; no unintended error states, empty pages or spinners.

## Both critics

Don't report taste (colours, voice choice), toolkit limits the author cannot change, or anything the lint already lists. Read only: never run the app, record, or edit files.

Return only this JSON:

```json
{
  "verdict": "approve" | "revise",
  "summary": "One or two sentences on what the video shows and how well; published with an approved video.",
  "findings": [
    {
      "severity": "blocker" | "major" | "minor",
      "at": "1:12 or step 14",
      "where": "AC2 / verify [data-testid=...]",
      "problem": "What a viewer would see or misunderstand.",
      "fix": "A concrete change to the storyboard (or test data)."
    }
  ]
}
```

- `revise` when there is any blocker or major finding; `approve` otherwise (minor findings may remain).
- At most 8 findings, most severe first, each pointing to a step or a time with a fix the author can make.

## The loop

1. Author writes the storyboard; dry run passes.
2. Script critic reviews. On `revise`, the author fixes each blocker and major finding (or explains why not), dry-runs again, and the critic reviews again with its previous findings attached. Up to 3 rounds.
3. Author records; render runs the lint. Lint errors (exit code 2) go straight back to the author.
4. Video critic reviews. On `revise`, fix, record again, review again with the previous findings attached. Up to 3 rounds.
5. Video critic approves: publish to the audience: upload the video and comment with the chapters and the critic's summary.
6. Either critic still says `revise` after 3 rounds: publish nothing; report the open findings like a failing check (wherever the agent reports its results).
