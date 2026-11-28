# Agreeing a Brief

You reach the Brief by interviewing the user in rounds, then confirming it with them.

## 1. Look up the facts

Facts are yours to find; the user only makes decisions. Before the first round, learn what your recommendations rest on:

- the page or App, inspected as [SKILL.md](SKILL.md) step 1 says: what it shows, where the story's controls are, whether it needs login;
- the Auth profiles already saved, by name only ([authentication.md](authentication.md)), and the Looks in `look list`.

## 2. Interview in rounds

The questions form a tree: each answer opens the questions below it.

1. **Outcomes.** What should the viewer remember, and in what order? How many there are sets the length, and when the story is better told as several Takes ([directing.md](directing.md), Story).
2. **Audience and destination.** Who watches, and where: a website, a social feed, a talk. This sets the length, the output size and shape ([styling.md](styling.md), `output`), and the language.
3. **Narration.** Whether the demo is voiced, in which language, with which speech tool, and whether Subtitles are drawn ([narration.md](narration.md)).
4. **Accounts.** Whether a real account appears: which Auth profile ([authentication.md](authentication.md)), and which of its data to mask.
5. **Example data.** What the page must already hold when the demo starts, loaded in `prepare`.
6. **Look.** A saved Look, or styling together after the first Take ([SKILL.md](SKILL.md), Styling with the user).

The **frontier** is every question whose earlier answers are settled. Each round asks the whole frontier and waits for the answers; a question that depends on one still open in the round waits for the next. Then recompute the frontier from the answers and ask again.

Number each question and end it with your recommended answer, worded so that "yes" accepts it. Speak the user's language, not CueTake's: "three parts of about 30 seconds each", "blur the email addresses", "a dark window over your brand color".

```
❓ **Q1** - **What the video proves**: The viewer should come away knowing two things: how to invite a teammate, and where the weekly report is. That is one continuous video of about a minute, inviting first, then opening the report.

➡️ Yes: one video, invite first, then the report.
```

## 3. Confirm the Brief

The Brief is done when every question in the tree has an answer the user gave or accepted, and nothing is assumed. Summarize every answer in one paragraph, starting with the audience and where it will be shown, then each outcome in order with its length and beats. Write a Scenario only after the user says yes to it.

## 4. Keep it in the files it shapes

The Brief lives on in the files it shapes:

- a comment at the top of the Scenario: the audience, where it will be shown, and the outcomes in order;
- the Lines in `narration.json`;
- the styling in a Look.
