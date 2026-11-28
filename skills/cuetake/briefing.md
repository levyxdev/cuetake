# Agreeing a Brief

A Brief is the plan for a demo agreed with the user before any Scenario is written: who it is for, where it will be shown, the outcomes it proves and the Takes they split into. You reach it by interviewing the user in rounds, then confirming it with them.

## 1. Look up the facts

Facts are yours to find; the user only makes decisions. Before the first round, learn what your recommendations rest on:

- the page with the available browser tool, or the App with `cuetake tree`: what it shows, where the story's controls are, whether it needs login;
- `doctor`, and any setup it asks for;
- the Auth profiles already saved (the names in `~/.local/share/cuetake/auth/`, never their contents) and the Looks in `look list`.

## 2. Interview in rounds

The questions form a tree: each answer opens the questions below it.

1. **Outcomes.** What should the viewer remember? Each outcome is one Take of 15 to 45 seconds ([directing.md](directing.md), Story), so a video of about 2 minutes is 3 to 5 Takes. Each Take delivers its own Final; tell the user a longer video arrives as several files, in order.
2. **Audience and destination.** Who watches, and where: a website, a social feed, a talk. This sets each Take's length, the output size and shape ([styling.md](styling.md), `output`), and the language.
3. **Narration.** Whether the demo is voiced, in which language, with which speech tool, and whether Subtitles are drawn ([narration.md](narration.md)).
4. **Accounts.** Whether a real account appears: which Auth profile ([authentication.md](authentication.md)), and which of its data to mask.
5. **Example data.** What the page must already hold when the demo starts, loaded in `prepare`.
6. **Look.** A saved Look, or styling together after the first Take ([SKILL.md](SKILL.md), Styling with the user).

The **frontier** is every question whose earlier answers are settled. Each round asks the whole frontier and waits for the answers; a question that depends on one still open in the round waits for the next. Then recompute the frontier from the answers and ask again.

Number each question and end it with your recommended answer, worded so that "yes" accepts it. Speak the user's language, not CueTake's: "three parts of about 30 seconds each", "blur the email addresses", "a dark window over your brand color".

```
❓ **Q1** - **What the video proves**: The viewer should come away knowing two things: how to invite a teammate, and where the weekly report is. That is two parts of about 30 seconds each, delivered as two videos in order.

➡️ Yes: two parts, invite first, then the report.
```

## 3. Confirm the Brief

The Brief is done when every question in the tree has an answer the user gave or accepted, and nothing is assumed. Summarise it in one paragraph: the audience and where it will be shown, then each Take in order with its outcome, length and beats, the Narration and the Look. Write a Scenario only after the user says yes to it.

## 4. Keep it with the Scenarios

The Brief lives on in the files it shapes:

- a comment at the top of each Scenario: the audience, where it will be shown, and the Take's outcome;
- the Lines in `narration.json`;
- the styling in a Look.

Name the Scenarios of one Brief with a shared prefix and their order: `launch-1-invite.mjs`, `launch-2-report.mjs`.
