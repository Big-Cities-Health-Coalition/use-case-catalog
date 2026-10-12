# Applying an edit request

An edit request is an issue opened from the **Suggest an edit** link on an entry page. It
arrives labelled `content:edit-request`, from the form in
`.github/ISSUE_TEMPLATE/edit-entry.yml`. Nothing applies it automatically. A maintainer
turns it into a pull request, or assigns it to a coding agent that does, and a person
merges it. Which agent is up to whoever runs the site (any agent that can read an issue
and open a pull request will do), or none at all.

This page is the recipe for whoever makes the edit, person or agent. Follow it literally.

## What the issue holds

| Heading in the issue | What it is |
|---|---|
| `Entry slug` | The entry's folder name, filled in from the link. |
| `How are you connected to this entry?` | `I submitted this entry`, `I work on this project or at the organization behind it`, or `Someone else (a reader or partner)`. |
| `What should change?` | The request, in the requester's own words. |
| `Your name (optional)`, `Your email (optional)` | For follow-up questions only. They are not entry content. |

The automation has already replied on the issue with its number and a `/status/` link,
and marked it `status:received`. If the slug matched no entry, that reply asked for the
page address, so check the comments for it.

## The recipe

1. **Read the issue**: the slug, the relationship, the requested change, and every
   comment. The requester may have corrected the slug or added detail there.
2. **Open `<entry path>/<slug>/index.md`.** `<entry path>` is `entry.path` in
   `_data/schema.yml` (`catalog` unless the site changed it). If there is no such folder,
   work out the entry from a page address in the comments. If you still cannot tell
   which entry is meant, stop and ask on the issue.
3. **Change only what the request asks.**
   - Field names, types and allowed values come from `_data/schema.yml`. For a `select`
     or `multiselect` field, use only values from that field's `options`. If the request
     wants a value that is not an option, do not add one: leave the field and say so in
     the pull request.
   - Never invent facts that are not in the request: no guessed dates, figures, names,
     addresses or links. If part of the request is vague, make only the part that is
     clear and list the rest as uncertain.
   - Leave `slug`, `published` and every field the request does not mention as they
     are. Do not set `updated:` (the deploy stamps it) or `verified:` (that records a
     maintainer's check with the entry's contact).
4. **Run `npm run validate`** and fix what it reports. If you cannot run it, say so in
   the pull request; **Validate Content** runs on the pull request either way.
5. **Open a pull request** titled `Edit: <entry title>`, labelled `content:edit-request`.
   Its body says `Closes #N` (the issue number) on a line of its own, then lists each
   change (field, old value, new value) and anything uncertain or left undone.
6. **Flag what needs confirming.** If the relationship is `Someone else (a reader or
   partner)`, or the change is substantive (contact details, claims about what the
   project does or achieved, costs, anything touching data sensitivity or review
   status), add a line to the pull request asking the maintainer to confirm it with the
   entry's contact before merging.
7. **Leave the merge to a human.** Do not merge, approve your own pull request, or close
   the issue.

## What the requester sees

The `content:edit-request` label on the pull request ties it to the issue, the same way
the automation's own drafts are tied to theirs
([What the submitter is told](admin-guide.md#what-the-submitter-is-told)). Open it from a
branch of this repository: a pull request from a fork is never allowed to change an
issue's status.

- **Merged**: the issue closes and moves to `status:published`.
- **Closed without merging**: the requester gets the decline comment, which points at
  your reason on the pull request, and the issue is closed as not planned. Close one
  pull request while another labelled one for the same issue is still open, and it is
  treated as housekeeping instead.
- **Declined without a pull request**: reply on the issue with the reason, swap
  `status:received` for `status:declined`, and close it as not planned. Nothing
  automatic runs when an issue is closed.

A pull request without the label still closes the issue when it merges, and the deploy
still marks it published, but closing it unmerged tells the requester nothing.
