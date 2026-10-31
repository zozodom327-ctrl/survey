# SurveyForPerfection

A tiny daily survey that runs on GitHub Pages. People answer one question per screen and finish with a results image they can paste into Discord.

No install, no backend, no build step: just `index.html`, `style.css`, `app.js` and `survey.json`.

## Deploy to GitHub Pages

1. Create a new **public** repository on GitHub (e.g. `daily-survey`).
2. Upload all the files in this folder (**Add file → Upload files**, drag them in, **Commit changes**).
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick `main` and `/ (root)`, then **Save**.
4. After a minute or two your survey is live at `https://<your-username>.github.io/daily-survey/`.

Share that link. It stays the same every day, even when the questions change.

## Editing the questions

On the survey page, press **Ctrl+E** (**Cmd+E** on a Mac) to open the editor. Press it again, or **Back to survey**, to close it.

On a phone with no keyboard, open the link with `#edit` on the end instead:

```
https://<your-username>.github.io/daily-survey/#edit
```

Respondents never see the editor unless they know the shortcut. Even then, they can only change their own browser's draft, not the live survey.

In the editor you can:

- **Add** Text, Yes / No or Duration questions, or a **Message**
- Edit the prompt, toggle **Required**, set **word limits** (blank = no limit), and turn the optional **reason box** on or off
- Give a reason box its own **label** (e.g. "What did you eat?"). A custom label shows above the box and on the results card; leave it blank for plain "Reason"
- Tick **Add description** to show extra help under a question while answering. Descriptions never appear on the results card
- Use **Messages** for instructions or reminders: a title and a description on their own screen. They don't count as questions. Tick **Show title on results card** to use the title as a section heading on the card
- **Reorder** with ↑ / ↓ (or drag the ⠿ handle on desktop), **Duplicate** or **Delete**
- **Try it**: run your draft as a survey to check it, without publishing anything

Your edits are kept as a draft in this browser, so a refresh won't lose them. The label at the top tells you when the draft differs from the live survey.

## Publishing your changes

A web page on GitHub Pages can't save files back to the repo by itself, so publishing takes two steps:

1. Press **Save** in the editor. It downloads a new `survey.json`.
2. On GitHub, open your repo → **Add file → Upload files** → drop in the new `survey.json` → **Commit changes**. It replaces the old one.

Changes go live in about a minute. Instead of Save, you can press **Copy JSON**, then open `survey.json` on GitHub, click the ✏️ pencil, select everything, paste, and commit.

Other buttons:

- **Import**: load a `survey.json` from your computer into the editor (e.g. to swap in a whole different survey)
- **Revert**: throw away the draft and reload the live `survey.json`

## Publishing straight from the editor (optional)

You can skip the download-and-upload step by giving the editor a GitHub token. It's kept only in the browser you paste it into.

1. Signed in to the GitHub account that owns this repo, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** (or open https://github.com/settings/personal-access-tokens/new).
2. **Repository access:** choose **Only select repositories** and pick this repo.
3. **Permissions:** add **Contents** and set it to **Read and write**. Nothing else is needed.
4. Pick an expiry, generate the token and copy it.
5. Open the editor (Ctrl+E), expand **Publish straight to GitHub**, check the account and repository names, paste the token and press **Connect**.

From then on, **Publish** commits `survey.json` to the repo for you and the live survey updates within a minute or two. If the file was changed on GitHub since you opened the editor (for example from another device), Publish warns you before replacing it.

To stop, press **Disconnect** in the same panel, and delete the token on GitHub if you won't use it again. Each device needs the token pasted in once.

## Testing locally

Browsers won't load `survey.json` from a page opened straight from disk (`file://`), so run a tiny local server in this folder:

```
python -m http.server
```

Then open http://localhost:8000 (press Ctrl+E there for the editor).

## The survey file

`survey.json` is plain JSON, so you can also edit it by hand. Question order is array order.

| Field | Applies to | Meaning |
| --- | --- | --- |
| `id` | all | Unique id (the editor makes these; never shown) |
| `type` | all | `text`, `yesno`, `duration` or `message` |
| `prompt` | questions | The question text |
| `required` | questions | `true` by default; `false` lets people leave it blank |
| `wordLimit` | text | Max words, or leave out for no limit |
| `reason.enabled` | yesno, duration | Show an optional reason box |
| `reason.wordLimit` | yesno, duration | Max words for the reason |
| `reason.label` | yesno, duration | Custom label for the reason box (optional) |
| `description` | text, yesno, duration | Help text shown under the prompt; not on the results card (optional) |
| `title` | message | The message's heading |
| `body` | message | The message text |
| `showTitle` | message | `true` shows the title as a section heading on the results card |

If the file has a mistake, the survey shows a message naming the problem (e.g. "Question 3 has no prompt") instead of a blank page.

## Notes

- **Copy image** works in current desktop Chrome, Edge and Safari. Where a browser blocks it (some Firefox and mobile versions), use **Download image** and attach the file in Discord, or **Copy as text**.
- Progress is saved in the browser after every answer. If someone closes the page mid-survey and comes back the same day, they're offered "Continue where you left off?". If the questions changed in the meantime, they start fresh.
- All dates and times use the respondent's own time zone and date format.
